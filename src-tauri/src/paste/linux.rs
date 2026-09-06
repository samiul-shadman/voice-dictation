use serde::Deserialize;
use std::io::ErrorKind;
use std::process::Command;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};

use super::{combo_label, ComboPlan};

const WTYPE_EXTRA_DELAY: Duration = Duration::from_millis(150);
const TERMINALS_TOML: &str = include_str!("../terminals.toml");
const FALLBACK_HEURISTICS: [&str; 7] = [
    "terminal",
    "konsole",
    "xterm",
    "alacritty",
    "wezterm",
    "ghostty",
    "kitty",
];

pub(crate) fn paste_with_wtype(combo: ComboPlan, session: &str) -> Result<(), String> {
    if session == "wayland-gnome" {
        return Err(format!(
            "GNOME Wayland restricts synthetic input; the text is on your clipboard — press {} manually",
            combo_label(combo)
        ));
    }
    // extra settle time on top of PASTE_DELAY so the compositor delivers the clipboard before wtype injects keys
    thread::sleep(WTYPE_EXTRA_DELAY);
    match Command::new("wtype").args(wtype_args(combo)).output() {
        Err(e) if e.kind() == ErrorKind::NotFound => Err(format!(
            "wtype is required for synthetic paste on Wayland — install it (apt install wtype / pacman -S wtype); the text is on your clipboard — press {} manually",
            combo_label(combo)
        )),
        Err(e) => Err(format!(
            "could not run wtype ({e}); the text is on your clipboard — press {} manually",
            combo_label(combo)
        )),
        Ok(output) if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            Err(format!(
                "wtype failed to inject the paste keystroke{} — install wtype if it is missing (apt install wtype / pacman -S wtype); the text is on your clipboard — press {} manually",
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!(" ({stderr})")
                },
                combo_label(combo)
            ))
        }
        Ok(_) => Ok(()),
    }
}

pub(crate) fn wtype_args(combo: ComboPlan) -> &'static [&'static str] {
    match combo {
        ComboPlan::WtypeCtrlV => &["-M", "ctrl", "-k", "v", "-m", "ctrl"],
        ComboPlan::WtypeCtrlShiftV => &[
            "-M", "ctrl", "-M", "shift", "-k", "v", "-m", "shift", "-m", "ctrl",
        ],
        _ => &[],
    }
}

pub(crate) fn focused_window_is_terminal() -> Option<bool> {
    let (conn, screen_index) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen_index)?.root;
    let net_active_window = conn
        .intern_atom(false, b"_NET_ACTIVE_WINDOW")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let active = conn
        .get_property(false, root, net_active_window, AtomEnum::WINDOW, 0, 1)
        .ok()?
        .reply()
        .ok()?;
    let window = active.value32()?.next()?;
    if window == 0 {
        return None;
    }
    let wm_class = conn
        .get_property(false, window, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 1024)
        .ok()?
        .reply()
        .ok()?;
    let (instance, class) = parse_wm_class(&wm_class.value)?;
    Some(wm_class_is_terminal(
        &instance,
        &class,
        builtin_terminal_list(),
    ))
}

fn parse_wm_class(raw: &[u8]) -> Option<(String, String)> {
    let instance_end = raw.iter().position(|&byte| byte == 0)?;
    let instance = String::from_utf8_lossy(&raw[..instance_end]).into_owned();
    let class_bytes = &raw[instance_end + 1..];
    let class_end = class_bytes
        .iter()
        .position(|&byte| byte == 0)
        .unwrap_or(class_bytes.len());
    let class = String::from_utf8_lossy(&class_bytes[..class_end]).into_owned();
    let class = if class.is_empty() {
        instance.clone()
    } else {
        class
    };
    if instance.is_empty() && class.is_empty() {
        return None;
    }
    Some((instance, class))
}

#[derive(Debug, Clone, Default, Deserialize)]
struct TerminalList {
    #[serde(default)]
    exact: Vec<String>,
    #[serde(default)]
    substrings: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct TerminalFile {
    #[serde(default)]
    terminals: TerminalList,
}

fn parse_terminal_list(source: &str) -> Result<TerminalList, String> {
    toml::from_str::<TerminalFile>(source)
        .map(|file| file.terminals)
        .map_err(|e| format!("could not parse terminals.toml: {e}"))
}

fn builtin_terminal_list() -> &'static TerminalList {
    static LIST: OnceLock<TerminalList> = OnceLock::new();
    LIST.get_or_init(|| {
        parse_terminal_list(TERMINALS_TOML).unwrap_or(TerminalList {
            substrings: FALLBACK_HEURISTICS
                .iter()
                .map(|entry| entry.to_string())
                .collect(),
            ..TerminalList::default()
        })
    })
}

fn wm_class_is_terminal(instance: &str, class: &str, list: &TerminalList) -> bool {
    for candidate in [instance, class] {
        let candidate = candidate.to_lowercase();
        if list
            .exact
            .iter()
            .any(|entry| entry.to_lowercase() == candidate)
        {
            return true;
        }
        if list
            .substrings
            .iter()
            .any(|entry| candidate.contains(&entry.to_lowercase()))
        {
            return true;
        }
        if FALLBACK_HEURISTICS.iter().any(|entry| candidate.contains(entry)) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wtype_args_match_the_wtype_dsl() {
        assert_eq!(
            wtype_args(ComboPlan::WtypeCtrlV),
            &["-M", "ctrl", "-k", "v", "-m", "ctrl"]
        );
        assert_eq!(
            wtype_args(ComboPlan::WtypeCtrlShiftV),
            &[
                "-M", "ctrl", "-M", "shift", "-k", "v", "-m", "shift", "-m", "ctrl"
            ]
        );
        assert_eq!(wtype_args(ComboPlan::CtrlV), &[] as &[&str]);
    }

    #[test]
    fn wm_class_raw_bytes_are_split_into_instance_and_class() {
        assert_eq!(
            parse_wm_class(b"kitty\0kitty\0"),
            Some(("kitty".to_string(), "kitty".to_string()))
        );
        assert_eq!(
            parse_wm_class(b"st-256color\0st\0"),
            Some(("st-256color".to_string(), "st".to_string()))
        );
        assert_eq!(
            parse_wm_class(b"gnome-terminal\0gnome-terminal-server\0"),
            Some((
                "gnome-terminal".to_string(),
                "gnome-terminal-server".to_string()
            ))
        );
    }

    #[test]
    fn wm_class_handles_trailing_nuls_and_padding() {
        assert_eq!(
            parse_wm_class(b"kitty\0kitty\0\0\0\0"),
            Some(("kitty".to_string(), "kitty".to_string()))
        );
        assert_eq!(
            parse_wm_class(b"foot\0"),
            Some(("foot".to_string(), "foot".to_string()))
        );
        assert_eq!(
            parse_wm_class(b"foot\0\0"),
            Some(("foot".to_string(), "foot".to_string()))
        );
    }

    #[test]
    fn wm_class_rejects_empty_and_garbage_input() {
        assert_eq!(parse_wm_class(b""), None);
        assert_eq!(parse_wm_class(b"\0\0\0"), None);
        assert_eq!(parse_wm_class(b"no nul terminator"), None);
        assert_eq!(parse_wm_class(b"\x01\x02garbage\x7f"), None);
    }

    #[test]
    fn wm_class_interior_nuls_stop_the_class_string() {
        assert_eq!(
            parse_wm_class(b"inst\0cla\0ss\0"),
            Some(("inst".to_string(), "cla".to_string()))
        );
        assert_eq!(
            parse_wm_class(b"\0classonly\0"),
            Some(("".to_string(), "classonly".to_string()))
        );
    }

    #[test]
    fn bundled_terminal_list_parses() {
        let list = parse_terminal_list(TERMINALS_TOML).expect("bundled terminals.toml parses");
        assert!(list.exact.contains(&"kitty".to_string()));
        assert!(list.exact.contains(&"Alacritty".to_string()));
        assert!(list.exact.contains(&"org.wezfurlong.wezterm".to_string()));
        assert!(list.exact.contains(&"xfce4-terminal".to_string()));
        assert!(list.substrings.contains(&"terminal".to_string()));
        assert!(list.substrings.contains(&"ghostty".to_string()));
    }

    #[test]
    fn terminal_list_matching_exact_case_insensitive_and_substring() {
        let list = parse_terminal_list(TERMINALS_TOML).expect("bundled terminals.toml parses");
        assert!(wm_class_is_terminal("kitty", "kitty", &list));
        assert!(wm_class_is_terminal("KITTY", "KITTY", &list));
        assert!(wm_class_is_terminal("st", "st-256color", &list));
        assert!(wm_class_is_terminal("urxvt", "URxvt", &list));
        assert!(wm_class_is_terminal(
            "org.wezfurlong.wezterm",
            "wezterm",
            &list
        ));
        assert!(wm_class_is_terminal("steam", "Gnome-terminal", &list));
        assert!(wm_class_is_terminal("unknown-app", "MyTerminalEmulator", &list));
        assert!(wm_class_is_terminal("some-kitty-fork", "custom", &list));
        assert!(wm_class_is_terminal("custom", "xfce4-terminal", &list));
    }

    #[test]
    fn non_terminal_windows_do_not_match() {
        let list = parse_terminal_list(TERMINALS_TOML).expect("bundled terminals.toml parses");
        assert!(!wm_class_is_terminal("firefox", "firefox", &list));
        assert!(!wm_class_is_terminal("code", "Code", &list));
        assert!(!wm_class_is_terminal("org.gnome.Nautilus", "Nautilus", &list));
        assert!(!wm_class_is_terminal("godot", "Godot_Engine", &list));
    }

    #[test]
    fn hardcoded_heuristics_catch_entries_missing_from_the_list() {
        let list = TerminalList::default();
        assert!(!wm_class_is_terminal("firefox", "firefox", &list));
        assert!(wm_class_is_terminal("unknown", "NotInList-terminal-app", &list));
        assert!(wm_class_is_terminal("alacritty-x11", "unknown", &list));
        assert!(wm_class_is_terminal("wezterm-gui", "unknown", &list));

        let fallback = TerminalList {
            substrings: FALLBACK_HEURISTICS
                .iter()
                .map(|entry| entry.to_string())
                .collect(),
            ..TerminalList::default()
        };
        assert!(wm_class_is_terminal("anything", "konsole", &fallback));
        assert!(!wm_class_is_terminal("anything", "st", &fallback));
    }

    #[test]
    fn custom_terminal_lists_are_supported() {
        let custom = parse_terminal_list("[terminals]\nexact = [\"Foo\"]\nsubstrings = [\"bar\"]\n")
            .expect("custom list parses");
        assert_eq!(custom.exact, vec!["Foo".to_string()]);
        assert_eq!(custom.substrings, vec!["bar".to_string()]);
        assert!(wm_class_is_terminal("foo", "foo", &custom));
        assert!(wm_class_is_terminal("x", "a-barc", &custom));
    }

    #[test]
    fn broken_terminal_lists_are_rejected() {
        assert!(parse_terminal_list("not [valid toml").is_err());
    }
}
