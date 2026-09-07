# 12 — Roadmap, Testing & Risks

## Milestone plan

### M0 — Foundation & design system

Scope: Tauri 2 + React 19 + Vite scaffold; Tailwind v4 + tokens + UI kit (doc 01);
sidebar shell + HashRouter routing (doc 02); `settings.rs` (schema, atomic save,
.bak, settings-changed — doc 11); settings store; `sysinfo.rs`
`detect_environment` stub (ffmpeg / session type); capabilities for 3 labels;
`data-window` CSS scoping; self-hosted fonts.

Accept: boots to the dark shell; settings file created; ffmpeg-missing card renders
when the dep is absent; `cargo test` + `npm run build` green. **Push to origin.**

### M1 — Record & library

Scope: `recorder.rs` (levels, stopping-flag stop, confined read, tests — doc 05);
recorder store; RecordPage (FAB, format, destination, toasts); audioPlayback +
AudioPlayer (blob + base64 fallback); LibraryPage (rows, exclusive playback,
ConfirmDialog delete, refresh triggers — doc 06); TranscriptPanel shell.

Accept: record mp3/wav → appears in the library → plays exclusively → deletes safely;
level ring animates; missing-ffmpeg path verified. **Push.**

### M2 — Parakeet transcription

Scope: `models.rs` catalog + manifest-aware integrity; `downloader.rs` (+timeouts,
cancel-restart test); `patch_parakeet_decoder` + manifest writer; ModelsPage (2
cards); models-dir settings; `transcriber.rs` (busy / catch_unwind / engine cache /
progress) + `parakeet_engine.rs` (pinned config, tail padding, token pre-check,
regression test — doc 07); sidecars + `get_transcript`; full TranscriptPanel
(copy / re-transcribe); library Transcribe wiring.

Accept: download v2 (cancel/restart clean) → set default → transcribe → panel shows
text; corrupt tokens → friendly error; regression tests green. **Push.**

### M3 — Global shortcuts & overlays

Scope: canonical / engine / hold (+ tests — doc 03); ShortcutsPage (2 cards, capture,
trigger, statuses); `shortcut-armed / -disarmed`; indicator overlay (doc 04);
recording-indicator overlay + OverlaySync handshake; classic recording pill.

Accept: hold + toggle for both actions, globally; statuses honest (grabbed-key error
path); overlay handshake survives "emit before show"; click-through verified. **Push.**

### M4 — Auto-paste & voice-note end-to-end

Scope: `paste.rs` full (5 modes, terminal detection + terminals.toml, Wayland tiers,
ported tests — doc 09); SettingsPage auto-paste section + session banner; voice-note
wiring (toggle + hold) → paste; completion / pasteError toasts; indicator phase
hand-off.

Accept: E2E on X11: hotkey → speak → release → text in the focused app within ~1 s of
engine completion; terminal auto-mode correct; clipboard_only safe path; wlroots with
/ without wtype; GNOME Wayland clipboard-only with an honest banner. **Push.**

### M5 — Animation gallery & polish

Scope: full 10 + 10 gallery + selection sync (doc 10); reduced-motion; empty/error
state audit; typography/icon polish; packaging (.deb + AppImage); README rewrite; CI
(Rust tests on a Linux X11 image + TS vitest); push discipline maintained.

Accept: live style swap on the overlay; every style fits the overlay (screenshot
sweep); packages install; CI green. **Push.**

## Test strategy

- **Rust unit tests (port the v2 suites):** `paste.rs` (aliases, WM_CLASS parsing,
  combos) · `transcripts.rs` (round-trip) · `recorder.rs` (meta, allowlist, refusal
  rules, sidecar removal) · `parakeet_engine.rs` (pinned config snapshot) ·
  `models.rs` / `downloader.rs` (integrity, patch, guards, cancel-restart) ·
  `settings.rs` (corrupt → .bak).
- **TS vitest:** canonical fixtures · hold-machine timing (fake timers) · engine
  diff-sync (fake plugin API) · registry fallback · playback registry.
- **Manual matrix:** X11 (full) · wlroots-Wayland with / without wtype · GNOME Wayland
  (clipboard-only) · multi-monitor positioning · hotkey grabbed by another app ·
  SIGKILL mid-operation recovery.
- **Startup detection UX:** every hard-dep failure has a card naming the fix.

## Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| sherpa FFI aborts the process | app dies mid-dictation | validate-before-FFI; pinned `nemo_transducer` + regression test; token pre-check |
| Native build fights (libclang, prebuilt binaries) | blocked builds | pin `sherpa-rs` exactly; record the matching sherpa-onnx binary; CI clean build |
| HF upstream drift (URLs / sizes / metadata) | broken downloads | pinned URLs; exact-size + patched-size manifest; documented re-verification step |
| Webview quirks (@property, SVG var stops, blob URLs) | broken visuals / playback | documented conventions (doc 10) + base64 fallback |
| Wayland input tiers | degraded paste | honest session banners + the clipboard-first invariant |
| Capabilities / config churn | setup friction | adding-a-window checklist; per-window capability split if needed |
| Scope creep toward v2 parity | delay | the deltas table in doc 00 is authoritative |
| Main-window lifetime owns hotkeys | hotkeys die if closed | v1: closing the window exits the app (documented); tray/daemon logged as follow-up |

## Definition of done (per module)

- Code + the unit tests named in the module's Verification section.
- UX states designed: empty / loading / error / disabled.
- Each Pitfalls item addressed or explicitly accepted (with a comment).
- Docs updated (this plans dir) and the work pushed to origin.
