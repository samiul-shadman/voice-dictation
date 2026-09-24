use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const JOIN_GRACE: Duration = Duration::from_secs(5);
const READ_CHUNK: usize = 64 * 1024;
const PROGRESS_MIN_BYTES: u64 = 2 * 1024 * 1024;
const PROGRESS_MIN_PERCENT: f64 = 5.0;

#[derive(Clone, Serialize)]
struct DownloadProgressEvent<'a> {
    id: &'a str,
    downloaded: u64,
    total: u64,
    percent: f64,
}

#[derive(Clone, Serialize)]
struct DownloadDoneEvent<'a> {
    id: &'a str,
}

#[derive(Clone, Serialize)]
struct DownloadErrorEvent<'a> {
    id: &'a str,
    message: String,
}

#[derive(Clone, Serialize)]
struct DownloadCancelledEvent<'a> {
    id: &'a str,
}

pub(crate) struct ActiveDownload {
    cancel: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

pub(crate) enum DownloadOutcome {
    Completed,
    Cancelled,
    Failed(String),
}

struct ProgressThrottle {
    app: AppHandle,
    id: String,
    total: u64,
    last_bytes: u64,
    last_percent: f64,
}

impl ProgressThrottle {
    fn update(&mut self, downloaded: u64) {
        let reported = downloaded.min(self.total);
        let percent = if self.total > 0 {
            reported as f64 / self.total as f64 * 100.0
        } else {
            0.0
        };
        let byte_delta = downloaded.saturating_sub(self.last_bytes);
        let percent_delta = percent - self.last_percent;
        if byte_delta >= PROGRESS_MIN_BYTES || percent_delta >= PROGRESS_MIN_PERCENT {
            self.last_bytes = downloaded;
            self.last_percent = percent;
            let _ = self.app.emit(
                "model-download-progress",
                DownloadProgressEvent {
                    id: &self.id,
                    downloaded: reported,
                    total: self.total,
                    percent,
                },
            );
        }
    }
}

fn downloads() -> &'static Mutex<HashMap<String, ActiveDownload>> {
    static DOWNLOADS: OnceLock<Mutex<HashMap<String, ActiveDownload>>> = OnceLock::new();
    DOWNLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn errors() -> &'static Mutex<HashMap<String, String>> {
    static ERRORS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    ERRORS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let builder = reqwest::blocking::Client::builder()
            .user_agent(concat!("voice-dictation/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(CONNECT_TIMEOUT)
            .tcp_keepalive(READ_IDLE_TIMEOUT);
        #[cfg(target_os = "linux")]
        let builder = builder.tcp_user_timeout(READ_IDLE_TIMEOUT);
        builder
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    })
}

fn lock_downloads() -> MutexGuard<'static, HashMap<String, ActiveDownload>> {
    downloads().lock().unwrap_or_else(|p| p.into_inner())
}

fn lock_errors() -> MutexGuard<'static, HashMap<String, String>> {
    errors().lock().unwrap_or_else(|p| p.into_inner())
}

fn is_active(active: &ActiveDownload) -> bool {
    active.thread.as_ref().map_or(true, |t| !t.is_finished())
}

pub(crate) fn gc_finished() {
    lock_downloads().retain(|_, active| is_active(active));
}

pub(crate) fn is_downloading(id: &str) -> bool {
    lock_downloads().get(id).is_some_and(is_active)
}

pub(crate) fn any_active() -> bool {
    lock_downloads().values().any(is_active)
}

pub(crate) fn error_of(id: &str) -> Option<String> {
    lock_errors().get(id).cloned()
}

fn record_error(id: &str, message: &str) {
    lock_errors().insert(id.to_string(), message.to_string());
}

pub(crate) fn request_cancel(id: &str) -> Result<(), String> {
    let spec = crate::models::find_spec(id).ok_or_else(|| format!("unknown model id: {id}"))?;
    if let Some(active) = lock_downloads().get(spec.id) {
        active.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

pub(crate) fn is_cancelling(id: &str) -> bool {
    lock_downloads()
        .get(id)
        .is_some_and(|active| active.cancel.load(Ordering::Relaxed))
}

fn finish_download(id: &str, my_cancel: &Arc<AtomicBool>) {
    let mut map = lock_downloads();
    let matches = map
        .get(id)
        .is_some_and(|active| Arc::ptr_eq(&active.cancel, my_cancel));
    if matches {
        map.remove(id);
    }
}

pub(crate) fn start_download(app: AppHandle, id: &str) -> Result<(), String> {
    let spec = crate::models::find_spec(id).ok_or_else(|| format!("unknown model id: {id}"))?;
    gc_finished();
    let cancel = {
        let mut map = lock_downloads();
        if map.get(spec.id).is_some_and(is_active) {
            return Ok(());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        map.insert(
            spec.id.to_string(),
            ActiveDownload {
                cancel: cancel.clone(),
                thread: None,
            },
        );
        cancel
    };
    lock_errors().remove(spec.id);
    let app_for_thread = app.clone();
    let id_for_thread = spec.id.to_string();
    let handle = std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_download(app_for_thread.clone(), id_for_thread.clone(), cancel.clone())
        }));
        let outcome = match result {
            Ok(outcome) => outcome,
            Err(_) => DownloadOutcome::Failed(
                "download failed unexpectedly — retry the download".to_string(),
            ),
        };
        match outcome {
            DownloadOutcome::Completed => {
                let _ = app_for_thread.emit(
                    "model-download-done",
                    DownloadDoneEvent { id: &id_for_thread },
                );
            }
            DownloadOutcome::Cancelled => {
                let _ = app_for_thread.emit(
                    "model-download-cancelled",
                    DownloadCancelledEvent { id: &id_for_thread },
                );
            }
            DownloadOutcome::Failed(message) => {
                record_error(&id_for_thread, &message);
                let _ = app_for_thread.emit(
                    "model-download-error",
                    DownloadErrorEvent {
                        id: &id_for_thread,
                        message,
                    },
                );
            }
        }
        finish_download(&id_for_thread, &cancel);
    });
    if let Some(active) = lock_downloads().get_mut(spec.id) {
        active.thread = Some(handle);
    }
    Ok(())
}

fn run_download(app: AppHandle, id: String, cancel: Arc<AtomicBool>) -> DownloadOutcome {
    let Some(spec) = crate::models::find_spec(&id) else {
        return DownloadOutcome::Failed(format!("unknown model id: {id}"));
    };
    let dir = crate::models::resolve_models_dir(&app).join(spec.id);
    if let Err(e) = fs::create_dir_all(&dir) {
        return DownloadOutcome::Failed(format!("could not create the model directory: {e}"));
    }
    for file in &spec.files {
        if cancel.load(Ordering::Relaxed) {
            return DownloadOutcome::Cancelled;
        }
        match download_file(&app, spec, &dir, file, &cancel) {
            DownloadOutcome::Completed => {}
            other => return other,
        }
    }
    let decoder_path = dir.join(crate::models::DECODER_FILE);
    if let Err(e) = crate::models::patch_parakeet_decoder(&decoder_path) {
        crate::models::remove_patched_manifest(&dir);
        return DownloadOutcome::Failed(format!(
            "the decoder could not be prepared for the engine ({e}) — retry the download"
        ));
    }
    DownloadOutcome::Completed
}

fn download_file(
    app: &AppHandle,
    spec: &crate::models::ModelSpec,
    dir: &Path,
    file: &crate::models::ModelFile,
    cancel: &Arc<AtomicBool>,
) -> DownloadOutcome {
    let part = dir.join(format!("{}.part", file.name));
    let response = match client().get(crate::models::file_url(spec, file)).send() {
        Ok(response) => response,
        Err(e) => return DownloadOutcome::Failed(format!("{}: could not connect: {e}", file.name)),
    };
    let response = match response.error_for_status() {
        Ok(response) => response,
        Err(e) => return DownloadOutcome::Failed(format!("{}: server error: {e}", file.name)),
    };
    let total = response.content_length().unwrap_or(file.size_bytes);
    let mut throttle = ProgressThrottle {
        app: app.clone(),
        id: spec.id.to_string(),
        total,
        last_bytes: 0,
        last_percent: 0.0,
    };
    let outcome = fetch_with_idle_timeout(response, &part, cancel.clone(), move |downloaded| {
        throttle.update(downloaded)
    });
    if !matches!(outcome, DownloadOutcome::Completed) {
        return outcome;
    }
    match finalize_download(&part, &dir.join(&file.name), file.size_bytes) {
        Ok(()) => DownloadOutcome::Completed,
        Err(message) => DownloadOutcome::Failed(format!("{}: {message}", file.name)),
    }
}

fn finalize_download(part: &Path, final_path: &Path, expected_size: u64) -> Result<(), String> {
    let actual = match part.metadata() {
        Ok(meta) => meta.len(),
        Err(e) => {
            let _ = fs::remove_file(part);
            return Err(format!("could not stat the download: {e}"));
        }
    };
    if actual != expected_size {
        let _ = fs::remove_file(part);
        return Err(format!(
            "downloaded {actual} bytes but the catalog pins {expected_size} — retry the download"
        ));
    }
    if let Err(e) = fs::rename(part, final_path) {
        let _ = fs::remove_file(part);
        return Err(format!("could not finalize the download: {e}"));
    }
    Ok(())
}

fn fetch_with_idle_timeout<R: Read + Send + 'static>(
    reader: R,
    part: &Path,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(u64) + Send + 'static,
) -> DownloadOutcome {
    let part = part.to_path_buf();
    let (progress_tx, progress_rx) = mpsc::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel::<DownloadOutcome>();
    let cancel_for_thread = cancel.clone();
    let part_for_thread = part.clone();
    let handle = std::thread::spawn(move || {
        let outcome = fetch_loop(reader, &part_for_thread, &cancel_for_thread, move |downloaded| {
            let _ = progress_tx.send(());
            on_progress(downloaded)
        });
        let _ = done_tx.send(outcome);
    });
    let mut last_progress = Instant::now();
    let mut forced: Option<DownloadOutcome> = None;
    loop {
        match progress_rx.recv_timeout(Duration::from_secs(1)) {
            Ok(()) => {
                last_progress = Instant::now();
                if cancel.load(Ordering::Relaxed) {
                    forced = Some(DownloadOutcome::Cancelled);
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if cancel.load(Ordering::Relaxed) {
                    forced = Some(DownloadOutcome::Cancelled);
                    break;
                }
                if last_progress.elapsed() >= READ_IDLE_TIMEOUT {
                    forced = Some(DownloadOutcome::Failed(
                        "download stalled — no data for 60 s — retry the download".to_string(),
                    ));
                    break;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    if forced.is_some() {
        cancel.store(true, Ordering::Relaxed);
        let _ = fs::remove_file(&part);
    }
    // Wait for the reader to notice the flag and exit so its socket and thread do
    // not leak. A silently-alive peer can block `read` past the grace period; in
    // that case detach and let the active entry stay until the thread ends.
    match done_rx.recv_timeout(JOIN_GRACE) {
        Ok(outcome) => {
            let _ = handle.join();
            forced.unwrap_or(outcome)
        }
        Err(RecvTimeoutError::Disconnected) => {
            let _ = handle.join();
            forced.unwrap_or_else(|| {
                DownloadOutcome::Failed("download failed unexpectedly — retry the download".to_string())
            })
        }
        Err(RecvTimeoutError::Timeout) => forced.unwrap_or_else(|| {
            DownloadOutcome::Failed("download stalled — retry the download".to_string())
        }),
    }
}

fn fetch_loop<R: Read>(
    mut reader: R,
    part: &Path,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(u64),
) -> DownloadOutcome {
    let mut file = match fs::File::create(part) {
        Ok(file) => file,
        Err(e) => return DownloadOutcome::Failed(format!("could not create .part file: {e}")),
    };
    let mut buf = vec![0u8; READ_CHUNK];
    let mut downloaded: u64 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = fs::remove_file(part);
            return DownloadOutcome::Cancelled;
        }
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if let Err(e) = file.write_all(&buf[..n]) {
                    let _ = fs::remove_file(part);
                    return DownloadOutcome::Failed(format!(
                        "could not write download data: {e}"
                    ));
                }
                downloaded += n as u64;
                on_progress(downloaded);
            }
            Err(e) => {
                let _ = fs::remove_file(part);
                return DownloadOutcome::Failed(format!("download interrupted: {e}"));
            }
        }
    }
    if let Err(e) = file.flush() {
        let _ = fs::remove_file(part);
        return DownloadOutcome::Failed(format!("could not flush download data: {e}"));
    }
    DownloadOutcome::Completed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Cursor};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    #[test]
    fn fetch_loop_writes_body_and_reports_progress() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("body.bin.part");
        let data = vec![42u8; 100_000];
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_for_closure = seen.clone();
        let outcome = fetch_loop(
            Cursor::new(data.clone()),
            &part,
            &AtomicBool::new(false),
            move |downloaded| seen_for_closure.lock().unwrap().push(downloaded),
        );
        assert!(matches!(outcome, DownloadOutcome::Completed));
        let written = fs::read(&part).unwrap();
        assert_eq!(written.len(), 100_000);
        assert!(written.iter().all(|b| *b == 42));
        let progress = seen.lock().unwrap();
        assert_eq!(progress.last(), Some(&100_000));
        assert!(progress.len() > 1);
    }

    fn body_after_headers(stream: TcpStream) -> BufReader<TcpStream> {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader.read_line(&mut line).expect("read http header");
            assert!(n > 0, "server closed before headers ended");
            if line == "\r\n" {
                return reader;
            }
        }
    }

    #[test]
    fn cancel_then_restart_download_completes() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("model.bin.part");
        let total = 256 * 1024;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for _ in 0..2 {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"
                );
                if stream.write_all(header.as_bytes()).is_err() {
                    continue;
                }
                let chunk = [0u8; 4096];
                for _ in 0..(total / chunk.len() as u64) {
                    if stream.write_all(&chunk).is_err() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(2));
                }
            }
        });

        let cancel = Arc::new(AtomicBool::new(false));
        let stream = body_after_headers(TcpStream::connect(addr).unwrap());
        let part_for_thread = part.clone();
        let cancel_for_thread = cancel.clone();
        let handle = thread::spawn(move || {
            fetch_loop(stream, &part_for_thread, &cancel_for_thread, |_| {})
        });
        thread::sleep(Duration::from_millis(60));
        let mut in_flight = false;
        for _ in 0..100 {
            if part.exists() {
                in_flight = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(in_flight, "download should be in flight");
        cancel.store(true, Ordering::Relaxed);
        let outcome = handle.join().unwrap();
        assert!(matches!(outcome, DownloadOutcome::Cancelled));
        assert!(!part.exists(), ".part must be removed after cancel");

        let stream = body_after_headers(TcpStream::connect(addr).unwrap());
        let outcome = fetch_loop(stream, &part, &AtomicBool::new(false), |_| {});
        assert!(matches!(outcome, DownloadOutcome::Completed));
        let written = fs::read(&part).unwrap();
        assert_eq!(written.len() as u64, total);
        server.join().unwrap();
    }

    #[test]
    fn idle_timeout_coordinator_cancels_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("coord.bin.part");
        let total = 512 * 1024;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"
            );
            if stream.write_all(header.as_bytes()).is_err() {
                return;
            }
            let chunk = [0u8; 4096];
            for _ in 0..(total / chunk.len() as u64) {
                if stream.write_all(&chunk).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(2));
            }
        });

        let stream = body_after_headers(TcpStream::connect(addr).unwrap());
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_for_thread = cancel.clone();
        let part_for_thread = part.clone();
        let handle = thread::spawn(move || {
            fetch_with_idle_timeout(stream, &part_for_thread, cancel_for_thread, |_| {})
        });
        let mut in_flight = false;
        for _ in 0..100 {
            if part.exists() {
                in_flight = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(in_flight, "download should be in flight");
        cancel.store(true, Ordering::Relaxed);
        let outcome = handle.join().unwrap();
        assert!(matches!(outcome, DownloadOutcome::Cancelled));
        assert!(!part.exists(), ".part must be removed after cancel");
        server.join().unwrap();
    }

    #[test]
    fn finalize_renames_when_size_matches() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("file.bin.part");
        let final_path = dir.path().join("file.bin");
        fs::write(&part, vec![7u8; 512]).unwrap();
        finalize_download(&part, &final_path, 512).expect("finalize");
        assert!(!part.exists());
        assert_eq!(fs::metadata(&final_path).unwrap().len(), 512);
    }

    #[test]
    fn finalize_rejects_size_mismatch_and_removes_part() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("file.bin.part");
        let final_path = dir.path().join("file.bin");
        fs::write(&part, vec![7u8; 100]).unwrap();
        let err = finalize_download(&part, &final_path, 512).expect_err("mismatch must fail");
        assert!(err.contains("100") && err.contains("512"));
        assert!(!part.exists());
        assert!(!final_path.exists());
    }
}
