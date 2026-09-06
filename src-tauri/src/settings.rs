use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub const PASTE_MODES: [&str; 5] = ["auto", "ctrl_v", "ctrl_shift_v", "shift_insert", "clipboard_only"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub global_shortcuts_enabled: bool,
    pub shortcuts: ShortcutsSettings,
    pub audio_dir: String,
    pub audio_format: String,
    pub paste_mode: String,
    pub default_model: String,
    pub models_dir: Option<String>,
    pub indicator_recording_style: String,
    pub indicator_transcription_style: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            global_shortcuts_enabled: true,
            shortcuts: ShortcutsSettings::default(),
            audio_dir: String::new(),
            audio_format: "mp3".to_string(),
            paste_mode: "auto".to_string(),
            default_model: String::new(),
            models_dir: None,
            indicator_recording_style: "classic".to_string(),
            indicator_transcription_style: "classic".to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShortcutsSettings {
    pub voice_note: ShortcutConfig,
    pub record: ShortcutConfig,
}

impl Default for ShortcutsSettings {
    fn default() -> Self {
        Self {
            voice_note: ShortcutConfig {
                combo: Some(default_voice_note_combo().to_string()),
                trigger: "hold".to_string(),
                enabled: true,
            },
            record: ShortcutConfig::default(),
        }
    }
}

fn default_voice_note_combo() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "meta+shift+space"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "ctrl+shift+space"
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShortcutConfig {
    pub combo: Option<String>,
    pub trigger: String,
    pub enabled: bool,
}

impl Default for ShortcutConfig {
    fn default() -> Self {
        Self {
            combo: None,
            trigger: "hold".to_string(),
            enabled: false,
        }
    }
}

pub struct SettingsState {
    inner: Mutex<AppSettings>,
    warning: Mutex<Option<String>>,
}

impl SettingsState {
    pub fn load(app: &AppHandle) -> Result<SettingsState, String> {
        let path = settings_path(app)?;
        let (settings, warning) = load_from(&path);
        let state = SettingsState {
            inner: Mutex::new(settings.clone()),
            warning: Mutex::new(warning),
        };
        let _ = save_to(&path, &settings);
        Ok(state)
    }

    #[allow(dead_code)]
    pub fn warning(&self) -> Option<String> {
        self.warning.lock().expect("settings warning lock poisoned").clone()
    }
}

pub fn with_settings<T>(app: &AppHandle, f: impl FnOnce(&AppSettings) -> T) -> T {
    let state = app.state::<SettingsState>();
    let guard = state.inner.lock().expect("settings lock poisoned");
    f(&guard)
}

pub fn update_settings(
    app: &AppHandle,
    f: impl FnOnce(&mut AppSettings) -> Result<(), String>,
) -> Result<(), String> {
    let state = app.state::<SettingsState>();
    let before = {
        let guard = state.inner.lock().expect("settings lock poisoned");
        guard.clone()
    };
    let after = {
        let mut guard = state.inner.lock().expect("settings lock poisoned");
        f(&mut guard)?;
        guard.clone()
    };
    let path = settings_path(app)?;
    save_to(&path, &after)?;
    for field in diff_fields(&before, &after) {
        emit_settings_changed(app, &field);
    }
    Ok(())
}

fn emit_settings_changed(app: &AppHandle, field: &str) {
    let _ = app.emit("settings-changed", json!({ "field": field }));
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

fn resolved_defaults(data_dir: &Path) -> AppSettings {
    let mut settings = AppSettings::default();
    settings.audio_dir = data_dir.join("recordings").to_string_lossy().to_string();
    settings
}

fn load_from(path: &Path) -> (AppSettings, Option<String>) {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => {
            let data_dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
            return (resolved_defaults(&data_dir), None);
        }
    };
    match serde_json::from_str::<AppSettings>(&raw) {
        Ok(mut settings) => {
            if settings.audio_dir.is_empty() {
                if let Some(data_dir) = path.parent() {
                    settings.audio_dir = data_dir.join("recordings").to_string_lossy().to_string();
                }
            }
            (settings, None)
        }
        Err(e) => {
            let mut bak_name = path.as_os_str().to_os_string();
            bak_name.push(".bak");
            let _ = fs::copy(path, PathBuf::from(bak_name));
            let data_dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
            let warning = format!(
                "settings.json could not be parsed ({e}); a copy was saved to settings.json.bak and defaults were restored"
            );
            (resolved_defaults(&data_dir), Some(warning))
        }
    }
}

fn save_to(path: &Path, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not create settings directory: {e}"))?;
    }
    let data = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("could not serialize settings: {e}"))?;
    let mut tmp_name = path.as_os_str().to_os_string();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);
    fs::write(&tmp, data).map_err(|e| format!("could not write settings: {e}"))?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("could not save settings: {e}"));
    }
    Ok(())
}

fn diff_fields(before: &AppSettings, after: &AppSettings) -> Vec<&'static str> {
    let mut fields = Vec::new();
    if before.global_shortcuts_enabled != after.global_shortcuts_enabled {
        fields.push("globalShortcutsEnabled");
    }
    if before.shortcuts.voice_note != after.shortcuts.voice_note {
        fields.push("shortcuts.voiceNote");
    }
    if before.shortcuts.record != after.shortcuts.record {
        fields.push("shortcuts.record");
    }
    if before.audio_dir != after.audio_dir {
        fields.push("audioDir");
    }
    if before.audio_format != after.audio_format {
        fields.push("audioFormat");
    }
    if before.paste_mode != after.paste_mode {
        fields.push("pasteMode");
    }
    if before.default_model != after.default_model {
        fields.push("defaultModel");
    }
    if before.models_dir != after.models_dir {
        fields.push("modelsDir");
    }
    if before.indicator_recording_style != after.indicator_recording_style {
        fields.push("indicatorRecordingStyle");
    }
    if before.indicator_transcription_style != after.indicator_transcription_style {
        fields.push("indicatorTranscriptionStyle");
    }
    fields
}

pub fn validate_shortcut_action(action: &str) -> Result<(), String> {
    if action != "voiceNote" && action != "record" {
        return Err("action must be \"voiceNote\" or \"record\"".to_string());
    }
    Ok(())
}

pub fn validate_trigger(trigger: &str) -> Result<(), String> {
    if trigger != "hold" && trigger != "toggle" {
        return Err("trigger must be \"hold\" or \"toggle\"".to_string());
    }
    Ok(())
}

pub fn validate_audio_format(format: &str) -> Result<(), String> {
    if format != "mp3" && format != "wav" {
        return Err("audio format must be \"mp3\" or \"wav\"".to_string());
    }
    Ok(())
}

pub fn validate_paste_mode(mode: &str) -> Result<(), String> {
    if !PASTE_MODES.contains(&mode) {
        return Err(
            "paste mode must be one of: auto, ctrl_v, ctrl_shift_v, shift_insert, clipboard_only"
                .to_string(),
        );
    }
    Ok(())
}

pub fn validate_audio_dir(dir: &str) -> Result<PathBuf, String> {
    if dir.trim().is_empty() {
        return Err("audio dir must be an absolute path".to_string());
    }
    let path = PathBuf::from(dir);
    if !path.is_absolute() {
        return Err("audio dir must be an absolute path".to_string());
    }
    Ok(path)
}

fn probe_writable(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("could not create audio dir: {e}"))?;
    let probe = dir.join(".write");
    fs::write(&probe, b"").map_err(|e| format!("audio dir is not writable: {e}"))?;
    fs::remove_file(&probe).map_err(|e| format!("could not remove write probe in audio dir: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> AppSettings {
    with_settings(&app, |s| s.clone())
}

#[tauri::command]
pub fn set_shortcut(
    app: AppHandle,
    action: String,
    combo: Option<String>,
    trigger: Option<String>,
    enabled: Option<bool>,
) -> Result<(), String> {
    validate_shortcut_action(&action)?;
    if let Some(t) = &trigger {
        validate_trigger(t)?;
    }
    update_settings(&app, move |s| {
        let cfg = if action == "voiceNote" {
            &mut s.shortcuts.voice_note
        } else {
            &mut s.shortcuts.record
        };
        if let Some(c) = combo {
            if c.is_empty() {
                cfg.combo = None;
            } else {
                cfg.combo = Some(c);
            }
        }
        if let Some(t) = trigger {
            cfg.trigger = t;
        }
        if let Some(e) = enabled {
            cfg.enabled = e;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn set_global_shortcuts_enabled(app: AppHandle, enabled: bool) {
    let _ = update_settings(&app, move |s| {
        s.global_shortcuts_enabled = enabled;
        Ok(())
    });
}

#[tauri::command]
pub fn set_audio_dir(app: AppHandle, dir: String) -> Result<(), String> {
    let path = validate_audio_dir(&dir)?;
    probe_writable(&path)?;
    update_settings(&app, move |s| {
        s.audio_dir = dir;
        Ok(())
    })
}

#[tauri::command]
pub fn set_audio_format(app: AppHandle, format: String) -> Result<(), String> {
    validate_audio_format(&format)?;
    update_settings(&app, move |s| {
        s.audio_format = format;
        Ok(())
    })
}

#[tauri::command]
pub fn set_paste_mode(app: AppHandle, mode: String) -> Result<(), String> {
    validate_paste_mode(&mode)?;
    update_settings(&app, move |s| {
        s.paste_mode = mode;
        Ok(())
    })
}

#[tauri::command]
pub fn get_settings_warning(app: AppHandle) -> Option<String> {
    app.state::<SettingsState>().warning()
}

#[tauri::command]
pub fn set_indicator_style(app: AppHandle, kind: String, id: String) -> Result<(), String> {
    if kind != "recording" && kind != "transcription" {
        return Err("kind must be \"recording\" or \"transcription\"".to_string());
    }
    if id.trim().is_empty() {
        return Err("indicator style id must not be empty".to_string());
    }
    update_settings(&app, move |s| {
        if kind == "recording" {
            s.indicator_recording_style = id;
        } else {
            s.indicator_transcription_style = id;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip_save_load() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        save_to(&path, &AppSettings::default()).expect("save");
        let (loaded, warning) = load_from(&path);
        assert!(warning.is_none());
        let mut expected = AppSettings::default();
        expected.audio_dir = dir.path().join("recordings").to_string_lossy().to_string();
        assert_eq!(loaded, expected);
    }

    #[test]
    fn corrupt_file_backed_up_and_defaults_restored_with_warning() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        let corrupt = "this is not json {{{";
        fs::write(&path, corrupt).expect("write corrupt");
        let (loaded, warning) = load_from(&path);
        let bak = dir.path().join("settings.json.bak");
        assert!(bak.exists());
        assert_eq!(fs::read_to_string(&bak).expect("read bak"), corrupt);
        let mut expected = AppSettings::default();
        expected.audio_dir = dir.path().join("recordings").to_string_lossy().to_string();
        assert_eq!(loaded, expected);
        assert!(warning.is_some());
    }

    #[test]
    fn partial_json_loads_with_defaults_filling() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"audioFormat": "wav"}"#).expect("write partial");
        let (loaded, warning) = load_from(&path);
        assert!(warning.is_none());
        assert_eq!(loaded.audio_format, "wav");
        assert!(loaded.global_shortcuts_enabled);
        assert_eq!(
            loaded.shortcuts.voice_note.combo.as_deref(),
            Some(default_voice_note_combo())
        );
        assert_eq!(loaded.shortcuts.voice_note.trigger, "hold");
        assert!(loaded.shortcuts.voice_note.enabled);
        assert!(!loaded.shortcuts.record.enabled);
        assert_eq!(loaded.paste_mode, "auto");
        assert_eq!(loaded.models_dir, None);
    }

    #[test]
    fn setter_validation_rejects_bad_input() {
        assert!(validate_shortcut_action("voiceNote").is_ok());
        assert!(validate_shortcut_action("record").is_ok());
        assert!(validate_shortcut_action("nope").is_err());
        assert!(validate_trigger("hold").is_ok());
        assert!(validate_trigger("toggle").is_ok());
        assert!(validate_trigger("click").is_err());
        assert!(validate_audio_format("mp3").is_ok());
        assert!(validate_audio_format("wav").is_ok());
        assert!(validate_audio_format("flac").is_err());
        assert!(validate_paste_mode("auto").is_ok());
        assert!(validate_paste_mode("clipboard_only").is_ok());
        assert!(validate_paste_mode("magic").is_err());
        assert!(validate_audio_dir("relative/path").is_err());
        assert!(validate_audio_dir("").is_err());
        assert!(validate_audio_dir("/absolute/path").is_ok());
    }

    #[test]
    fn atomic_save_leaves_no_tmp_behind() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        save_to(&path, &AppSettings::default()).expect("save");
        let tmp = dir.path().join("settings.json.tmp");
        assert!(!tmp.exists());
        let raw = fs::read_to_string(&path).expect("read saved");
        serde_json::from_str::<AppSettings>(&raw).expect("saved file parses");
    }
}
