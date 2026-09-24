use crate::audiodecode;
use crate::settings::{validate_audio_format, with_settings};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample as CpalSample, SizedSample};
#[cfg(not(target_os = "windows"))]
use mp3lame_encoder::{Bitrate, FlushNoGap, MonoPcm as Mp3MonoPcm, Quality};
#[cfg(target_os = "windows")]
use shine_rs::{Mp3Encoder, Mp3EncoderConfig, StereoMode};

const LEVEL_THROTTLE_MS: u64 = 50;
const CAPTURE_TIMEOUT: Option<Duration> = Some(Duration::from_secs(2));

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingMeta {
    pub path: String,
    pub name: String,
    pub format: String,
    pub size: u64,
    pub duration_secs: Option<f64>,
    pub modified: u64,
    pub has_transcript: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingState {
    pub recording: bool,
    pub stopping: bool,
}

#[derive(Clone, Serialize)]
struct LevelEvent {
    level: f32,
}

struct WriterOutcome {
    frames: u64,
}

type WriterResult = Result<WriterOutcome, String>;

struct Recording {
    stream: cpal::Stream,
    chunk_tx: mpsc::Sender<Vec<f32>>,
    done_rx: mpsc::Receiver<WriterResult>,
    format: String,
    path: PathBuf,
    started_at: SystemTime,
    sample_rate: u32,
}

#[derive(Default)]
struct RecorderInner {
    recording: Option<Recording>,
    stopping: bool,
}

pub struct RecorderState(Mutex<RecorderInner>);

impl Default for RecorderState {
    fn default() -> Self {
        Self(Mutex::new(RecorderInner::default()))
    }
}

#[tauri::command(async)]
pub fn start_recording(app: tauri::AppHandle, format: Option<String>) -> Result<(), String> {
    let format = match format.as_deref() {
        Some(f) => f.trim().to_ascii_lowercase(),
        None => with_settings(&app, |s| s.audio_format.clone()),
    };
    validate_audio_format(&format)?;
    with_inner(&app, |inner| {
        if inner.stopping {
            return Err("a stop is already in progress".to_string());
        }
        if inner.recording.is_some() {
            return Err("a recording is already in progress".to_string());
        }
        Ok(())
    })?;
    let dir = with_settings(&app, |s| PathBuf::from(s.audio_dir.clone()));
    fs::create_dir_all(&dir).map_err(|e| format!("could not create recordings folder: {e}"))?;
    let path = next_recording_path(&dir, &format);

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(no_input_device_error)?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("could not read the microphone configuration: {e}"))?;
    let sample_rate = config.sample_rate();
    let stream_config = cpal::StreamConfig {
        channels: config.channels(),
        sample_rate: config.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };

    let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<f32>>();
    let (done_tx, done_rx) = mpsc::channel::<WriterResult>();
    let device_error = Arc::new(AtomicBool::new(false));

    let stream = capture_stream(
        &device,
        config.sample_format(),
        stream_config,
        chunk_tx.clone(),
        app.clone(),
        device_error.clone(),
    )?;
    if let Err(e) = stream.play() {
        drop(stream);
        drop(chunk_tx);
        let _ = fs::remove_file(&path);
        return Err(format!("could not start the microphone stream: {e}"));
    }

    let writer_path = path.clone();
    let writer_format = format.clone();
    std::thread::spawn(move || {
        let outcome = encode_stream(
            &writer_path,
            &writer_format,
            sample_rate,
            chunk_rx,
            device_error,
        );
        let _ = done_tx.send(outcome);
    });

    let mut slot = Some(Recording {
        stream,
        chunk_tx,
        done_rx,
        format,
        path: path.clone(),
        started_at: SystemTime::now(),
        sample_rate,
    });
    let started = with_inner(&app, |inner| {
        if inner.stopping {
            return Err("a stop is already in progress".to_string());
        }
        if inner.recording.is_some() {
            return Err("a recording is already in progress".to_string());
        }
        inner.recording = slot.take();
        Ok(())
    });
    match started {
        Ok(()) => {
            emit_recording_state(&app, true, false);
            Ok(())
        }
        Err(e) => {
            if let Some(recording) = slot.take() {
                drop(recording.stream);
                drop(recording.chunk_tx);
            }
            let _ = fs::remove_file(&path);
            Err(e)
        }
    }
}

#[tauri::command(async)]
pub fn stop_recording(app: tauri::AppHandle) -> Result<RecordingMeta, String> {
    let recording = begin_stopping(&app)?;
    let receiver = run_detached_finish(move || finish_stop(app, recording));
    receiver
        .recv()
        .map_err(|_| "recording could not be finalized".to_string())?
}

#[tauri::command(async)]
pub fn cancel_recording(app: tauri::AppHandle) -> Result<(), String> {
    let recording = begin_stopping(&app)?;
    let receiver = run_detached_finish(move || finish_cancel(app, recording));
    receiver
        .recv()
        .map_err(|_| "recording could not be discarded".to_string())?
}

#[tauri::command]
pub fn recording_state(app: tauri::AppHandle) -> RecordingState {
    with_inner(&app, |inner| RecordingState {
        recording: inner.recording.is_some(),
        stopping: inner.stopping,
    })
}

#[tauri::command(async)]
pub fn list_recordings(app: tauri::AppHandle) -> Vec<RecordingMeta> {
    let dir = with_settings(&app, |s| PathBuf::from(s.audio_dir.clone()));
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut recordings = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_allowed_extension(&path) {
            continue;
        }
        let format = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let duration_secs = audiodecode::probe_duration_secs(&path);
        recordings.push(build_meta(&path, &format, duration_secs));
    }
    recordings.sort_by(|a, b| b.modified.cmp(&a.modified));
    recordings
}

#[tauri::command(async)]
pub fn delete_recording(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target = confine_to_audio_dir(&app, &path)?;
    let in_progress = with_inner(&app, |inner| {
        inner
            .recording
            .as_ref()
            .and_then(|r| r.path.canonicalize().ok())
            .is_some_and(|p| p == target)
    });
    if in_progress {
        return Err("cannot delete the recording that is currently in progress".to_string());
    }
    fs::remove_file(&target).map_err(|e| format!("could not delete recording: {e}"))?;
    let _ = fs::remove_file(sidecar_path_for(&target));
    Ok(())
}

#[tauri::command(async)]
pub fn delete_all_recordings(app: tauri::AppHandle) -> Result<u32, String> {
    let dir = with_settings(&app, |s| PathBuf::from(s.audio_dir.clone()));
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(0),
    };
    let in_progress = with_inner(&app, |inner| {
        inner
            .recording
            .as_ref()
            .and_then(|r| r.path.canonicalize().ok())
    });
    let mut deleted = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_allowed_extension(&path) {
            continue;
        }
        if in_progress
            .as_ref()
            .is_some_and(|p| path.canonicalize().ok().as_ref() == Some(p))
        {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            let _ = fs::remove_file(sidecar_path_for(&path));
            deleted += 1;
        }
    }
    Ok(deleted)
}

#[tauri::command(async)]
pub fn read_recording(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let target = confine_to_audio_dir(&app, &path)?;
    let bytes = fs::read(&target).map_err(|e| format!("could not read recording: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn default_recordings_dir(app: tauri::AppHandle) -> String {
    crate::settings::with_settings(&app, |s| s.audio_dir.clone())
}

pub(crate) fn is_allowed_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("mp3") | Some("wav") | Some("flac") | Some("ogg") | Some("m4a") | Some("aac")
    )
}

pub(crate) fn is_path_within_dir(dir: &Path, path: &Path) -> bool {
    let canonical_dir = match dir.canonicalize() {
        Ok(dir) => dir,
        Err(_) => return false,
    };
    let canonical_path = match path.canonicalize() {
        Ok(path) => path,
        Err(_) => return false,
    };
    canonical_path.starts_with(canonical_dir)
}

pub(crate) fn confine_within(dir: &Path, path: &Path) -> Result<PathBuf, String> {
    if !is_allowed_extension(path) {
        return Err(
            "only audio recordings (mp3, wav, flac, ogg, m4a, aac) can be used here".to_string(),
        );
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| format!("recording not found: {}", path.display()))?;
    if !is_path_within_dir(dir, &canonical) {
        return Err("refusing to use a path outside the configured recordings folder".to_string());
    }
    Ok(canonical)
}

pub(crate) fn confine_to_audio_dir(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let dir = with_settings(app, |s| PathBuf::from(s.audio_dir.clone()));
    confine_within(&dir, Path::new(path))
}

pub(crate) fn sidecar_path_for(file: &Path) -> PathBuf {
    let stem = file
        .file_stem()
        .unwrap_or_else(|| file.file_name().unwrap_or_default());
    file.with_file_name(format!("{}.transcript.json", stem.to_string_lossy()))
}

pub(crate) fn f32_to_i16_pcm(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

fn no_input_device_error() -> String {
    #[cfg(target_os = "macos")]
    {
        "no audio input device — allow microphone access for this app in System Settings → Privacy & Security → Microphone".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        "no audio input device — check that a microphone is connected and enabled in Sound settings"
            .to_string()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "no audio input device — check that a microphone is connected and PulseAudio or PipeWire is running".to_string()
    }
}

fn spawn_capture_stream<T>(
    device: &cpal::Device,
    stream_config: cpal::StreamConfig,
    chunk_tx: mpsc::Sender<Vec<f32>>,
    app: AppHandle,
    device_error: Arc<AtomicBool>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Copy + Send + 'static,
    f32: FromSample<T>,
{
    let channels = stream_config.channels as usize;
    let throttle = Duration::from_millis(LEVEL_THROTTLE_MS);
    let mut last_emit = Instant::now()
        .checked_sub(throttle)
        .unwrap_or_else(Instant::now);
    device
        .build_input_stream::<T, _, _>(
            stream_config,
            move |data: &[T], _| {
                let mono = mixdown_to_mono(data, channels);
                if last_emit.elapsed() >= throttle {
                    last_emit = Instant::now();
                    let level = audiodecode::dbfs_to_level(f64::from(audiodecode::rms_level(&mono)));
                    let _ = app.emit("recording-level", LevelEvent { level });
                }
                let _ = chunk_tx.send(mono);
            },
            move |_| {
                device_error.store(true, Ordering::SeqCst);
            },
            CAPTURE_TIMEOUT,
        )
        .map_err(|e| format!("could not start the microphone capture: {e}"))
}

fn mixdown_to_mono<T: Copy>(data: &[T], channels: usize) -> Vec<f32>
where
    f32: CpalSample + FromSample<T>,
{
    if channels <= 1 {
        return data.iter().map(|s| f32::from_sample(*s)).collect();
    }
    data.chunks_exact(channels)
        .map(|frame| {
            frame
                .iter()
                .map(|s| f32::from_sample(*s))
                .sum::<f32>()
                / channels as f32
        })
        .collect()
}

fn capture_stream(
    device: &cpal::Device,
    sample_format: cpal::SampleFormat,
    stream_config: cpal::StreamConfig,
    chunk_tx: mpsc::Sender<Vec<f32>>,
    app: AppHandle,
    device_error: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    match sample_format {
        cpal::SampleFormat::F32 => {
            spawn_capture_stream::<f32>(device, stream_config, chunk_tx, app, device_error)
        }
        cpal::SampleFormat::I16 => {
            spawn_capture_stream::<i16>(device, stream_config, chunk_tx, app, device_error)
        }
        cpal::SampleFormat::U16 => {
            spawn_capture_stream::<u16>(device, stream_config, chunk_tx, app, device_error)
        }
        cpal::SampleFormat::I8 => {
            spawn_capture_stream::<i8>(device, stream_config, chunk_tx, app, device_error)
        }
        cpal::SampleFormat::U8 => {
            spawn_capture_stream::<u8>(device, stream_config, chunk_tx, app, device_error)
        }
        cpal::SampleFormat::I32 => {
            spawn_capture_stream::<i32>(device, stream_config, chunk_tx, app, device_error)
        }
        cpal::SampleFormat::U32 => {
            spawn_capture_stream::<u32>(device, stream_config, chunk_tx, app, device_error)
        }
        cpal::SampleFormat::F64 => {
            spawn_capture_stream::<f64>(device, stream_config, chunk_tx, app, device_error)
        }
        other => Err(format!("unsupported microphone sample format: {other:?}")),
    }
}

fn encode_stream(
    path: &Path,
    format: &str,
    sample_rate: u32,
    rx: mpsc::Receiver<Vec<f32>>,
    device_error: Arc<AtomicBool>,
) -> WriterResult {
    let frames = if format == "wav" {
        write_wav(path, sample_rate, &rx)
    } else {
        write_mp3(path, sample_rate, &rx)
    }?;
    if device_error.load(Ordering::SeqCst) {
        let _ = fs::remove_file(path);
        return Err(
            "the microphone stream failed during recording — the capture was discarded".to_string(),
        );
    }
    Ok(WriterOutcome { frames })
}

fn write_wav(path: &Path, sample_rate: u32, rx: &mpsc::Receiver<Vec<f32>>) -> Result<u64, String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let file = File::create(path).map_err(|e| format!("could not create recording: {e}"))?;
    let mut writer = hound::WavWriter::new(BufWriter::new(file), spec)
        .map_err(|e| format!("could not write the recording: {e}"))?;
    let mut frames = 0u64;
    for chunk in rx {
        for sample in &chunk {
            writer
                .write_sample(f32_to_i16_pcm(*sample))
                .map_err(|e| format!("could not write the recording: {e}"))?;
        }
        frames += chunk.len() as u64;
    }
    writer
        .finalize()
        .map_err(|e| format!("could not finalize the recording: {e}"))?;
    Ok(frames)
}

fn write_mp3(path: &Path, sample_rate: u32, rx: &mpsc::Receiver<Vec<f32>>) -> Result<u64, String> {
    #[cfg(target_os = "windows")]
    {
        write_mp3_shine(path, sample_rate, rx)
    }
    #[cfg(not(target_os = "windows"))]
    {
        write_mp3_lame(path, sample_rate, rx)
    }
}

#[cfg(target_os = "windows")]
fn write_mp3_shine(
    path: &Path,
    sample_rate: u32,
    rx: &mpsc::Receiver<Vec<f32>>,
) -> Result<u64, String> {
    let config = Mp3EncoderConfig::new()
        .sample_rate(sample_rate)
        .bitrate(192)
        .channels(1)
        .stereo_mode(StereoMode::Mono);
    let mut encoder = Mp3Encoder::new(config)
        .map_err(|e| format!("could not initialize the mp3 encoder: {e}"))?;
    let file = File::create(path).map_err(|e| format!("could not create recording: {e}"))?;
    let mut file = BufWriter::new(file);
    let mut frames = 0u64;
    for chunk in rx {
        let pcm: Vec<i16> = chunk.iter().map(|s| f32_to_i16_pcm(*s)).collect();
        let blocks = encoder
            .encode_interleaved(&pcm)
            .map_err(|e| format!("could not encode the recording: {e}"))?;
        for block in blocks {
            file.write_all(&block)
                .map_err(|e| format!("could not write the recording: {e}"))?;
        }
        frames += pcm.len() as u64;
    }
    let tail = encoder
        .finish()
        .map_err(|e| format!("could not finalize the recording: {e}"))?;
    file.write_all(&tail)
        .map_err(|e| format!("could not finalize the recording: {e}"))?;
    file.flush()
        .map_err(|e| format!("could not finalize the recording: {e}"))?;
    Ok(frames)
}

#[cfg(not(target_os = "windows"))]
fn write_mp3_lame(path: &Path, sample_rate: u32, rx: &mpsc::Receiver<Vec<f32>>) -> Result<u64, String> {
    let mut builder = mp3lame_encoder::Builder::new()
        .ok_or_else(|| "could not initialize the mp3 encoder".to_string())?;
    builder
        .set_sample_rate(sample_rate)
        .map_err(|e| format!("could not configure the mp3 encoder: {e}"))?;
    builder
        .set_num_channels(1)
        .map_err(|e| format!("could not configure the mp3 encoder: {e}"))?;
    builder
        .set_brate(Bitrate::Kbps192)
        .map_err(|e| format!("could not configure the mp3 encoder: {e}"))?;
    builder
        .set_quality(Quality::VeryNice)
        .map_err(|e| format!("could not configure the mp3 encoder: {e}"))?;
    let mut encoder = builder
        .build()
        .map_err(|e| format!("could not initialize the mp3 encoder: {e}"))?;
    let file = File::create(path).map_err(|e| format!("could not create recording: {e}"))?;
    let mut file = BufWriter::new(file);
    let mut frames = 0u64;
    let mut encoded = Vec::new();
    for chunk in rx {
        let pcm: Vec<i16> = chunk.iter().map(|s| f32_to_i16_pcm(*s)).collect();
        encoded.clear();
        encoded.reserve(mp3lame_encoder::max_required_buffer_size(pcm.len()));
        encoder
            .encode_to_vec(Mp3MonoPcm(&pcm), &mut encoded)
            .map_err(|e| format!("could not encode the recording: {e}"))?;
        file.write_all(&encoded)
            .map_err(|e| format!("could not write the recording: {e}"))?;
        frames += pcm.len() as u64;
    }
    encoded.clear();
    encoded.reserve(mp3lame_encoder::max_required_buffer_size(0));
    encoder
        .flush_to_vec::<FlushNoGap>(&mut encoded)
        .map_err(|e| format!("could not finalize the recording: {e}"))?;
    file.write_all(&encoded)
        .map_err(|e| format!("could not finalize the recording: {e}"))?;
    file.flush()
        .map_err(|e| format!("could not finalize the recording: {e}"))?;
    Ok(frames)
}

// Detached on purpose (v2 gotcha #3): in v2 the stop path held the recorder mutex
// across SIGTERM + the 5 s wait, so every polling command blocked behind it; the
// Recording is swapped out under a short lock and the result comes back over the
// channel instead, leaving `stopping: true` visible to `recording_state` meanwhile.
fn run_detached_finish<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> mpsc::Receiver<T> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(work());
    });
    receiver
}

fn with_inner<T>(app: &AppHandle, f: impl FnOnce(&mut RecorderInner) -> T) -> T {
    if app.try_state::<RecorderState>().is_none() {
        let _ = app.manage(RecorderState::default());
    }
    let state = app.state::<RecorderState>();
    let mut inner = state.0.lock().expect("recorder state lock poisoned");
    f(&mut inner)
}

fn begin_stopping(app: &AppHandle) -> Result<Recording, String> {
    let taken = with_inner(app, |inner| {
        if inner.stopping {
            return None;
        }
        let recording = inner.recording.take();
        inner.stopping = recording.is_some();
        recording
    });
    match taken {
        Some(recording) => {
            emit_recording_state(app, true, true);
            Ok(recording)
        }
        None => {
            if with_inner(app, |inner| inner.stopping) {
                Err("a stop is already in progress".to_string())
            } else {
                Err("not recording".to_string())
            }
        }
    }
}

fn emit_recording_state(app: &AppHandle, recording: bool, stopping: bool) {
    let _ = app.emit(
        "recording-state",
        RecordingState { recording, stopping },
    );
}

fn finish_stop(app: AppHandle, recording: Recording) -> Result<RecordingMeta, String> {
    let recorded_for = recording
        .started_at
        .elapsed()
        .ok()
        .map(|d| d.as_secs_f64())
        .filter(|d| d.is_finite());
    drop(recording.stream);
    drop(recording.chunk_tx);
    let result = recording
        .done_rx
        .recv()
        .unwrap_or_else(|_| Err("recording could not be finalized".to_string()));
    clear_stopping(&app);
    match result {
        Ok(written) => {
            let duration_secs = Some(written.frames as f64 / f64::from(recording.sample_rate))
                .filter(|d| d.is_finite() && *d > 0.0)
                .or(recorded_for);
            Ok(build_meta(
                &recording.path,
                &recording.format,
                duration_secs,
            ))
        }
        Err(e) => Err(e),
    }
}

fn finish_cancel(app: AppHandle, recording: Recording) -> Result<(), String> {
    drop(recording.stream);
    drop(recording.chunk_tx);
    let _ = recording.done_rx.recv();
    let _ = fs::remove_file(&recording.path);
    clear_stopping(&app);
    Ok(())
}

fn clear_stopping(app: &AppHandle) {
    with_inner(app, |inner| inner.stopping = false);
    emit_recording_state(app, false, false);
}

fn build_meta(path: &Path, format: &str, duration_secs: Option<f64>) -> RecordingMeta {
    let metadata = fs::metadata(path).ok();
    let size = metadata.as_ref().map_or(0, |m| m.len());
    let modified = metadata
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    let name = path.file_name().map_or_else(String::new, |n| {
        n.to_string_lossy().into_owned()
    });
    let has_transcript = sidecar_path_for(path).exists();
    RecordingMeta {
        path: path.to_string_lossy().into_owned(),
        name,
        format: format.to_string(),
        size,
        duration_secs,
        modified,
        has_transcript,
    }
}

fn next_recording_path(dir: &Path, format: &str) -> PathBuf {
    let mut ms = unix_millis_now();
    let mut path = dir.join(format!("recording-{ms}.{format}"));
    while path.exists() {
        ms += 1;
        path = dir.join(format!("recording-{ms}.{format}"));
    }
    path
}

fn unix_millis_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_accepts_recordable_and_importable_audio() {
        assert!(is_allowed_extension(Path::new("recording-1.mp3")));
        assert!(is_allowed_extension(Path::new("recording-1.wav")));
        assert!(is_allowed_extension(Path::new("recording-1.MP3")));
        assert!(is_allowed_extension(Path::new("/a/b/recording-1.Wav")));
        assert!(is_allowed_extension(Path::new("song.flac")));
        assert!(is_allowed_extension(Path::new("song.ogg")));
        assert!(is_allowed_extension(Path::new("voice.m4a")));
        assert!(is_allowed_extension(Path::new("voice.aac")));
        assert!(!is_allowed_extension(Path::new("notes.txt")));
        assert!(!is_allowed_extension(Path::new("recording-1")));
        assert!(!is_allowed_extension(Path::new(".mp3")));
        assert!(!is_allowed_extension(Path::new("recording-1.mp3.exe")));
    }

    #[test]
    fn path_confinement_rejects_siblings_and_traversal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inside = dir.path().join("recording-1.mp3");
        fs::write(&inside, b"x").expect("write inside");
        assert!(is_path_within_dir(dir.path(), &inside));

        let sibling =
            tempfile::tempdir_in(dir.path().parent().expect("tmp parent")).expect("sibling");
        let outside = sibling.path().join("secret.mp3");
        fs::write(&outside, b"x").expect("write outside");
        assert!(!is_path_within_dir(dir.path(), &outside));

        let traversal = dir
            .path()
            .join("..")
            .join(sibling.path().file_name().expect("sibling name"))
            .join("secret.mp3");
        assert!(!is_path_within_dir(dir.path(), &traversal));

        assert!(!is_path_within_dir(
            dir.path(),
            &dir.path().join("missing.mp3")
        ));
    }

    #[test]
    fn confine_within_accepts_audio_inside_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inside = dir.path().join("recording-1.mp3");
        fs::write(&inside, b"x").expect("write");
        let confined = confine_within(dir.path(), &inside).expect("confined");
        assert_eq!(confined, inside.canonicalize().expect("canonical"));
    }

    #[test]
    fn confine_within_rejects_non_audio_extension() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inside = dir.path().join("notes.txt");
        fs::write(&inside, b"x").expect("write");
        assert!(confine_within(dir.path(), &inside).is_err());
    }

    #[test]
    fn confine_within_rejects_traversal_and_missing() {
        let parent = tempfile::tempdir().expect("parent");
        let dir = parent.path().join("audio");
        fs::create_dir(&dir).expect("mkdir");
        let secret = parent.path().join("secret.mp3");
        fs::write(&secret, b"x").expect("write secret");
        assert!(confine_within(&dir, &dir.join("..").join("secret.mp3")).is_err());
        assert!(confine_within(&dir, &dir.join("missing.mp3")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn confine_within_rejects_symlink_escape() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("outside");
        let secret = outside.path().join("secret.mp3");
        fs::write(&secret, b"x").expect("write secret");
        let link = dir.path().join("link.mp3");
        std::os::unix::fs::symlink(&secret, &link).expect("symlink");
        assert!(confine_within(dir.path(), &link).is_err());
    }

    #[test]
    fn sidecar_path_sits_next_to_the_recording() {
        assert_eq!(
            sidecar_path_for(Path::new("/data/recording-1.mp3")),
            PathBuf::from("/data/recording-1.transcript.json")
        );
        assert_eq!(
            sidecar_path_for(Path::new("recording-2.wav")),
            PathBuf::from("recording-2.transcript.json")
        );
    }

    #[test]
    fn build_meta_reads_file_stats_and_sidecar() {
        let dir = tempfile::tempdir().expect("tempdir");
        let recording = dir.path().join("recording-7.mp3");
        fs::write(&recording, b"ab").expect("write");
        fs::write(sidecar_path_for(&recording), b"{}").expect("write sidecar");
        let meta = build_meta(&recording, "mp3", None);
        assert_eq!(meta.name, "recording-7.mp3");
        assert_eq!(meta.format, "mp3");
        assert_eq!(meta.size, 2);
        assert!(meta.modified > 0);
        assert!(meta.has_transcript);
        assert_eq!(meta.duration_secs, None);
    }

    #[test]
    fn meta_serializes_camel_case_fields() {
        let dir = tempfile::tempdir().expect("tempdir");
        let recording = dir.path().join("recording-8.mp3");
        fs::write(&recording, b"ab").expect("write");
        let meta = build_meta(&recording, "mp3", Some(1.25));
        let json = serde_json::to_value(&meta).expect("serialize meta");
        assert_eq!(json["durationSecs"], serde_json::json!(1.25));
        assert!(json.get("duration_secs").is_none());
        assert_eq!(json["hasTranscript"], serde_json::json!(false));
        assert_eq!(json["modified"], serde_json::json!(meta.modified));
        assert_eq!(json["size"], serde_json::json!(2));
        assert_eq!(json["name"], serde_json::json!("recording-8.mp3"));
        assert_eq!(json["format"], serde_json::json!("mp3"));
    }

    #[test]
    fn recording_paths_use_unix_ms_names_without_collisions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = next_recording_path(dir.path(), "mp3");
        let name = path
            .file_name()
            .expect("name")
            .to_string_lossy()
            .into_owned();
        assert!(name.starts_with("recording-") && name.ends_with(".mp3"));
        assert!(name != "recording-.mp3");
        fs::write(&path, b"").expect("write");
        let second = next_recording_path(dir.path(), "mp3");
        assert_ne!(path, second);
        assert_eq!(second.extension().and_then(|e| e.to_str()), Some("mp3"));
    }

    #[test]
    fn f32_samples_convert_to_i16_pcm_with_clamping() {
        assert_eq!(f32_to_i16_pcm(0.0), 0);
        assert_eq!(f32_to_i16_pcm(1.0), i16::MAX);
        assert_eq!(f32_to_i16_pcm(-1.0), -i16::MAX);
        assert_eq!(f32_to_i16_pcm(-2.0), -i16::MAX);
        assert_eq!(f32_to_i16_pcm(0.5), (i16::MAX as f32 * 0.5) as i16);
    }

    #[test]
    fn stereo_capture_mixes_down_to_mono() {
        let data: Vec<f32> = vec![0.0, 1.0, -1.0, 1.0, 0.5, 0.5];
        let mono = mixdown_to_mono(&data, 2);
        assert_eq!(mono, vec![0.5, 0.0, 0.5]);
    }

    #[test]
    fn mono_capture_converts_i16_samples_to_unit_floats() {
        let data: Vec<i16> = vec![0, 16384, -16384];
        let mono = mixdown_to_mono(&data, 1);
        assert!(mono.iter().zip(&[0.0, 0.5, -0.5]).all(|(a, b)| (a - b).abs() < 0.01));
    }

    #[test]
    fn wav_writer_roundtrips_samples() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("rec.wav");
        let (tx, rx) = mpsc::channel::<Vec<f32>>();
        tx.send(vec![0.0, 0.5, -0.5]).expect("send");
        drop(tx);
        write_wav(&path, 44100, &rx).expect("wav written");
        let mut reader = hound::WavReader::open(&path).expect("wav readable");
        assert_eq!(reader.spec().sample_rate, 44100);
        assert_eq!(reader.spec().channels, 1);
        let samples: Vec<i16> = reader
            .samples::<i16>()
            .map(|s| s.expect("sample"))
            .collect();
        assert_eq!(samples[0], 0);
        assert_eq!(samples[1], f32_to_i16_pcm(0.5));
        assert_eq!(samples[2], f32_to_i16_pcm(-0.5));
    }

    #[test]
    fn mp3_writer_encodes_chunks_without_a_zero_capacity_buffer() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("rec.mp3");
        let (tx, rx) = mpsc::channel::<Vec<f32>>();
        for _ in 0..3 {
            let samples: Vec<f32> = (0..1000).map(|i| (i as f32 / 1000.0) * 0.5).collect();
            tx.send(samples).expect("send");
        }
        drop(tx);
        let frames = write_mp3(&path, 44_100, &rx).expect("mp3 written");
        assert_eq!(frames, 3000);
        assert!(fs::metadata(&path).expect("metadata").len() > 100);
    }
}
