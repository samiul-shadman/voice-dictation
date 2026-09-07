# 11 — State, Settings & Cross-Window Sync

Milestone: M0 (settings authority) → evolves through M3/M5 · Files: `settings.rs`,
`lib/stores/settings.ts`, `lib/OverlaySync.tsx`, `lib/windows/overlay.ts`.

## 1. Single-authority settings (Rust)

`settings.json` at `<app_data>/settings.json` — pretty JSON,
`SettingsState(Mutex<AppSettings>)`, all mutations via `update()` (lock → closure →
save). Schema v3 (serde defaults everywhere, legacy keys ignored gracefully):

```jsonc
{
  "globalShortcutsEnabled": true,
  "shortcuts": {
    "voiceNote": { "combo": "ctrl+shift+space", "trigger": "hold", "enabled": true },
    "record":    { "combo": null,                "trigger": "hold", "enabled": false }
  },
  "audioDir": "<app_data>/recordings",
  "audioFormat": "mp3",
  "pasteMode": "auto",
  "defaultModel": "",
  "modelsDir": null,                       // null → <app_data>/models
  "indicatorRecordingStyle": "classic",
  "indicatorTranscriptionStyle": "classic"
}
```

**Durability fixes (v2 gotchas):**
- Atomic writes: temp file + rename — never truncate in place.
- On load failure: keep a `.bak` of the corrupt file before resetting to defaults +
  surface a warning line in Settings (v2 silently wiped user config).
- Forgiving field-level defaults (partial files load fine).

Commands: `get_settings` + per-field setters with validation (`set_shortcut {action,
combo?, trigger?, enabled?}`, `set_global_shortcuts_enabled`, `set_audio_dir`,
`set_audio_format`, `set_paste_mode`, `set_default_model`, `set_models_dir`,
`set_indicator_style`). Every setter emits `settings-changed {field}`.

## 2. Frontend stores (no state library)

- `stores/settings.ts`: loads once via `get_settings`, subscribes to
  `settings-changed`, exposes typed slices via `useSyncExternalStore` hooks
  (`useShortcutConfig()`, `useAudioPrefs()`, `usePasteMode()`, `useIndicatorStyles()`).
- Feature stores (hand-rolled singletons — v2 pattern kept): recorder, levels,
  transcriber (with the adoption rule, doc 07), downloads.
- Rule: **localStorage holds nothing another window needs.** Allowed only for
  single-window UI prefs (e.g., the gallery tab) — target: zero shared keys (v2's
  belt-and-braces localStorage mirroring is replaced by settings + re-push).

## 3. Overlay state protocol (the v2 #1 pain, formalized)

1. **Hydrate from authority** — every overlay, on mount, invokes `get_settings` for
   its persistent inputs (e.g., indicator styles) and starts its event listeners.
2. **Handshake** — the overlay emits `overlay-ready {label}` → main's `OverlaySync`
   component responds with `emitTo(label, …)` pushes of all transient state it owns
   (recording-state, current level, armed shortcut, active transcription).
3. **Adoption** — events are state-adoption signals (the transcriber store flips busy
   on any progress event with no active path; the backend guarantees 0 % as the first
   event).
4. Creation → ready → push, in that order. No lost-broadcast class of bugs.

`OverlaySync` (main window, invisible) owns steps 2–3 centrally — v2 scattered this
across per-feature sync components (`RecordingIndicatorSync`, payload duplication).

## 4. Events catalog

| Event | Producer | Consumers |
|---|---|---|
| `recording-state {recording, stopping}` | recorder.rs | all windows |
| `recording-level {level}` | recorder.rs | recording-indicator |
| `shortcut-armed / shortcut-disarmed` | shortcut engine (main) | indicator |
| `transcribe-progress {path, percent}` | transcriber.rs | all (adoption) |
| `transcribe-complete {path, text, modelId, durationMs, autoPaste, pasteError?}` | transcriber.rs | main, overlays |
| `transcribe-error {path, message}` | transcriber.rs | all |
| `model-download-progress / -done / -error / -cancelled` | downloader.rs | main |
| `indicator-style-changed {kind, id}` | setter | recording-indicator, main |
| `settings-changed {field}` | setters | all windows |
| `overlay-ready {label}` | overlays | OverlaySync (main) |

## 5. Command catalog (summary)

- recorder: `start_recording`, `stop_recording`, `cancel_recording`,
  `recording_state`, `list_recordings`, `delete_recording`, `read_recording`,
  `default_recordings_dir`
- transcriber: `transcribe_file`, `get_transcript`
- models: `list_models`, `download_model`, `cancel_download`, `delete_model`,
  `set_default_model`, `get_models_dir`, `set_models_dir`, `default_models_dir`
- settings: `get_settings` + setters (§1) + `get_settings_warning` (surfaces the
  corrupt-load `.bak` notice on the Settings page)
- sysinfo: `detect_environment`

## 6. Capabilities & windows

All three labels in `capabilities/default.json`; permissions: global-shortcut
register/unregister, core webview create, dialog, clipboard-manager, opener.
"Adding a window" checklist: doc 02 §6.

## Tasks

- [x] settings.rs schema + atomic save + .bak + settings-changed (+ unit tests
      including the corrupt-file .bak path)
- [x] settings store + typed hooks
- [x] OverlaySync + overlay-ready handshake (indicator, recording-indicator)
- [x] feature stores ported (recorder / levels / transcriber / downloads)
- [x] keep the events/commands tables in this file in sync with the code

## Verification

- Unit: settings round-trip; corrupt file → defaults + `.bak` exists; setter
  validation (absolute paths, catalog membership).
- Manual: change a style / audio dir in main → other windows reflect it without a
  restart; SIGKILL main mid-write → next boot has `.bak` + defaults + warning line.
