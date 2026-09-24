use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::audiodecode;
use crate::engines::parakeet_engine;
use crate::models::{self, ModelPaths};
use crate::transcripts;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptData {
    pub audio_path: String,
    pub text: String,
    pub model_id: String,
    pub duration_ms: u64,
    pub created_at: u64,
}

#[derive(Clone, Serialize)]
struct ProgressEvent {
    path: String,
    percent: f64,
}

impl ProgressEvent {
    fn initial(path: &str) -> Self {
        Self {
            path: path.to_string(),
            percent: 0.0,
        }
    }

    fn tick(path: &str, elapsed_ms: u128, estimated_total_ms: u64) -> Self {
        Self {
            path: path.to_string(),
            percent: estimated_percent(elapsed_ms, estimated_total_ms),
        }
    }
}

fn estimated_percent(elapsed_ms: u128, estimated_total_ms: u64) -> f64 {
    if estimated_total_ms == 0 {
        return 0.0;
    }
    (elapsed_ms as f64 / estimated_total_ms as f64 * 100.0).min(99.0)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeCompleteEvent {
    path: String,
    text: String,
    model_id: String,
    duration_ms: u64,
    auto_paste: bool,
    paste_error: Option<String>,
}

#[derive(Clone, Serialize)]
struct TranscribeErrorEvent {
    path: String,
    message: String,
}

pub(crate) struct BusyFlag(AtomicBool);

impl BusyFlag {
    pub const fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    fn try_acquire(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }

    fn release(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

static BUSY: BusyFlag = BusyFlag::new();

type TransducerEngine = sherpa_rs::transducer::TransducerRecognizer;

static ENGINE_CACHE: Mutex<Option<(String, TransducerEngine)>> = Mutex::new(None);

struct StopWatcher(Arc<AtomicBool>);

impl Drop for StopWatcher {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

fn candidate_order(preferred: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    if !preferred.is_empty() {
        candidates.push(preferred.to_string());
    }
    for id in models::PREFERENCE_ORDER {
        if !candidates.iter().any(|c| c == id) {
            candidates.push(id.to_string());
        }
    }
    candidates
}

fn resolve_model_id(app: &AppHandle) -> Result<String, String> {
    let preferred = crate::settings::with_settings(app, |s| s.default_model.clone());
    for id in candidate_order(&preferred) {
        if models::ensure_model_ready(app, &id).is_ok() {
            return Ok(id);
        }
    }
    Err("no model downloaded — pick one on the Models page".to_string())
}

fn with_engine<T>(
    paths: &ModelPaths,
    transcribe: impl FnOnce(&mut TransducerEngine) -> T,
) -> Result<T, String> {
    let mut guard = match ENGINE_CACHE.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let stale = !matches!(&*guard, Some((id, _)) if id == &paths.model_id);
    if stale {
        let engine = parakeet_engine::load_engine(paths)?;
        *guard = Some((paths.model_id.clone(), engine));
    }
    let engine = &mut guard.as_mut().expect("engine cache populated").1;
    Ok(transcribe(engine))
}

pub(crate) fn evict_engine_cache(model_id: &str) {
    let mut guard = match ENGINE_CACHE.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if guard.as_ref().is_some_and(|(id, _)| id == model_id) {
        *guard = None;
    }
}

pub(crate) fn evict_all_engines() {
    let mut guard = match ENGINE_CACHE.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    *guard = None;
}

fn load_pcm16k_mono(input: &Path) -> Result<(Vec<f32>, u64), String> {
    audiodecode::decode_pcm16k_mono(input)
}

fn spawn_progress_watcher(
    app: AppHandle,
    path: String,
    estimated_total_ms: u64,
    stop: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let started = Instant::now();
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(200));
            if stop.load(Ordering::Relaxed) {
                return;
            }
            let event = ProgressEvent::tick(&path, started.elapsed().as_millis(), estimated_total_ms);
            let _ = app.emit("transcribe-progress", event);
        }
    })
}

fn run_transcription(
    app: AppHandle,
    audio_path: PathBuf,
    event_path: String,
    model_id: String,
    auto_paste: bool,
) -> Result<(), String> {
    let paths = models::ensure_model_ready(&app, &model_id)?;
    let (samples, audio_duration_ms) = load_pcm16k_mono(&audio_path)?;
    // sherpa-rs 0.6.8 (sherpa-onnx 1.12.9) has no recognition callback, so
    // progress is time-estimated from the audio duration (×0.35 realtime
    // factor) and clamped below 100 % until completion.
    let estimated_total_ms = (audio_duration_ms as f64 * 0.35) as u64;
    let stop = Arc::new(AtomicBool::new(false));
    let watcher =
        spawn_progress_watcher(app.clone(), event_path.clone(), estimated_total_ms, stop.clone());
    let _stop_on_drop = StopWatcher(stop);
    let started = Instant::now();
    let text = with_engine(&paths, |engine| {
        parakeet_engine::recognize(engine, &samples, 16_000)
    })?;
    let duration_ms = started.elapsed().as_millis() as u64;
    drop(_stop_on_drop);
    let _ = watcher.join();
    let data = TranscriptData {
        audio_path: event_path.clone(),
        text: text.clone(),
        model_id: model_id.clone(),
        duration_ms,
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    if let Err(e) = transcripts::save_sidecar(&audio_path, &data) {
        eprintln!("could not save the transcript sidecar: {e}");
    }
    // Paste runs on the worker thread — the Linux clipboard backend deadlocks
    // against the UI thread (v2 lesson preserved).
    let paste_error = if auto_paste {
        crate::paste::paste_transcript(&app, &text).err()
    } else {
        None
    };
    let _ = app.emit(
        "transcribe-complete",
        TranscribeCompleteEvent {
            path: event_path,
            text,
            model_id,
            duration_ms,
            auto_paste,
            paste_error,
        },
    );
    Ok(())
}

#[tauri::command(async)]
pub fn transcribe_file(
    app: tauri::AppHandle,
    window: tauri::Window,
    path: String,
    auto_paste: bool,
) -> Result<(), String> {
    let _ = window;
    let audio_path = crate::recorder::confine_to_audio_dir(&app, &path)?;
    if !BUSY.try_acquire() {
        return Err("a transcription is already in progress".to_string());
    }
    let model_id = match resolve_model_id(&app) {
        Ok(model_id) => model_id,
        Err(e) => {
            BUSY.release();
            return Err(e);
        }
    };
    // The first progress event for a job must be 0 % — overlays adopt the active
    // path from it (doc 07 adoption rule, Rust-side tested).
    let _ = app.emit("transcribe-progress", ProgressEvent::initial(&path));
    let app_for_worker = app.clone();
    let event_path = path.clone();
    let error_path = path;
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_transcription(
                app_for_worker.clone(),
                audio_path,
                event_path,
                model_id,
                auto_paste,
            )
        }));
        BUSY.release();
        match result {
            Ok(Ok(())) => {}
            Ok(Err(message)) => {
                let _ = app_for_worker.emit(
                    "transcribe-error",
                    TranscribeErrorEvent {
                        path: error_path,
                        message,
                    },
                );
            }
            Err(_) => {
                let _ = app_for_worker.emit(
                    "transcribe-error",
                    TranscribeErrorEvent {
                        path: error_path,
                        message: "transcription failed unexpectedly — try again".to_string(),
                    },
                );
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn get_transcript(app: tauri::AppHandle, path: String) -> Option<TranscriptData> {
    let target = crate::recorder::confine_to_audio_dir(&app, &path).ok()?;
    transcripts::load_sidecar(&target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_flag_guards_second_job_and_recovers() {
        let busy = BusyFlag::new();
        assert!(busy.try_acquire());
        assert!(!busy.try_acquire());
        busy.release();
        assert!(busy.try_acquire());
    }

    #[test]
    fn first_progress_event_is_zero() {
        let event = ProgressEvent::initial("/recordings/clip.wav");
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["path"], "/recordings/clip.wav");
        assert_eq!(json["percent"], 0.0);
    }

    #[test]
    fn complete_event_serializes_camel_case_fields() {
        let event = TranscribeCompleteEvent {
            path: "/recordings/clip.wav".to_string(),
            text: "hello".to_string(),
            model_id: "parakeet-v2-en".to_string(),
            duration_ms: 42,
            auto_paste: true,
            paste_error: Some("no display".to_string()),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["modelId"], "parakeet-v2-en");
        assert_eq!(json["durationMs"], 42);
        assert_eq!(json["autoPaste"], true);
        assert_eq!(json["pasteError"], "no display");
        assert!(json.get("model_id").is_none());
        assert!(json.get("duration_ms").is_none());
        assert!(json.get("auto_paste").is_none());
        assert!(json.get("paste_error").is_none());
    }

    #[test]
    fn progress_ticks_are_time_estimated_and_clamped() {
        let est = 10_000u64;
        assert_eq!(estimated_percent(0, est), 0.0);
        assert_eq!(ProgressEvent::tick("p", 0, est).percent, 0.0);
        assert_eq!(estimated_percent(5_000, est), 50.0);
        assert_eq!(estimated_percent(10_000, est), 99.0);
        assert_eq!(estimated_percent(1_000_000, est), 99.0);
        assert_eq!(estimated_percent(5_000, 0), 0.0);
    }

    #[test]
    fn model_resolution_prefers_default_then_preference_order() {
        assert_eq!(
            candidate_order("parakeet-v3-multilingual"),
            vec![
                "parakeet-v3-multilingual".to_string(),
                "parakeet-v2-en".to_string()
            ]
        );
        assert_eq!(
            candidate_order("parakeet-v2-en"),
            vec![
                "parakeet-v2-en".to_string(),
                "parakeet-v3-multilingual".to_string()
            ]
        );
        assert_eq!(
            candidate_order(""),
            vec![
                "parakeet-v2-en".to_string(),
                "parakeet-v3-multilingual".to_string()
            ]
        );
        assert_eq!(
            candidate_order("unknown-model"),
            vec![
                "unknown-model".to_string(),
                "parakeet-v2-en".to_string(),
                "parakeet-v3-multilingual".to_string()
            ]
        );
    }
}
