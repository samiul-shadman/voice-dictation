use serde::Serialize;
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvInfo {
    pub platform: String,
    pub mic_available: bool,
    pub accessibility_permission: Option<bool>,
    pub session_type: String,
    pub wtype: Option<bool>,
}

pub struct EnvState(Mutex<EnvInfo>);

pub fn detect_and_cache(app: &AppHandle) {
    let info = detect();
    app.manage(EnvState(Mutex::new(info)));
}

pub fn cached_env(app: &AppHandle) -> EnvInfo {
    match app.try_state::<EnvState>() {
        Some(state) => state.0.lock().expect("env state lock poisoned").clone(),
        None => EnvInfo {
            platform: std::env::consts::OS.to_string(),
            mic_available: false,
            accessibility_permission: None,
            session_type: "other".to_string(),
            wtype: None,
        },
    }
}

#[tauri::command]
pub fn detect_environment(app: AppHandle) -> EnvInfo {
    cached_env(&app)
}

pub fn detect() -> EnvInfo {
    EnvInfo {
        platform: std::env::consts::OS.to_string(),
        mic_available: mic_available(),
        accessibility_permission: accessibility_permission(),
        session_type: detect_session_type(),
        wtype: wtype_available(),
    }
}

fn mic_available() -> bool {
    use cpal::traits::HostTrait;
    cpal::default_host().default_input_device().is_some()
}

#[cfg(target_os = "macos")]
fn accessibility_permission() -> Option<bool> {
    Some(unsafe { ax_is_process_trusted() != 0 })
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

#[cfg(not(target_os = "macos"))]
fn accessibility_permission() -> Option<bool> {
    None
}

#[cfg(target_os = "linux")]
fn wtype_available() -> Option<bool> {
    Some(
        run_with_timeout(wtype_command(), Duration::from_secs(5))
            .is_some_and(|o| o.status.success()),
    )
}

#[cfg(not(target_os = "linux"))]
fn wtype_available() -> Option<bool> {
    None
}

#[cfg(target_os = "linux")]
fn wtype_command() -> std::process::Command {
    let mut command = std::process::Command::new("wtype");
    command.arg("--help");
    command
}

fn detect_session_type() -> String {
    #[cfg(target_os = "linux")]
    {
        if std::env::var("XDG_SESSION_TYPE")
            .map(|v| v == "x11")
            .unwrap_or(false)
        {
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
    #[cfg(not(target_os = "linux"))]
    {
        "native".to_string()
    }
}

#[cfg(target_os = "linux")]
fn run_with_timeout(
    mut command: std::process::Command,
    timeout: Duration,
) -> Option<std::process::Output> {
    use std::process::Stdio;

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
