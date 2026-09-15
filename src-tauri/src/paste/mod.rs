use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::thread;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::settings::with_settings;
use crate::sysinfo;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "linux")]
use linux::{focused_window_is_terminal, paste_with_wtype};

const PASTE_DELAY: Duration = Duration::from_millis(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PasteMode {
    Auto,
    CtrlV,
    CtrlShiftV,
    ShiftInsert,
    ClipboardOnly,
}

impl PasteMode {
    pub(crate) fn parse(raw: &str) -> PasteMode {
        let normalized: String = raw
            .trim()
            .to_lowercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect();
        match normalized.as_str() {
            "auto" => PasteMode::Auto,
            "ctrlv" | "v" => PasteMode::CtrlV,
            "ctrlshiftv" | "shiftv" => PasteMode::CtrlShiftV,
            "shiftinsert" | "insert" => PasteMode::ShiftInsert,
            "clipboardonly" | "clipboard" | "clip" | "none" | "off" | "copy" => {
                PasteMode::ClipboardOnly
            }
            _ => PasteMode::Auto,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ComboPlan {
    CtrlV,
    CtrlShiftV,
    ShiftInsert,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    CmdV,
    #[cfg(target_os = "linux")]
    WtypeCtrlV,
    #[cfg(target_os = "linux")]
    WtypeCtrlShiftV,
    None,
}

fn session_is_wayland(session: &str) -> bool {
    session.starts_with("wayland")
}

pub(crate) fn resolve_combo(
    mode: &PasteMode,
    session: &str,
    is_terminal: Option<bool>,
) -> ComboPlan {
    let wayland = session_is_wayland(session);
    #[cfg(target_os = "macos")]
    {
        let _ = (wayland, is_terminal);
        match mode {
            PasteMode::ClipboardOnly => ComboPlan::None,
            _ => ComboPlan::CmdV,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        match mode {
            PasteMode::ClipboardOnly => ComboPlan::None,
            PasteMode::CtrlV => {
                if wayland {
                    #[cfg(target_os = "linux")]
                    {
                        ComboPlan::WtypeCtrlV
                    }
                    #[cfg(not(target_os = "linux"))]
                    {
                        ComboPlan::CtrlV
                    }
                } else {
                    ComboPlan::CtrlV
                }
            }
            PasteMode::CtrlShiftV => {
                if wayland {
                    #[cfg(target_os = "linux")]
                    {
                        ComboPlan::WtypeCtrlShiftV
                    }
                    #[cfg(not(target_os = "linux"))]
                    {
                        ComboPlan::CtrlShiftV
                    }
                } else {
                    ComboPlan::CtrlShiftV
                }
            }
            PasteMode::ShiftInsert => ComboPlan::ShiftInsert,
            PasteMode::Auto => {
                if wayland {
                    #[cfg(target_os = "linux")]
                    {
                        ComboPlan::WtypeCtrlV
                    }
                    #[cfg(not(target_os = "linux"))]
                    {
                        ComboPlan::CtrlV
                    }
                } else if cfg!(target_os = "linux") && is_terminal == Some(true) {
                    ComboPlan::CtrlShiftV
                } else {
                    ComboPlan::CtrlV
                }
            }
        }
    }
}

fn combo_label(combo: ComboPlan) -> &'static str {
    match combo {
        ComboPlan::CtrlV => "Ctrl+V",
        ComboPlan::CtrlShiftV => "Ctrl+Shift+V",
        ComboPlan::ShiftInsert => "Shift+Insert",
        ComboPlan::CmdV => "Cmd+V",
        #[cfg(target_os = "linux")]
        ComboPlan::WtypeCtrlV => "Ctrl+V",
        #[cfg(target_os = "linux")]
        ComboPlan::WtypeCtrlShiftV => "Ctrl+Shift+V",
        ComboPlan::None => "paste",
    }
}

pub fn paste_transcript(app: &AppHandle, text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }

    let clipboard_error = app
        .clipboard()
        .write_text(text)
        .err()
        .map(|e| format!("could not copy the transcript to the clipboard: {e}"));

    let mode = with_settings(app, |s| PasteMode::parse(&s.paste_mode));
    if mode == PasteMode::ClipboardOnly {
        return match clipboard_error {
            Some(error) => Err(error),
            None => Ok(()),
        };
    }

    // the global hotkey's key-up must propagate before the synthetic paste combo is injected
    thread::sleep(PASTE_DELAY);

    let session = sysinfo::cached_env(app).session_type;
    #[cfg(target_os = "linux")]
    let wayland = session_is_wayland(&session);

    #[cfg(target_os = "linux")]
    let is_terminal = if mode == PasteMode::Auto && !wayland {
        focused_window_is_terminal()
    } else {
        None
    };
    #[cfg(not(target_os = "linux"))]
    let is_terminal = None;

    let combo = resolve_combo(&mode, &session, is_terminal);

    let result = match combo {
        ComboPlan::None => Ok(()),
        #[cfg(target_os = "linux")]
        ComboPlan::ShiftInsert if wayland => Err(format!(
            "the shift_insert paste mode is not supported on Wayland (wtype cannot produce Shift+Insert); the text is on your clipboard — press {} manually, or choose Ctrl+V or Ctrl+Shift+V in the settings",
            combo_label(combo)
        )),
        ComboPlan::CtrlV | ComboPlan::CtrlShiftV | ComboPlan::ShiftInsert | ComboPlan::CmdV => {
            match synthesize_with_enigo(combo) {
                Ok(()) => Ok(()),
                Err(error) => Err(format!(
                    "{error}; the text is on your clipboard — press {} manually",
                    combo_label(combo)
                )),
            }
        }
        #[cfg(target_os = "linux")]
        ComboPlan::WtypeCtrlV | ComboPlan::WtypeCtrlShiftV => paste_with_wtype(combo, &session),
    };

    match (clipboard_error, result) {
        (Some(clipboard), Err(paste)) => Err(format!("{clipboard}; {paste}")),
        (_, result) => result,
    }
}

fn synthesize_with_enigo(combo: ComboPlan) -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("could not prepare synthetic keyboard input: {e}"))?;
    let chain: &[(Key, Direction)] = match combo {
        ComboPlan::CtrlV => &[
            (Key::Control, Direction::Press),
            (Key::Unicode('v'), Direction::Click),
            (Key::Control, Direction::Release),
        ],
        ComboPlan::CtrlShiftV => &[
            (Key::Control, Direction::Press),
            (Key::Shift, Direction::Press),
            (Key::Unicode('v'), Direction::Click),
            (Key::Shift, Direction::Release),
            (Key::Control, Direction::Release),
        ],
        ComboPlan::ShiftInsert => &[
            (Key::Shift, Direction::Press),
            (Key::Insert, Direction::Click),
            (Key::Shift, Direction::Release),
        ],
        ComboPlan::CmdV => &[
            (Key::Meta, Direction::Press),
            (Key::Unicode('v'), Direction::Click),
            (Key::Meta, Direction::Release),
        ],
        #[cfg(target_os = "linux")]
        ComboPlan::WtypeCtrlV | ComboPlan::WtypeCtrlShiftV => {
            return Err(
                "internal error: wayland-only paste combo reached the synthesis path".to_string(),
            )
        }
        ComboPlan::None => {
            return Err(
                "internal error: clipboard-only paste reached the synthesis path".to_string(),
            )
        }
    };
    let mut first_error = None;
    for (key, direction) in chain {
        if let Err(e) = enigo.key(*key, *direction) {
            if first_error.is_none() {
                first_error = Some(format!("synthetic paste failed: {e}"));
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(all(test, target_os = "linux"))]
mod combo_tests {
    use super::*;

    #[test]
    fn combo_resolution_matrix_auto() {
        assert_eq!(
            resolve_combo(&PasteMode::Auto, "x11", Some(true)),
            ComboPlan::CtrlShiftV
        );
        assert_eq!(
            resolve_combo(&PasteMode::Auto, "x11", Some(false)),
            ComboPlan::CtrlV
        );
        assert_eq!(
            resolve_combo(&PasteMode::Auto, "x11", None),
            ComboPlan::CtrlV
        );
        assert_eq!(
            resolve_combo(&PasteMode::Auto, "other", Some(true)),
            ComboPlan::CtrlShiftV
        );
        assert_eq!(
            resolve_combo(&PasteMode::Auto, "wayland-wlroots", Some(true)),
            ComboPlan::WtypeCtrlV
        );
        assert_eq!(
            resolve_combo(&PasteMode::Auto, "wayland-gnome", None),
            ComboPlan::WtypeCtrlV
        );
    }

    #[test]
    fn combo_resolution_matrix_explicit_modes() {
        assert_eq!(
            resolve_combo(&PasteMode::CtrlV, "x11", None),
            ComboPlan::CtrlV
        );
        assert_eq!(
            resolve_combo(&PasteMode::CtrlV, "other", None),
            ComboPlan::CtrlV
        );
        assert_eq!(
            resolve_combo(&PasteMode::CtrlV, "wayland-wlroots", None),
            ComboPlan::WtypeCtrlV
        );
        assert_eq!(
            resolve_combo(&PasteMode::CtrlShiftV, "x11", None),
            ComboPlan::CtrlShiftV
        );
        assert_eq!(
            resolve_combo(&PasteMode::CtrlShiftV, "wayland-wlroots", None),
            ComboPlan::WtypeCtrlShiftV
        );
        assert_eq!(
            resolve_combo(&PasteMode::CtrlShiftV, "wayland-gnome", None),
            ComboPlan::WtypeCtrlShiftV
        );
        assert_eq!(
            resolve_combo(&PasteMode::ShiftInsert, "x11", None),
            ComboPlan::ShiftInsert
        );
        assert_eq!(
            resolve_combo(&PasteMode::ShiftInsert, "wayland-gnome", None),
            ComboPlan::ShiftInsert
        );
        assert_eq!(
            resolve_combo(&PasteMode::ClipboardOnly, "x11", None),
            ComboPlan::None
        );
        assert_eq!(
            resolve_combo(&PasteMode::ClipboardOnly, "wayland-wlroots", None),
            ComboPlan::None
        );
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_combo_tests {
    use super::*;

    #[test]
    fn macos_resolves_every_paste_delivery_to_cmd_v() {
        for mode in [
            PasteMode::Auto,
            PasteMode::CtrlV,
            PasteMode::CtrlShiftV,
            PasteMode::ShiftInsert,
        ] {
            assert_eq!(
                resolve_combo(&mode, "native", None),
                ComboPlan::CmdV,
                "mode {mode:?}"
            );
        }
        assert_eq!(
            resolve_combo(&PasteMode::ClipboardOnly, "native", None),
            ComboPlan::None
        );
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_combo_tests {
    use super::*;

    #[test]
    fn windows_resolves_auto_to_ctrl_v_without_terminal_detection() {
        assert_eq!(
            resolve_combo(&PasteMode::Auto, "native", Some(true)),
            ComboPlan::CtrlV
        );
        assert_eq!(
            resolve_combo(&PasteMode::CtrlShiftV, "native", None),
            ComboPlan::CtrlShiftV
        );
        assert_eq!(
            resolve_combo(&PasteMode::ShiftInsert, "native", None),
            ComboPlan::ShiftInsert
        );
        assert_eq!(
            resolve_combo(&PasteMode::ClipboardOnly, "native", None),
            ComboPlan::None
        );
    }
}
