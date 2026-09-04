use crate::settings::{validate_audio_format, with_settings};
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Output, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const LEVEL_THROTTLE_MS: u64 = 50;
const RMS_LEVEL_KEY: &str = "lavfi.astats.Overall.RMS_level=";
const ASTATS_FILTER: &str =
    "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-";

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

struct Recording {
    child: Child,
    format: String,
    path: PathBuf,
    started_at: SystemTime,
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
    let mut command = Command::new("ffmpeg");
    command.args(["-f", "pulse", "-i", "default", "-ac", "1", "-ar", "44100"]);
    command.args(["-af", ASTATS_FILTER]);
    if format == "wav" {
        command.args(["-c:a", "pcm_s16le"]);
    } else {
        command.args(["-c:a", "libmp3lame", "-b:a", "192k"]);
    }
    command.arg(&path);
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(
                "ffmpeg was not found on PATH — install ffmpeg and restart the app".to_string(),
            );
        }
        Err(e) => return Err(format!("could not start ffmpeg: {e}")),
    };
    std::thread::sleep(Duration::from_millis(250));
    match child.try_wait() {
        Ok(Some(_)) => {
            let _ = fs::remove_file(&path);
            return Err("no audio input device — check that a microphone is connected and PulseAudio is running".to_string());
        }
        Ok(None) => {}
        Err(e) => {
            let _ = fs::remove_file(&path);
            return Err(format!("could not check ffmpeg status: {e}"));
        }
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "could not capture ffmpeg output".to_string())?;
    let mut child_slot = Some(child);
    let started = with_inner(&app, |inner| {
        if inner.stopping {
            return Err("a stop is already in progress".to_string());
        }
        if inner.recording.is_some() {
            return Err("a recording is already in progress".to_string());
        }
        if let Some(child) = child_slot.take() {
            inner.recording = Some(Recording {
                child,
                format,
                path: path.clone(),
                started_at: SystemTime::now(),
            });
        }
        Ok(())
    });
    match started {
        Ok(()) => {
            spawn_level_thread(app.clone(), stdout);
            emit_recording_state(&app, true, false);
            Ok(())
        }
        Err(e) => {
            if let Some(mut child) = child_slot.take() {
                let _ = child.kill();
                let _ = child.wait();
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
        let duration_secs = probe_duration(&path, Duration::from_secs(2));
        recordings.push(build_meta(&path, &format, duration_secs));
    }
    recordings.sort_by(|a, b| b.modified.cmp(&a.modified));
    recordings
}

#[tauri::command(async)]
pub fn delete_recording(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !is_allowed_extension(&target) {
        return Err("only .mp3 and .wav recordings can be deleted".to_string());
    }
    let canonical_target = target
        .canonicalize()
        .map_err(|_| format!("recording not found: {path}"))?;
    let dir = with_settings(&app, |s| PathBuf::from(s.audio_dir.clone()));
    if !is_path_within_dir(&dir, &target) {
        return Err("refusing to delete: path is outside the configured recordings folder".to_string());
    }
    let in_progress = with_inner(&app, |inner| {
        inner
            .recording
            .as_ref()
            .and_then(|r| r.path.canonicalize().ok())
            .is_some_and(|p| p == canonical_target)
    });
    if in_progress {
        return Err("cannot delete the recording that is currently in progress".to_string());
    }
    fs::remove_file(&target).map_err(|e| format!("could not delete recording: {e}"))?;
    let _ = fs::remove_file(sidecar_path_for(&target));
    Ok(())
}

#[tauri::command(async)]
pub fn read_recording(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let target = PathBuf::from(&path);
    if !is_allowed_extension(&target) {
        return Err("only .mp3 and .wav recordings can be read".to_string());
    }
    let dir = with_settings(&app, |s| PathBuf::from(s.audio_dir.clone()));
    if !is_path_within_dir(&dir, &target) {
        return Err(format!("recording not found: {path}"));
    }
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
        Some("mp3") | Some("wav")
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

pub(crate) fn sidecar_path_for(file: &Path) -> PathBuf {
    let stem = file
        .file_stem()
        .unwrap_or_else(|| file.file_name().unwrap_or_default());
    file.with_file_name(format!("{}.transcript.json", stem.to_string_lossy()))
}

pub(crate) fn parse_astats_dbfs(line: &str) -> Option<f64> {
    let value = line.split(RMS_LEVEL_KEY).nth(1)?;
    value.trim().parse::<f64>().ok()
}

pub(crate) fn dbfs_to_level(db: f64) -> f32 {
    if db.is_nan() || db <= -60.0 {
        return 0.0;
    }
    if db >= 0.0 {
        return 1.0;
    }
    ((db + 60.0) / 60.0) as f32
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

fn clear_stopping(app: &AppHandle) {
    with_inner(app, |inner| inner.stopping = false);
    emit_recording_state(app, false, false);
}

fn emit_recording_state(app: &AppHandle, recording: bool, stopping: bool) {
    let _ = app.emit("recording-state", RecordingState { recording, stopping });
}

fn finish_stop(app: AppHandle, mut recording: Recording) -> Result<RecordingMeta, String> {
    let recorded_for = recording
        .started_at
        .elapsed()
        .ok()
        .map(|d| d.as_secs_f64())
        .filter(|d| d.is_finite());
    let termination = terminate_recording(&mut recording);
    let duration_secs = probe_duration(&recording.path, Duration::from_secs(5))
        .or_else(|| recorded_for.filter(|d| *d >= 0.0));
    let meta = build_meta(&recording.path, &recording.format, duration_secs);
    clear_stopping(&app);
    termination
        .map(|_| meta)
        .map_err(|e| format!("could not stop ffmpeg: {e}"))
}

fn finish_cancel(app: AppHandle, mut recording: Recording) -> Result<(), String> {
    let termination = terminate_recording(&mut recording);
    let _ = fs::remove_file(&recording.path);
    clear_stopping(&app);
    termination.map_err(|e| format!("could not stop ffmpeg: {e}"))
}

fn terminate_recording(recording: &mut Recording) -> Result<(), String> {
    let pid = recording.child.id() as i32;
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match recording.child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
                let _ = recording.child.wait();
                return Err(format!("could not check ffmpeg status: {e}"));
            }
        }
    }
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
    recording
        .child
        .wait()
        .map(|_| ())
        .map_err(|e| format!("could not wait for ffmpeg to exit: {e}"))
}

fn spawn_level_thread(app: AppHandle, stdout: ChildStdout) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let mut last_emit = Instant::now()
            .checked_sub(Duration::from_millis(LEVEL_THROTTLE_MS))
            .unwrap_or_else(Instant::now);
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Some(db) = parse_astats_dbfs(&line) {
                        if last_emit.elapsed() >= Duration::from_millis(LEVEL_THROTTLE_MS) {
                            last_emit = Instant::now();
                            let level = dbfs_to_level(db);
                            let _ = app.emit("recording-level", LevelEvent { level });
                        }
                    }
                }
            }
        }
    });
}

fn probe_duration(path: &Path, timeout: Duration) -> Option<f64> {
    let mut command = Command::new("ffprobe");
    command.args([
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
    ]);
    command.arg(path);
    let output = run_with_timeout(command, timeout)?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|d| d.is_finite() && *d >= 0.0)
}

fn run_with_timeout(mut command: Command, timeout: Duration) -> Option<Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let child = command.spawn().ok()?;
    let pid = child.id();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(child.wait_with_output().ok());
    });
    match receiver.recv_timeout(timeout) {
        Ok(output) => output,
        Err(_) => {
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
            None
        }
    }
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
    fn parse_astats_dbfs_extracts_rms_values() {
        assert_eq!(
            parse_astats_dbfs("lavfi.astats.Overall.RMS_level=-30.5"),
            Some(-30.5)
        );
        assert_eq!(
            parse_astats_dbfs("lavfi.astats.Overall.RMS_level=-inf"),
            Some(f64::NEG_INFINITY)
        );
        assert_eq!(
            parse_astats_dbfs("lavfi.astats.Overall.RMS_level=-0.000001"),
            Some(-0.000001)
        );
        assert_eq!(parse_astats_dbfs("lavfi.astats.Overall.RMS_level=oops"), None);
        assert_eq!(parse_astats_dbfs("lavfi.astats.Overall.RMS_level="), None);
        assert_eq!(
            parse_astats_dbfs("lavfi.astats.Overall.Peak_level=-5.0"),
            None
        );
        assert_eq!(parse_astats_dbfs("garbage"), None);
        assert_eq!(parse_astats_dbfs(""), None);
    }

    #[test]
    fn dbfs_to_level_clamps_to_unit_range() {
        assert_eq!(dbfs_to_level(f64::NEG_INFINITY), 0.0);
        assert_eq!(dbfs_to_level(-60.0), 0.0);
        assert_eq!(dbfs_to_level(-120.0), 0.0);
        assert_eq!(dbfs_to_level(-30.0), 0.5);
        assert_eq!(dbfs_to_level(0.0), 1.0);
        assert_eq!(dbfs_to_level(10.0), 1.0);
        assert_eq!(dbfs_to_level(f64::NAN), 0.0);
    }

    #[test]
    fn allowlist_accepts_only_mp3_and_wav() {
        assert!(is_allowed_extension(Path::new("recording-1.mp3")));
        assert!(is_allowed_extension(Path::new("recording-1.wav")));
        assert!(is_allowed_extension(Path::new("recording-1.MP3")));
        assert!(is_allowed_extension(Path::new("/a/b/recording-1.Wav")));
        assert!(!is_allowed_extension(Path::new("recording-1.flac")));
        assert!(!is_allowed_extension(Path::new("recording-1.ogg")));
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
        let name = path.file_name().expect("name").to_string_lossy().into_owned();
        assert!(name.starts_with("recording-") && name.ends_with(".mp3"));
        assert!(name != "recording-.mp3");
        fs::write(&path, b"").expect("write");
        let second = next_recording_path(dir.path(), "mp3");
        assert_ne!(path, second);
        assert_eq!(second.extension().and_then(|e| e.to_str()), Some("mp3"));
    }
}
