# Feature Documentation — tauri-todo-react

> **Name is misleading.** Despite the repo name, this is **not a todo app**. It is a
> **Linux-first voice-dictation / voice-notes desktop app** built on Tauri 2 + React 19:
> hold a global hotkey anywhere in the OS → audio is recorded via `ffmpeg` → transcribed
> locally (Whisper or NVIDIA Parakeet) → the transcript is auto-pasted into whatever app
> was focused. The original "todo/form/print" scaffold survives as legacy pages.

## Module map

The codebase divides into these feature modules. Each has its own doc:

| # | Doc | Feature | Frontend | Backend |
|---|-----|---------|----------|---------|
| 01 | [global-shortcuts.md](01-global-shortcuts.md) | Global + in-app shortcut system, hold vs toggle | `src/lib/shortcuts.ts`, `src/lib/globalShortcuts.ts`, `hooks/*` | `tauri-plugin-global-shortcut` (Rust hosts only) |
| 02 | [shortcut-indicator-overlay.md](02-shortcut-indicator-overlay.md) | Floating pill showing held shortcut + output log window | `src/lib/indicator.ts`, `output.ts`, `IndicatorPage`, `OutputPage` | window capabilities |
| 03 | [audio-recording.md](03-audio-recording.md) | ffmpeg-based recorder, mic level metering, blob playback | `src/lib/audio.ts`, `recordingHold.ts`, `recordingLevel.ts` | `src-tauri/src/recorder.rs` |
| 04 | [audio-library.md](04-audio-library.md) | Recording library, delete, exclusive playback | `AudioLibraryPage`, `AudioPlayer`, `audioPlayback.ts` | `recorder.rs` (list/delete/read) |
| 05 | [voice-note-transcription.md](05-voice-note-transcription.md) | Record→transcribe hotkey, transcript sidecars | `src/lib/voiceNote.ts`, `transcriber.ts`, `TranscriptPanel` | `transcriber.rs`, `transcripts.rs`, `engines/*` |
| 06 | [speech-models.md](06-speech-models.md) | Model catalog, downloads, custom dir, ONNX patching | `ModelsPage`, `src/lib/models.ts` | `models.rs`, `downloader.rs`, `settings.rs` |
| 07 | [auto-paste.md](07-auto-paste.md) | Auto-paste transcripts, terminal detection, Wayland | Settings page paste-mode radios | `src-tauri/src/paste.rs` |
| 08 | [indicator-animations.md](08-indicator-animations.md) | Recording/transcription overlay + 13+13 animation styles | `RecordingPill`, `animationRegistry.tsx`, `indicatorStyle.ts` | overlay window capability |
| 09 | [multi-window-architecture.md](09-multi-window-architecture.md) | 4 webviews / 1 bundle, cross-window state sync | `App.tsx`, `main.tsx`, all overlay libs | capabilities, event bus |
| 10 | [settings-persistence.md](10-settings-persistence.md) | Where every setting lives (Rust JSON vs localStorage) | `settings.css` pages | `settings.rs` |
| 11 | [legacy-scaffolding.md](11-legacy-scaffolding.md) | Leftover todo/form/greet demo code | `HomePage`, `FormPage` | `greet`, `print_form` |
| 12 | [git-history-lessons.md](git-history-lessons.md) | Difficulties hit during implementation + mitigations | — | — |

## Feature-flag / module boundaries

The app has **no runtime feature-flag system**. Features are separated by module
boundaries that could be turned into flags if needed:

- **`parakeet` cargo feature** (`src-tauri/Cargo.toml:35-39`) — was a real opt-in flag
  gating `sherpa-rs`; commit `65215df` made sherpa always-on and left the feature as an
  empty `parakeet = []` stub for compatibility. The sherpa engine is now unconditional.
- **Window-label modules** — each overlay (output / indicator / recording-indicator) is
  created lazily from the frontend (`WebviewWindow`) and branched in `App.tsx` by label.
  Removing a feature = remove its lib module, page branch, and capability entry.
- **Action-based shortcuts** — `Shortcut.action ∈ {print, record, voice-note}` is the
  closest thing to per-feature routing; recording and voice-note are independent actions
  that share the recorder module.
- **Suggested flag surface** if you want to formalize: `recorder`, `voice-note`,
  `auto-paste`, `indicator-overlay`, `shortcut-indicator`, `output-window`,
  `animations-gallery`, `parakeet`, `whisper`.

## Cross-cutting invariants (read first)

1. **Clipboard-first paste** — the transcript is always written to the clipboard before
   any keystroke injection; every downstream failure degrades to "paste manually".
2. **Push-on-show state sync** — events emitted to an overlay before it exists are lost;
   every overlay state selection is re-broadcast on window show.
3. **Validate before FFI** — sherpa-onnx can `exit(-1)` or throw C++ exceptions that
   abort the whole process; all model files are validated in Rust before engine load.
4. **`ffmpeg`/`ffprobe` on PATH is a hard runtime dependency** (recording, duration,
   transcode-to-16kHz). Input is hard-coded PulseAudio (`-f pulse`) — Linux only.
5. **Adding a window** = window label + `App.tsx` route branch + `capabilities/default.json`
   entry + `data-window` CSS scoping. All four steps are required (see doc 09).
