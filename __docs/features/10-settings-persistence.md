# 10 — Settings & Persistence

## What it does

Settings are split across **two layers** with different ownership:

### Layer 1: Rust settings file (`src-tauri/src/settings.rs`)

Pretty JSON at `<app_data_dir>/settings.json`. Managed state
`SettingsState(Mutex<AppSettings>)`, created in `setup` (`lib.rs:39-43`). All mutations
go through `update()` (lock → apply closure → save while holding the lock).

| Setting | Key | Default | Validated by |
|---|---|---|---|
| Default STT model | `defaultModel` | `""` (empty = auto-pick by `PREFERENCE_ORDER`) | `set_default_model` — must exist in catalog, not mid-download |
| Models directory | `modelsDir` | omitted → `<app_data>/models` | `set_models_dir` — absolute, created + `.write_test` probe, blocked during downloads |
| Paste mode | `pasteMode` | omitted → `auto` | `set_paste_mode` via `PasteMode::parse` |

Commands: `get_settings`, `set_default_model`, `set_paste_mode`, `get_models_dir`,
`get_default_models_dir`, `set_models_dir`.

**Loading is forgiving**: missing file, unreadable dir, or **corrupt JSON all silently
reset to defaults** (`settings.rs:44-61`). Legacy files without newer keys load fine
(`serde(default)` + tests).

### Layer 2: Webview localStorage (frontend)

| Setting | Key | Module |
|---|---|---|
| Shortcut definitions (combo, text, enabled, scope, trigger) | `settings:shortcuts` | `shortcuts.ts` |
| Global-shortcut master switch | `settings:global-enabled` | `shortcuts.ts` |
| Recording destination dir | `settings:audio-dir` | `audio.ts` |
| Recording format (mp3/wav) | `settings:audio-format` | `audio.ts` |
| Indicator style selections | `indicator:recording-style`, `indicator:transcription-style` | `indicatorStyle.ts` |
| Indicator payload snapshot | `indicator:payload` | `indicator.ts` |
| Output log (last 200) | `output:log` | `output.ts` |
| Models page filter prefs | `models:tab/search/engine/sort` | `ModelsPage.tsx` |

## UI / UX (`/settings`, `src/pages/SettingsPage.tsx`)

Left-aligned column of section blocks (`.settings-section` in `settings.css`):
In-app shortcuts, Global shortcuts (+ master enable + registration-failure status),
Output window (Open/Clear), **Auto-paste** radio group (5 modes with per-option hints,
Wayland caveat documented in-UI), **Speech model** (current default model name, models
folder path with Custom/Default badge, "Manage models" → `/models`).

## Gotchas

1. **Silent settings corruption reset** — a partial write (crash during save) wipes
   user config to defaults with no backup and no warning.
2. **Split-brain persistence** — recording dir/format and all shortcut config live in
   the main window's localStorage, not settings.json; the Rust side never sees them.
   Only `defaultModel`/`modelsDir`/`pasteMode` are authoritative in Rust. This means
   clearing webview storage silently resets shortcuts/recording prefs.
3. Overlay windows *read* some of the main window's localStorage keys (indicator
   payload/styles) — see docs 02/08/09 for the sharing-assumption caveats.
4. Two model-dir resolution paths: in-memory state vs re-reading settings.json from
   disk (`models.rs:259-302` vs `settings.rs:136-163`) — kept in sync only by discipline.

## Difficulties & mitigations (from git `4dfe4c5`, `dcffbe6`, `12945d9`)

| Difficulty | Evidence | Mitigation |
|---|---|---|
| Config surfaces multiplied (capabilities, Cargo.toml, settings.json, localStorage) | recurring edits across commits | document ownership per setting (this doc); consider migrating shortcut/indicator selections into settings.json for a single authority |
| Bad custom dir could break downloads | `.write_test` probe + absolute-path check + download-lockout | keep validation; surface the error in UI (done via `settings-hint` styles) |
| Corrupt-JSON wipe risk | forgiving loader resets to defaults | write settings atomically (temp file + rename) and keep a `.bak` of the last good copy |
