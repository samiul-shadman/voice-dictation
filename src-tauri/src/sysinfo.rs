use serde::Serialize;
use std::sync::Mutex;
#[cfg(target_os = "linux")]
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
    let info = detect_fast();
    app.manage(EnvState(Mutex::new(info)));
}

fn cache_env(app: &AppHandle, info: &EnvInfo) {
    match app.try_state::<EnvState>() {
        Some(state) => match state.0.lock() {
            Ok(mut guard) => *guard = info.clone(),
            Err(poisoned) => *poisoned.into_inner() = info.clone(),
        },
        None => {
            app.manage(EnvState(Mutex::new(info.clone())));
        }
    }
}

pub fn cached_env(app: &AppHandle) -> EnvInfo {
    match app.try_state::<EnvState>() {
        Some(state) => state
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone(),
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

#[tauri::command]
pub fn recheck_environment(app: AppHandle) -> EnvInfo {
    let info = detect();
    cache_env(&app, &info);
    info
}

/// Startup probe — deliberately skips the `wtype --help` spawn (see P1.9); the
/// Settings → Environment page triggers the full `recheck_environment`.
fn detect_fast() -> EnvInfo {
    EnvInfo {
        platform: std::env::consts::OS.to_string(),
        mic_available: mic_available(),
        accessibility_permission: accessibility_permission(),
        session_type: detect_session_type(),
        wtype: None,
    }
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
    Some(unsafe { AXIsProcessTrusted() != 0 })
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
            .is_some_and(|status| status.success()),
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

#[cfg(target_os = "linux")]
fn classify_session(
    xdg_session_type: Option<&str>,
    wayland_display: Option<&str>,
    current_desktop: Option<&str>,
) -> String {
    if xdg_session_type == Some("x11") {
        return "x11".to_string();
    }
    if wayland_display.is_some() {
        let desktop = current_desktop.unwrap_or_default();
        if desktop.to_lowercase().contains("gnome") {
            return "wayland-gnome".to_string();
        }
        return "wayland-wlroots".to_string();
    }
    "other".to_string()
}

fn detect_session_type() -> String {
    #[cfg(target_os = "linux")]
    {
        classify_session(
            std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
            std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
            std::env::var("XDG_CURRENT_DESKTOP").ok().as_deref(),
        )
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
) -> Option<std::process::ExitStatus> {
    use std::process::Stdio;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn accessibility_permission_is_none_on_non_macos() {
        assert_eq!(accessibility_permission(), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn classify_session_detects_x11() {
        assert_eq!(classify_session(Some("x11"), None, None), "x11");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn classify_session_x11_takes_precedence_over_wayland() {
        assert_eq!(
            classify_session(Some("x11"), Some("wayland-0"), Some("GNOME")),
            "x11"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn classify_session_detects_wayland_wlroots() {
        assert_eq!(
            classify_session(None, Some("wayland-0"), Some("sway")),
            "wayland-wlroots"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn classify_session_detects_wayland_gnome_case_insensitively() {
        assert_eq!(
            classify_session(Some("wayland"), Some("wayland-0"), Some("GNOME")),
            "wayland-gnome"
        );
        assert_eq!(
            classify_session(Some("wayland"), Some("wayland-0"), Some("ubuntu:GNOME")),
            "wayland-gnome"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn classify_session_gnome_only_matters_when_wayland_set() {
        assert_eq!(classify_session(None, None, Some("GNOME")), "other");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn classify_session_other_when_nothing_set() {
        assert_eq!(classify_session(None, None, None), "other");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn run_with_timeout_returns_success_status() {
        let mut command = std::process::Command::new("sh");
        command.arg("-c").arg("exit 0");
        let status = run_with_timeout(command, Duration::from_secs(5)).expect("expected status");
        assert!(status.success());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn run_with_timeout_returns_failure_status() {
        let mut command = std::process::Command::new("sh");
        command.arg("-c").arg("exit 3");
        let status = run_with_timeout(command, Duration::from_secs(5)).expect("expected status");
        assert!(!status.success());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn run_with_timeout_kills_and_reaps_on_timeout() {
        let mut command = std::process::Command::new("sh");
        command.arg("-c").arg("sleep 5");
        let start = std::time::Instant::now();
        let status = run_with_timeout(command, Duration::from_millis(100));
        let elapsed = start.elapsed();
        assert!(status.is_none());
        assert!(elapsed < Duration::from_secs(2), "elapsed: {elapsed:?}");
    }
}
