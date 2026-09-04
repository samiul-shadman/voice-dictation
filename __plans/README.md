# __plans — Voice Dictation App (v3) Build Plan

Planning documents for a from-scratch, Linux-first **voice dictation app** built on
**Tauri 2 + React 19**. The build distills the v2 post-mortem in `__docs/features/`
into a focused, single-purpose product.

> Product in one line: hold or toggle a global hotkey anywhere in the OS → audio is
> recorded via `ffmpeg` → transcribed locally with NVIDIA **Parakeet** → the transcript
> is **auto-pasted** into whatever app was focused.

## Scope decisions (deltas vs the v2 app)

| v2 had | v3 decision | Rationale |
|---|---|---|
| App-scope + global shortcut scopes | **Global only** | Dictation must work outside the app |
| 3 actions (print / record / voice-note) | **2 actions: record, voice-note** | No print action; no Output log window |
| Whisper (9) + Parakeet (2) model catalog | **Parakeet only (2 models)** | One engine, one build path, less risk |
| Settings split: Rust JSON + localStorage | **Rust settings.json is the single authority** | Kills v2's split-brain + lost-broadcast bugs |
| Output window, legacy todo/form pages | **Removed** | Focused product |
| `window.confirm` for deletes | **In-app ConfirmDialog** | Consistency with dialog plugin |

## Documents

| File | Module | Milestone |
|---|---|---|
| [00-master-plan.md](00-master-plan.md) | Vision, stack, invariants, repo layout | — |
| [01-design-system.md](01-design-system.md) | Design tokens + UI kit (modern dark) | M0 |
| [02-app-shell.md](02-app-shell.md) | Windows, routing, navigation, overlay bootstrap | M0 |
| [03-module-shortcuts.md](03-module-shortcuts.md) | Global shortcuts (toggle / hold) | M3 |
| [04-module-indicator.md](04-module-indicator.md) | Shortcut indicator pill overlay | M3 |
| [05-module-recording.md](05-module-recording.md) | ffmpeg recorder + level metering | M1 |
| [06-module-library.md](06-module-library.md) | Audio library + exclusive playback | M1 |
| [07-module-voice-note.md](07-module-voice-note.md) | Record → transcribe → sidecar pipeline | M2/M4 |
| [08-module-parakeet.md](08-module-parakeet.md) | Parakeet-only models, downloads, ONNX patch | M2 |
| [09-module-auto-paste.md](09-module-auto-paste.md) | Paste engine, terminal detection, Wayland | M4 |
| [10-module-animations.md](10-module-animations.md) | Indicator animation gallery + selection | M5 |
| [11-state-and-settings.md](11-state-and-settings.md) | Single-authority settings + cross-window sync | M0 |
| [12-roadmap.md](12-roadmap.md) | Milestones, testing, risks, definition of done | — |

## Build order

M0 scaffold + design system → M1 record & library → M2 Parakeet transcription →
M3 global shortcuts + overlays → M4 auto-paste + voice-note end-to-end →
M5 animation gallery + polish + packaging.

## How to use these plans

- Each module plan follows the same shape: **Goal → UX spec → Architecture →
  Tasks → Pitfalls (v2 lessons) → Verification**.
- Read `00` (invariants) and `11` (state protocol) before any module work.
- Follow `12` milestone order; tick tasks in the file as they land and push after
  every milestone (the v2 repo lost 10 unpushed commits' worth of safety).
