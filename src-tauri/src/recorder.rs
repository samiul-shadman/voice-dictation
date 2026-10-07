use crate::audiodecode;
use crate::settings::{validate_audio_format, with_settings};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
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
const ENCODER_FINALIZE_TIMEOUT: Duration = Duration::from_secs(20);
const COMMAND_FINALIZE_TIMEOUT: Duration = Duration::from_secs(30);

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDeviceInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RawDevice {
    host: cpal::HostId,
    // ALSA reports the pcm name here; other backends report something else.
    driver: String,
    info: InputDeviceInfo,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PcmKind {
    Hardware { card: u32, dev: u32 },
    Routing,
    Plugin,
}

// ALSA exposes one physical capture endpoint under a dozen names — hw:,
// plughw:, sysdefault:, front:, surround*, dmix:, usbstream: — and every DSP
// plugin (null, speex, upmix, …) shows up as its own "device" because plugin
// hints carry no IOID and so default to Duplex. Only the hw:/plughw: forms name
// real hardware, so everything else is noise in a picker.
const HARDWARE_PCM_PREFIXES: [&str; 2] = ["hw", "plughw"];
const ROUTING_PCMS: [&str; 4] = ["default", "pulse", "pipewire", "jack"];

fn classify_pcm(driver: &str, cards: &CardIndex) -> PcmKind {
    if ROUTING_PCMS.contains(&driver) {
        return PcmKind::Routing;
    }
    let Some((prefix, rest)) = driver.split_once(':') else {
        return PcmKind::Plugin;
    };
    if !HARDWARE_PCM_PREFIXES.contains(&prefix) {
        return PcmKind::Plugin;
    }
    let mut card = None;
    let mut dev = None;
    for part in rest.split(',') {
        if let Some(value) = part.strip_prefix("CARD=") {
            card = Some(value);
        } else if let Some(value) = part.strip_prefix("DEV=") {
            dev = value.parse::<u32>().ok();
        }
    }
    match (card.and_then(|c| cards.index_for(c)), dev) {
        (Some(index), Some(dev)) => PcmKind::Hardware { card: index, dev },
        _ => PcmKind::Plugin,
    }
}

// cpal reports each physical endpoint twice over: once keyed by the card's
// driver id ("CARD=Generic") and once by its numeric index ("CARD=1"). Both
// spellings open the same PCM, so the dedup key has to be the index.
#[cfg(target_os = "linux")]
#[derive(Default)]
struct CardIndex {
    by_id: HashMap<String, u32>,
}

#[cfg(target_os = "linux")]
impl CardIndex {
    fn build() -> Self {
        let mut by_id = HashMap::new();
        for index in 0..64 {
            if let Ok(id) = fs::read_to_string(format!("/proc/asound/card{index}/id")) {
                by_id.insert(id.trim().to_string(), index);
            }
        }
        Self { by_id }
    }

    // An unknown id resolves to nothing rather than to a guess: a wrong index
    // would merge two genuinely different microphones into one row.
    fn index_for(&self, id: &str) -> Option<u32> {
        id.parse::<u32>()
            .ok()
            .or_else(|| self.by_id.get(id).copied())
    }
}

// The kernel is the only card registry available without pulling in libasound
// directly, and it is the same source cpal's own physical probing reads.
#[cfg(not(target_os = "linux"))]
#[derive(Default)]
struct CardIndex;

#[cfg(not(target_os = "linux"))]
impl CardIndex {
    fn build() -> Self {
        Self
    }

    fn index_for(&self, _id: &str) -> Option<u32> {
        None
    }
}

// plughw: is the same endpoint with sample-format conversion inserted, so a
// stream negotiated at the device's "best" config actually opens; a bare hw: can
// fail UnsupportedConfig on exactly that config.
fn hardware_prefix_rank(driver: &str) -> u8 {
    match driver.split_once(':').map(|(prefix, _)| prefix) {
        Some("plughw") => 0,
        _ => 1,
    }
}

fn collapse_hardware(devices: Vec<RawDevice>) -> Vec<InputDeviceInfo> {
    collapse_hardware_with(devices, &CardIndex::build())
}

// The card index is injected so the dedup logic is testable against a fixed
// fixture instead of whatever cards the host machine happens to have.
fn collapse_hardware_with(devices: Vec<RawDevice>, cards: &CardIndex) -> Vec<InputDeviceInfo> {
    let mut hardware: Vec<((u32, u32), u8, InputDeviceInfo)> = Vec::new();
    let mut other: Vec<InputDeviceInfo> = Vec::new();
    for raw in devices {
        // Only ALSA re-exports one endpoint under a dozen alias names and
        // reports DSP plugins as devices. CoreAudio and WASAPI enumerate real
        // devices already, and their driver strings would be discarded as
        // unrecognised — so those pass through untouched.
        if raw.host != cpal::HostId::Alsa {
            other.push(raw.info);
            continue;
        }
        let PcmKind::Hardware { card, dev } = classify_pcm(&raw.driver, cards) else {
            continue;
        };
        let key = (card, dev);
        let rank = hardware_prefix_rank(&raw.driver);
        match hardware.iter_mut().find(|(k, _, _)| *k == key) {
            Some((_, current_rank, current)) if rank < *current_rank => {
                *current_rank = rank;
                *current = raw.info;
            }
            Some(_) => {}
            None => hardware.push((key, rank, raw.info)),
        }
    }
    let mut out: Vec<InputDeviceInfo> = hardware
        .into_iter()
        .map(|(_, _, info)| info)
        .chain(other)
        .collect();
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    out
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
    let (format, input_device) = match format.as_deref() {
        Some(f) => (
            f.trim().to_ascii_lowercase(),
            with_settings(&app, |s| s.input_device.clone()),
        ),
        None => with_settings(&app, |s| (s.audio_format.clone(), s.input_device.clone())),
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

    // Device before path: a missing or unusable microphone must not leave a
    // reserved zero-byte recording behind.
    let host = cpal::default_host();
    let device = resolve_input_device(&host, &input_device)?;
    let config = device
        .default_input_config()
        .map_err(|e| microphone_open_error("could not read the microphone configuration", e))?;
    let sample_rate = config.sample_rate();
    let stream_config = cpal::StreamConfig {
        channels: config.channels(),
        sample_rate: config.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };

    let dir = with_settings(&app, |s| PathBuf::from(s.audio_dir.clone()));
    fs::create_dir_all(&dir).map_err(|e| format!("could not create recordings folder: {e}"))?;
    let path = reserve_recording_path(&dir, &format)?;

    let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<f32>>();
    let (done_tx, done_rx) = mpsc::channel::<WriterResult>();
    let device_error = Arc::new(AtomicBool::new(false));

    let stream = match capture_stream(
        &device,
        config.sample_format(),
        stream_config,
        chunk_tx.clone(),
        app.clone(),
        device_error.clone(),
    ) {
        Ok(stream) => stream,
        Err(e) => {
            let _ = fs::remove_file(&path);
            return Err(e);
        }
    };
    if let Err(e) = stream.play() {
        drop(stream);
        drop(chunk_tx);
        let _ = fs::remove_file(&path);
        return Err(microphone_open_error(
            "could not start the microphone stream",
            e,
        ));
    }

    // After play() so the mic is already live and the load overlaps the user
    // speaking rather than competing with device init. Idempotent — a launch
    // prewarm already in flight makes this a cache hit.
    crate::transcriber::prewarm(&app);

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
                let _ = recording.done_rx.recv_timeout(ENCODER_FINALIZE_TIMEOUT);
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
    match receiver.recv_timeout(COMMAND_FINALIZE_TIMEOUT) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => {
            Err("the recording took too long to finalize — try again".to_string())
        }
        Err(RecvTimeoutError::Disconnected) => {
            Err("recording could not be finalized".to_string())
        }
    }
}

#[tauri::command(async)]
pub fn cancel_recording(app: tauri::AppHandle) -> Result<(), String> {
    let recording = begin_stopping(&app)?;
    let receiver = run_detached_finish(move || finish_cancel(app, recording));
    match receiver.recv_timeout(COMMAND_FINALIZE_TIMEOUT) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => {
            Err("the recording took too long to discard — try again".to_string())
        }
        Err(RecvTimeoutError::Disconnected) => Err("recording could not be discarded".to_string()),
    }
}

#[tauri::command]
pub fn recording_state(app: tauri::AppHandle) -> RecordingState {
    with_inner(&app, |inner| RecordingState {
        recording: inner.recording.is_some(),
        stopping: inner.stopping,
    })
}

#[tauri::command(async)]
pub fn list_input_devices() -> Result<Vec<InputDeviceInfo>, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|e| format!("could not list the microphones: {e}"))?;
    let all: Vec<RawDevice> = devices.filter_map(describe_device).collect();
    Ok(collapse_hardware(all))
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

fn missing_device_error(id: &str) -> String {
    format!(
        "the selected microphone ({id}) is not connected — reconnect it, or pick another under Settings → Recording"
    )
}

fn unparsable_device_id_error(id: &str) -> String {
    format!(
        "the saved microphone id ({id}) is not a valid device identifier — pick a microphone again under Settings → Recording"
    )
}

fn device_busy_error() -> String {
    "the selected microphone is in use by another application — often the sound server — so it cannot be opened directly; choose System default under Settings → Recording".to_string()
}

// A sound server holding a hardware endpoint is the common case for a specific
// ALSA device, and its raw errno ("Device or resource busy") explains nothing to
// a user who only knows the app has a microphone picker.
fn microphone_open_error(context: &str, e: cpal::Error) -> String {
    if e.kind() == cpal::ErrorKind::DeviceBusy {
        return device_busy_error();
    }
    format!("{context}: {e}")
}

// An empty saved id means "follow whatever the OS picks", so a saved device that
// vanishes never strands the user on a stale identifier.
fn resolve_input_device(host: &cpal::Host, saved_id: &str) -> Result<cpal::Device, String> {
    let saved_id = saved_id.trim();
    if saved_id.is_empty() {
        return host
            .default_input_device()
            .ok_or_else(no_input_device_error);
    }
    let parsed =
        cpal::DeviceId::from_str(saved_id).map_err(|_| unparsable_device_id_error(saved_id))?;
    host.device_by_id(&parsed)
        .ok_or_else(|| missing_device_error(saved_id))
}

// Deliberately does not call supported_input_configs(): on ALSA that opens the
// PCM, which is slow and reports EBUSY for hardware the sound server already
// holds. The description is cached by the backend at enumeration time.
fn describe_device(device: cpal::Device) -> Option<RawDevice> {
    let device_id = device.id().ok()?;
    let host = device_id.host();
    let id = device_id.to_string();
    let description = device.description().ok();
    let driver = description
        .as_ref()
        .and_then(|d| d.driver().map(str::to_string))
        .unwrap_or_default();
    let name = description
        .as_ref()
        .map(|d| d.name().to_string())
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| id.clone());
    Some(RawDevice {
        host,
        driver,
        info: InputDeviceInfo { id, name },
    })
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
        .map_err(|e| microphone_open_error("could not start the microphone capture", e))
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
    let mut inner = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
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
    let result = match recording.done_rx.recv_timeout(ENCODER_FINALIZE_TIMEOUT) {
        Ok(outcome) => outcome,
        Err(RecvTimeoutError::Timeout) => {
            Err("the recording took too long to finalize — the file may be incomplete".to_string())
        }
        Err(RecvTimeoutError::Disconnected) => {
            Err("recording could not be finalized".to_string())
        }
    };
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
    let _ = recording.done_rx.recv_timeout(ENCODER_FINALIZE_TIMEOUT);
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

fn reserve_recording_path(dir: &Path, format: &str) -> Result<PathBuf, String> {
    let mut ms = unix_millis_now();
    for _ in 0..10_000 {
        let path = dir.join(format!("recording-{ms}.{format}"));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => ms += 1,
            Err(e) => return Err(format!("could not create the recording file: {e}")),
        }
    }
    Err("could not find a free recording name".to_string())
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

    // Card ids as /proc/asound spells them, so tests exercise the same
    // id-to-index collapsing the real enumerator triggers.
    fn cards() -> CardIndex {
        let mut by_id = HashMap::new();
        by_id.insert("Generic".to_string(), 1);
        by_id.insert("Audio".to_string(), 2);
        by_id.insert("NVidia".to_string(), 0);
        CardIndex { by_id }
    }

    fn raw(driver: &str, id: &str, name: &str) -> RawDevice {
        RawDevice {
            host: cpal::HostId::Alsa,
            driver: driver.to_string(),
            info: InputDeviceInfo {
                id: id.to_string(),
                name: name.to_string(),
            },
        }
    }

    fn foreign(host: cpal::HostId, driver: &str, id: &str, name: &str) -> RawDevice {
        RawDevice {
            host,
            driver: driver.to_string(),
            info: InputDeviceInfo {
                id: id.to_string(),
                name: name.to_string(),
            },
        }
    }

    // The complete PCM inventory a three-microphone Linux box reports, as a
    // plugin list and two flavours of every physical endpoint.
    fn full_alsa_inventory() -> Vec<RawDevice> {
        [
            ("null", "alsa:null"),
            ("lavrate", "alsa:lavrate"),
            ("samplerate", "alsa:samplerate"),
            ("speexrate", "alsa:speexrate"),
            ("jack", "alsa:jack"),
            ("oss", "alsa:oss"),
            ("pipewire", "alsa:pipewire"),
            ("pulse", "alsa:pulse"),
            ("speex", "alsa:speex"),
            ("upmix", "alsa:upmix"),
            ("vdownmix", "alsa:vdownmix"),
            ("default", "alsa:default"),
            ("hdmi:CARD=NVidia,DEV=0", "alsa:hdmi:CARD=NVidia,DEV=0"),
            ("dmix:CARD=NVidia,DEV=3", "alsa:dmix:CARD=NVidia,DEV=3"),
            ("usbstream:CARD=NVidia", "alsa:usbstream:CARD=NVidia"),
            ("hw:CARD=Generic,DEV=0", "alsa:hw:CARD=Generic,DEV=0"),
            (
                "plughw:CARD=Generic,DEV=0",
                "alsa:plughw:CARD=Generic,DEV=0",
            ),
            ("sysdefault:CARD=Generic", "alsa:sysdefault:CARD=Generic"),
            ("front:CARD=Generic,DEV=0", "alsa:front:CARD=Generic,DEV=0"),
            (
                "surround51:CARD=Generic,DEV=0",
                "alsa:surround51:CARD=Generic,DEV=0",
            ),
            ("dmix:CARD=Generic,DEV=0", "alsa:dmix:CARD=Generic,DEV=0"),
            ("usbstream:CARD=Generic", "alsa:usbstream:CARD=Generic"),
            ("hw:CARD=Generic,DEV=2", "alsa:hw:CARD=Generic,DEV=2"),
            (
                "plughw:CARD=Generic,DEV=2",
                "alsa:plughw:CARD=Generic,DEV=2",
            ),
            ("hw:CARD=Audio,DEV=0", "alsa:hw:CARD=Audio,DEV=0"),
            ("plughw:CARD=Audio,DEV=0", "alsa:plughw:CARD=Audio,DEV=0"),
            ("sysdefault:CARD=Audio", "alsa:sysdefault:CARD=Audio"),
            ("front:CARD=Audio,DEV=0", "alsa:front:CARD=Audio,DEV=0"),
            (
                "surround71:CARD=Audio,DEV=0",
                "alsa:surround71:CARD=Audio,DEV=0",
            ),
            ("iec958:CARD=Audio,DEV=0", "alsa:iec958:CARD=Audio,DEV=0"),
            ("dmix:CARD=Audio,DEV=0", "alsa:dmix:CARD=Audio,DEV=0"),
            ("usbstream:CARD=Audio", "alsa:usbstream:CARD=Audio"),
        ]
        .iter()
        .map(|(driver, id)| {
            let mut device = raw(driver, id, driver);
            // Friendly names come from the card and device, so the two Generic
            // endpoints are distinguishable the way a user would tell them apart.
            device.info.name = match *driver {
                "hw:CARD=Generic,DEV=0"
                | "plughw:CARD=Generic,DEV=0"
                | "front:CARD=Generic,DEV=0"
                | "surround51:CARD=Generic,DEV=0"
                | "dmix:CARD=Generic,DEV=0" => "ALC892 Analog".to_string(),
                "hw:CARD=Generic,DEV=2" | "plughw:CARD=Generic,DEV=2" => {
                    "ALC892 Alt Analog".to_string()
                }
                "hw:CARD=Audio,DEV=0"
                | "plughw:CARD=Audio,DEV=0"
                | "sysdefault:CARD=Audio"
                | "front:CARD=Audio,DEV=0"
                | "surround71:CARD=Audio,DEV=0"
                | "iec958:CARD=Audio,DEV=0"
                | "dmix:CARD=Audio,DEV=0"
                | "usbstream:CARD=Audio" => "KT02H20 HIFI Audio USB Audio".to_string(),
                other => other.to_string(),
            };
            device
        })
        .collect()
    }

    #[test]
    fn classify_pcm_recognizes_hardware_routing_and_plugin_families() {
        assert_eq!(
            classify_pcm("hw:CARD=Generic,DEV=0", &cards()),
            PcmKind::Hardware { card: 1, dev: 0 }
        );
        assert_eq!(
            classify_pcm("plughw:CARD=Audio,DEV=2", &cards()),
            PcmKind::Hardware { card: 2, dev: 2 }
        );
        for routing in ["default", "pulse", "pipewire", "jack"] {
            assert_eq!(
                classify_pcm(routing, &cards()),
                PcmKind::Routing,
                "{routing}"
            );
        }
        for plugin in [
            "null",
            "oss",
            "speex",
            "upmix",
            "vdownmix",
            "lavrate",
            "samplerate",
            "speexrate",
            // Card-scoped but not device-scoped: an alias for a whole card.
            "sysdefault:CARD=Generic",
            "usbstream:CARD=Audio",
            // Device-scoped but bound to a routing/DSP helper, not the endpoint.
            "front:CARD=Generic,DEV=0",
            "surround51:CARD=Generic,DEV=0",
            "dmix:CARD=Audio,DEV=0",
            "iec958:CARD=Audio,DEV=0",
            "hdmi:CARD=NVidia,DEV=0",
        ] {
            assert_eq!(classify_pcm(plugin, &cards()), PcmKind::Plugin, "{plugin}");
        }
    }

    #[test]
    fn classify_pcm_rejects_hardware_shapes_without_a_usable_device_number() {
        assert_eq!(classify_pcm("hw:CARD=Generic", &cards()), PcmKind::Plugin);
        assert_eq!(
            classify_pcm("hw:CARD=Generic,DEV=x", &cards()),
            PcmKind::Plugin
        );
        assert_eq!(classify_pcm("hw:DEV=0", &cards()), PcmKind::Plugin);
    }

    #[test]
    fn collapse_hardware_reduces_the_full_alsa_inventory_to_one_row_per_endpoint() {
        let ids: Vec<String> = collapse_hardware_with(full_alsa_inventory(), &cards())
            .into_iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(
            ids,
            vec![
                "alsa:plughw:CARD=Generic,DEV=2".to_string(),
                "alsa:plughw:CARD=Generic,DEV=0".to_string(),
                "alsa:plughw:CARD=Audio,DEV=0".to_string(),
            ]
        );
    }

    #[test]
    fn collapse_hardware_prefers_plughw_over_hw_for_the_same_endpoint() {
        let devices = vec![
            raw("hw:CARD=Audio,DEV=0", "alsa:hw:CARD=Audio,DEV=0", "hw name"),
            raw(
                "plughw:CARD=Audio,DEV=0",
                "alsa:plughw:CARD=Audio,DEV=0",
                "plughw name",
            ),
        ];
        let collapsed = collapse_hardware_with(devices, &cards());
        assert_eq!(collapsed.len(), 1);
        assert_eq!(collapsed[0].id, "alsa:plughw:CARD=Audio,DEV=0");
    }

    #[test]
    fn collapse_hardware_keeps_hw_when_no_plughw_alias_exists() {
        let collapsed = collapse_hardware_with(
            vec![raw(
                "hw:CARD=Generic,DEV=2",
                "alsa:hw:CARD=Generic,DEV=2",
                "ALC892 Alt Analog",
            )],
            &cards(),
        );
        assert_eq!(collapsed.len(), 1);
        assert_eq!(collapsed[0].id, "alsa:hw:CARD=Generic,DEV=2");
    }

    #[test]
    fn collapse_hardware_separates_distinct_devices_on_one_card() {
        let collapsed = collapse_hardware_with(
            vec![
                raw(
                    "plughw:CARD=Generic,DEV=0",
                    "alsa:plughw:CARD=Generic,DEV=0",
                    "a Analog",
                ),
                raw(
                    "plughw:CARD=Generic,DEV=2",
                    "alsa:plughw:CARD=Generic,DEV=2",
                    "b Alt Analog",
                ),
                raw(
                    "plughw:CARD=Audio,DEV=0",
                    "alsa:plughw:CARD=Audio,DEV=0",
                    "c USB",
                ),
            ],
            &cards(),
        );
        assert_eq!(
            collapsed.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            vec![
                "alsa:plughw:CARD=Generic,DEV=0",
                "alsa:plughw:CARD=Generic,DEV=2",
                "alsa:plughw:CARD=Audio,DEV=0",
            ]
        );
    }

    #[test]
    fn collapse_hardware_is_deterministic_regardless_of_input_order() {
        let cards = cards();
        let forward = collapse_hardware_with(full_alsa_inventory(), &cards);
        let mut reversed = full_alsa_inventory();
        reversed.reverse();
        let backward = collapse_hardware_with(reversed, &cards);
        assert_eq!(forward, backward);
    }

    #[test]
    fn collapse_hardware_drops_routing_and_plugin_entries() {
        let collapsed = collapse_hardware_with(
            vec![
                raw("default", "alsa:default", "Default ALSA Output"),
                raw("pulse", "alsa:pulse", "PulseAudio Sound Server"),
                raw("pipewire", "alsa:pipewire", "PipeWire Sound Server"),
                raw("null", "alsa:null", "Discard all samples"),
                raw("speex", "alsa:speex", "Plugin using Speex DSP"),
                raw(
                    "plughw:CARD=Generic,DEV=0",
                    "alsa:plughw:CARD=Generic,DEV=0",
                    "ALC892 Analog",
                ),
            ],
            &cards(),
        );
        assert_eq!(
            collapsed.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            vec!["alsa:plughw:CARD=Generic,DEV=0"]
        );
    }

    #[test]
    fn collapse_hardware_of_only_plugins_is_empty_rather_than_inventing_a_device() {
        assert!(collapse_hardware(vec![
            raw("default", "alsa:default", "Default ALSA Output"),
            raw("null", "alsa:null", "Discard all samples"),
        ])
        .is_empty());
    }

    #[test]
    fn collapse_hardware_merges_the_card_id_and_numeric_index_spellings() {
        // cpal enumerates each endpoint twice: once as CARD=<driver id> and once
        // as CARD=<index>. Both open the same PCM, so the picker must show one
        // row, not the same microphone twice under identical names.
        let collapsed = collapse_hardware_with(
            vec![
                raw(
                    "plughw:CARD=Generic,DEV=0",
                    "alsa:plughw:CARD=Generic,DEV=0",
                    "HD-Audio Generic, ALC892 Analog",
                ),
                raw(
                    "plughw:CARD=1,DEV=0",
                    "alsa:plughw:CARD=1,DEV=0",
                    "HD-Audio Generic, ALC892 Analog",
                ),
            ],
            &cards(),
        );
        assert_eq!(collapsed.len(), 1, "the same mic was listed twice");
    }

    #[test]
    fn collapse_hardware_keeps_endpoints_apart_across_different_cards() {
        let collapsed = collapse_hardware_with(
            vec![
                raw(
                    "plughw:CARD=Generic,DEV=0",
                    "alsa:plughw:CARD=Generic,DEV=0",
                    "Built-in",
                ),
                raw(
                    "plughw:CARD=Audio,DEV=0",
                    "alsa:plughw:CARD=Audio,DEV=0",
                    "USB",
                ),
            ],
            &cards(),
        );
        assert_eq!(collapsed.len(), 2);
    }

    #[test]
    fn collapse_hardware_keeps_non_alsa_backend_rows_intact() {
        // CoreAudio/WASAPI enumerate real devices already and report a driver
        // string that is not a pcm name, so running them through the ALSA rules
        // would silently empty the picker on those platforms. Only ALSA is
        // reachable on Linux, so this is provable on the other builds only.
        let non_alsa = [
            #[cfg(target_os = "macos")]
            cpal::HostId::CoreAudio,
            #[cfg(target_os = "windows")]
            cpal::HostId::Wasapi,
        ];
        let Some(host) = non_alsa.first().copied() else {
            return;
        };
        let collapsed = collapse_hardware(vec![foreign(
            host,
            "BuiltInMicrophoneDevice",
            "coreaudio:BuiltInMicrophoneDevice",
            "MacBook Pro Microphone",
        )]);
        assert_eq!(collapsed.len(), 1, "a foreign backend row must survive");
        assert_eq!(collapsed[0].id, "coreaudio:BuiltInMicrophoneDevice");
    }

    #[test]
    fn missing_device_error_names_the_device_and_where_to_change_it() {
        let message = missing_device_error("alsa:hw:CARD=Headset,DEV=0");
        assert!(message.contains("alsa:hw:CARD=Headset,DEV=0"));
        assert!(message.contains("not connected"));
        assert!(message.contains("Settings → Recording"));
    }

    #[test]
    fn unparsable_device_id_error_names_the_offending_value() {
        let message = unparsable_device_id_error("not a device id");
        assert!(message.contains("not a device id"));
        assert!(message.contains("Settings → Recording"));
    }

    #[test]
    fn device_busy_error_points_at_the_system_default_instead_of_an_errno() {
        let message = device_busy_error();
        assert!(message.contains("System default"));
        assert!(message.contains("Settings → Recording"));
        assert!(!message.to_lowercase().contains("errno"));
        assert!(!message.contains("Device or resource busy"));
    }

    #[test]
    fn microphone_open_error_substitutes_the_busy_message_only_for_device_busy() {
        let busy = microphone_open_error(
            "could not start the microphone capture",
            cpal::Error::from(cpal::ErrorKind::DeviceBusy),
        );
        assert_eq!(busy, device_busy_error());

        let other = microphone_open_error(
            "could not start the microphone capture",
            cpal::Error::from(cpal::ErrorKind::UnsupportedConfig),
        );
        assert!(other.starts_with("could not start the microphone capture"));
        assert!(!other.contains("System default"));
    }

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
    fn reserve_recording_path_is_atomic_and_avoids_collisions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = reserve_recording_path(dir.path(), "mp3").expect("reserve");
        let name = path
            .file_name()
            .expect("name")
            .to_string_lossy()
            .into_owned();
        assert!(name.starts_with("recording-") && name.ends_with(".mp3"));
        assert!(path.exists(), "reservation must create the file");
        let second = reserve_recording_path(dir.path(), "mp3").expect("reserve second");
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
