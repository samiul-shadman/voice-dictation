use serde::Serialize;
use std::process::{Command, Output, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvInfo {
    pub ffmpeg: bool,
    pub ffprobe: bool,
    pub libmp3lame: bool,
    pub pulse_input: bool,
    pub session_type: String,
    pub wtype: bool,
}

impl Default for EnvInfo {
    fn default() -> Self {
        Self {
            ffmpeg: false,
            ffprobe: false,
            libmp3lame: false,
            pulse_input: false,
            session_type: "other".to_string(),
            wtype: false,
        }
    }
}

pub struct EnvState(Mutex<EnvInfo>);

pub fn detect_and_cache(app: &AppHandle) {
    let info = detect();
    app.manage(EnvState(Mutex::new(info)));
}

#[allow(dead_code)]
pub fn cached_env(app: &AppHandle) -> EnvInfo {
    match app.try_state::<EnvState>() {
        Some(state) => state.0.lock().expect("env state lock poisoned").clone(),
        None => EnvInfo::default(),
    }
}

#[tauri::command]
pub fn detect_environment(app: AppHandle) -> EnvInfo {
    cached_env(&app)
}

pub fn detect() -> EnvInfo {
    let ffmpeg_output = run_with_timeout(version_command("ffmpeg"), Duration::from_secs(5));
    let ffmpeg = ffmpeg_output.as_ref().is_some_and(|o| o.status.success());
    let ffprobe = run_with_timeout(version_command("ffprobe"), Duration::from_secs(5))
        .is_some_and(|o| o.status.success());
    let libmp3lame = ffmpeg
        && run_with_timeout(encoders_command(), Duration::from_secs(5)).is_some_and(|o| {
            o.status.success() && String::from_utf8_lossy(&o.stdout).contains("libmp3lame")
        });
    let pulse_input = ffmpeg && check_pulse_input();
    let wtype = run_with_timeout(wtype_command(), Duration::from_secs(5))
        .is_some_and(|o| o.status.success());
    EnvInfo {
        ffmpeg,
        ffprobe,
        libmp3lame,
        pulse_input,
        session_type: detect_session_type(),
        wtype,
    }
}

fn version_command(binary: &str) -> Command {
    let mut command = Command::new(binary);
    command.arg("-version");
    command
}

fn encoders_command() -> Command {
    let mut command = Command::new("ffmpeg");
    command.arg("-hide_banner").arg("-encoders");
    command
}

fn wtype_command() -> Command {
    let mut command = Command::new("wtype");
    command.arg("--help");
    command
}

fn check_pulse_input() -> bool {
    let mut command = Command::new("ffmpeg");
    command.args(["-hide_banner", "-f", "pulse", "-i", "default", "-t", "0.2", "-f", "null", "-"]);
    match run_with_timeout(command, Duration::from_secs(5)) {
        Some(output) => {
            if output.status.success() {
                return true;
            }
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            text.contains("Output")
        }
        None => false,
    }
}

fn detect_session_type() -> String {
    if std::env::var("XDG_SESSION_TYPE").map(|v| v == "x11").unwrap_or(false) {
        return "x11".to_string();
    }
    if std::env::var("WAYLAND_DISPLAY").is_ok() {
        let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
        if desktop.to_lowercase().contains("gnome") {
            return "wayland-gnome".to_string();
        }
        return "wayland-wlroots".to_string();
    }
    "other".to_string()
}

fn run_with_timeout(mut command: Command, timeout: Duration) -> Option<Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
