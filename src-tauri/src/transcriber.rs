use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ProgressPhase {
    Loading,
    Transcribing,
}

#[derive(Clone, Serialize)]
struct ProgressEvent {
    path: String,
    percent: f64,
    phase: ProgressPhase,
}

impl ProgressEvent {
    /// Must stay at 0 %: overlays adopt the active job from the first event they
    /// receive, and that adoption assumes 0 % (doc 07 adoption rule).
    fn initial(path: &str) -> Self {
        Self {
            path: path.to_string(),
            percent: 0.0,
            phase: ProgressPhase::Transcribing,
        }
    }

    fn loading(path: &str) -> Self {
        Self {
            path: path.to_string(),
            percent: 0.0,
            phase: ProgressPhase::Loading,
        }
    }

    fn tick(path: &str, elapsed_ms: u128, estimated_total_ms: u64) -> Self {
        Self {
            path: path.to_string(),
            percent: estimated_percent(elapsed_ms, estimated_total_ms),
            phase: ProgressPhase::Transcribing,
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

/// Keyed by directory as well as id: a prewarm thread can finish loading from the
/// previous models dir after `evict_all_engines` ran, and an id-only key would let
/// that stale engine answer a lookup for the new dir.
#[derive(Debug, PartialEq, Eq)]
struct EngineKey {
    model_id: String,
    dir: PathBuf,
}

impl EngineKey {
    fn from_paths(paths: &ModelPaths) -> EngineKey {
        EngineKey {
            model_id: paths.model_id.clone(),
            // Unreachable in practice: the encoder is always
            // `<models_dir>/<catalog-id>/encoder.int8.onnx`, so it has a parent.
            dir: paths
                .encoder
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf(),
        }
    }

    /// Stable across launches for an unchanged models dir, which is what lets a
    /// crash marker left by one session be recognised by the next. A renamed or
    /// reconfigured dir yields a different id, which is the correct answer.
    fn id(&self) -> String {
        format!("{}::{}", self.model_id, self.dir.display())
    }
}

static ENGINE_CACHE: Mutex<Option<(EngineKey, TransducerEngine)>> = Mutex::new(None);

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

fn lock_engine_cache() -> MutexGuard<'static, Option<(EngineKey, TransducerEngine)>> {
    match ENGINE_CACHE.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Loads the engine only when the cache does not already hold this exact
/// model-and-directory pair, and reports whether a load happened. The caller must
/// hold the cache lock across this call: that is what stops two callers building an
/// engine at once, and what keeps a key written after an eviction describing the
/// directory its own weights came from.
fn load_if_stale(
    cache: &mut Option<(EngineKey, TransducerEngine)>,
    paths: &ModelPaths,
) -> Result<bool, String> {
    let key = EngineKey::from_paths(paths);
    if matches!(cache, Some((cached, _)) if *cached == key) {
        return Ok(false);
    }
    let engine = parakeet_engine::load_engine(paths)?;
    *cache = Some((key, engine));
    Ok(true)
}

pub(crate) fn ensure_engine(paths: &ModelPaths) -> Result<bool, String> {
    let mut cache = lock_engine_cache();
    load_if_stale(&mut cache, paths)
}

pub(crate) fn engine_is_cold(paths: &ModelPaths) -> bool {
    let cache = lock_engine_cache();
    !cache
        .as_ref()
        .is_some_and(|(key, _)| *key == EngineKey::from_paths(paths))
}

fn with_engine<T>(
    paths: &ModelPaths,
    transcribe: impl FnOnce(&mut TransducerEngine) -> T,
) -> Result<T, String> {
    let mut cache = lock_engine_cache();
    // Reloads if an eviction landed since the caller ran its own ensure_engine, so
    // this never trusts the cache to still be warm.
    load_if_stale(&mut cache, paths)?;
    let engine = &mut cache.as_mut().expect("engine cache populated").1;
    Ok(transcribe(engine))
}

/// `delete_model` passes a model id and no directory, so eviction must not key on
/// the directory — the cached engine for that id has to go whatever it was loaded from.
fn cache_matches_model(key: &EngineKey, model_id: &str) -> bool {
    key.model_id == model_id
}

pub(crate) fn evict_engine_cache(model_id: &str) {
    let mut cache = lock_engine_cache();
    if cache
        .as_ref()
        .is_some_and(|(key, _)| cache_matches_model(key, model_id))
    {
        *cache = None;
    }
}

pub(crate) fn evict_all_engines() {
    let mut cache = lock_engine_cache();
    *cache = None;
}

const CRASH_MARKER: &str = "engine-prewarm-marker";

fn crash_marker_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    Ok(dir.join(CRASH_MARKER))
}

fn write_crash_marker_at(path: &Path, key: &EngineKey) -> bool {
    fs::write(path, key.id()).is_ok()
}

fn read_crash_marker_at(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

/// True when the last load attempt for this exact model-and-directory pair never
/// returned — an abort, `exit(-1)`, or a signal. `catch_unwind` cannot catch any of
/// those, so this file is the only evidence a crash left behind.
fn crash_marker_matches_at(path: &Path, key: &EngineKey) -> bool {
    read_crash_marker_at(path).as_deref() == Some(key.id().as_str())
}

fn disarm_crash_marker_at(path: &Path) {
    let _ = fs::remove_file(path);
}

fn crash_marker_matches(app: &AppHandle, key: &EngineKey) -> bool {
    crash_marker_path(app).is_ok_and(|path| crash_marker_matches_at(&path, key))
}

fn disarm_crash_marker(app: &AppHandle) {
    if let Ok(path) = crash_marker_path(app) {
        disarm_crash_marker_at(&path);
    }
}

/// Records that a load is in flight and reports whether the marker could be written.
/// Callers must skip the prewarm when it could not: a marker that cannot be armed
/// would not break an abort loop, so starting the load anyway risks a crash on every
/// launch forever.
fn arm_crash_marker(app: &AppHandle, key: &EngineKey) -> bool {
    crash_marker_path(app).is_ok_and(|path| write_crash_marker_at(&path, key))
}

/// Surfaces an orphaned marker to the user on the next launch. Runs synchronously so
/// the notice is in place before the frontend can ask for it — the load it describes
/// is the reason this launch got as far as drawing a window.
pub(crate) fn note_orphaned_prewarm_marker(app: &AppHandle) {
    let Ok(id) = resolve_model_id(app) else {
        return;
    };
    let Ok(paths) = models::ensure_model_ready(app, &id) else {
        return;
    };
    if !crash_marker_matches(app, &EngineKey::from_paths(&paths)) {
        return;
    }
    let _ = crate::settings::set_startup_notice(
        app,
        "The model failed to load last time, so preloading was disabled. Transcriptions may fail."
            .to_string(),
    );
}

/// Loads the engine in the background so the first dictation does not pay for it.
/// Unconditional by design: the crash marker, not a proof-of-success flag, is what
/// keeps a bad model from crashing every launch.
pub(crate) fn prewarm(app: &AppHandle) {
    if crate::downloader::any_active() {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        if crate::downloader::any_active() {
            return;
        }
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let Ok(id) = resolve_model_id(&handle) else {
                return;
            };
            let Ok(paths) = models::ensure_model_ready(&handle, &id) else {
                return;
            };
            if !engine_is_cold(&paths) {
                return;
            }
            let key = EngineKey::from_paths(&paths);
            if crash_marker_matches(&handle, &key) {
                return;
            }
            if !arm_crash_marker(&handle, &key) {
                return;
            }
            // Cleared on any return, Err included: the marker means "the load never
            // came back", not "the load failed". A plain Err would otherwise disable
            // preloading for good over a transient problem.
            let _ = ensure_engine(&paths);
            disarm_crash_marker(&handle);
        }));
        if outcome.is_err() {
            eprintln!("the model prewarm panicked");
        }
    });
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
    // The load happens before the watcher so `loading` is a distinct phase and the
    // time estimate below never has to cover it. Both would otherwise show a 99 %
    // bar sitting still through a multi-second load, and the timer would fold that
    // load into the reported duration. A prewarm that wins the race between this
    // check and the load makes `loading` flash for one tick, which the first
    // transcribing tick overwrites.
    if engine_is_cold(&paths) {
        let _ = app.emit("transcribe-progress", ProgressEvent::loading(&event_path));
    }
    let _ = ensure_engine(&paths)?;
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
    // A load that survived in the marker proves nothing on its own; a transcription
    // that ran to completion does, so this clears a marker left by a prewarm the user
    // quit out of.
    disarm_crash_marker(&app);
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
    path: String,
    auto_paste: bool,
) -> Result<(), String> {
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

    fn test_model_paths(dir: &str) -> ModelPaths {
        ModelPaths {
            model_id: "parakeet-v2-en".to_string(),
            encoder: PathBuf::from(dir).join("encoder.int8.onnx"),
            decoder: PathBuf::from(dir).join("decoder.int8.onnx"),
            joiner: PathBuf::from(dir).join("joiner.int8.onnx"),
            tokens: PathBuf::from(dir).join("tokens.txt"),
        }
    }

    #[test]
    fn engine_key_changes_when_models_dir_changes() {
        let before = EngineKey::from_paths(&test_model_paths("/models/a/parakeet-v2-en"));
        let after = EngineKey::from_paths(&test_model_paths("/models/b/parakeet-v2-en"));
        assert_ne!(before, after);
        assert_eq!(before.model_id, after.model_id);
        assert_eq!(before.dir, PathBuf::from("/models/a/parakeet-v2-en"));
    }

    #[test]
    fn engine_key_stable_for_same_model_and_dir() {
        let first = EngineKey::from_paths(&test_model_paths("/models/parakeet-v2-en"));
        let second = EngineKey::from_paths(&test_model_paths("/models/parakeet-v2-en"));
        assert_eq!(first, second);
    }

    #[test]
    fn engine_key_mismatch_can_only_cost_a_reload_never_the_wrong_engine() {
        // PathBuf equality is component-wise: a trailing separator still matches, an
        // unnormalised `..` does not. That asymmetry is safe because two paths that
        // compare equal cannot be different directories.
        assert_eq!(
            EngineKey::from_paths(&test_model_paths("/models/parakeet-v2-en")),
            EngineKey::from_paths(&test_model_paths("/models/parakeet-v2-en/")),
        );
        assert_ne!(
            EngineKey::from_paths(&test_model_paths("/models/x/../parakeet-v2-en")),
            EngineKey::from_paths(&test_model_paths("/models/parakeet-v2-en")),
        );
    }

    #[test]
    fn eviction_matches_on_model_id_regardless_of_directory() {
        let key = EngineKey::from_paths(&test_model_paths("/models/parakeet-v2-en"));
        assert!(cache_matches_model(&key, "parakeet-v2-en"));
        assert!(!cache_matches_model(&key, "parakeet-v3-multilingual"));
    }

    #[test]
    fn engine_is_cold_against_an_empty_cache() {
        assert!(engine_is_cold(&test_model_paths("/models/parakeet-v2-en")));
    }

    #[test]
    fn progress_event_loading_starts_at_zero() {
        let event = ProgressEvent::loading("/recordings/clip.wav");
        assert_eq!(event.percent, 0.0);
        assert_eq!(event.phase, ProgressPhase::Loading);
    }

    #[test]
    fn progress_event_serializes_phase_lowercase() {
        let json = serde_json::to_value(ProgressEvent::loading("p")).unwrap();
        assert_eq!(json["phase"], "loading");
        let json = serde_json::to_value(ProgressEvent::initial("p")).unwrap();
        assert_eq!(json["phase"], "transcribing");
    }

    #[test]
    fn crash_marker_round_trips_key() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join(CRASH_MARKER);
        let key = EngineKey::from_paths(&test_model_paths("/models/parakeet-v2-en"));
        assert!(!crash_marker_matches_at(&marker, &key));
        assert!(write_crash_marker_at(&marker, &key));
        assert!(crash_marker_matches_at(&marker, &key));
    }

    #[test]
    fn crash_marker_does_not_match_a_different_directory() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join(CRASH_MARKER);
        write_crash_marker_at(&marker, &EngineKey::from_paths(&test_model_paths("/models/a/parakeet-v2-en")));
        assert!(!crash_marker_matches_at(
            &marker,
            &EngineKey::from_paths(&test_model_paths("/models/b/parakeet-v2-en"))
        ));
    }

    #[test]
    fn disarm_crash_marker_clears_any_contents() {
        // Disarm runs on every return from the load, including Err, so it must not
        // care what the marker says — only that the next launch can prewarm again.
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join(CRASH_MARKER);
        let key = EngineKey::from_paths(&test_model_paths("/models/parakeet-v2-en"));
        write_crash_marker_at(&marker, &key);
        disarm_crash_marker_at(&marker);
        assert!(!crash_marker_matches_at(&marker, &key));
        assert!(!marker.exists());
    }

    #[test]
    fn arming_the_crash_marker_fails_on_an_unwritable_path() {
        // Callers skip the prewarm when arming fails, so this must not report success.
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("missing-dir").join(CRASH_MARKER);
        let key = EngineKey::from_paths(&test_model_paths("/models/parakeet-v2-en"));
        assert!(!write_crash_marker_at(&marker, &key));
    }

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
        assert_eq!(json["phase"], "transcribing");
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
