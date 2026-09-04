# Voice Dictation

A single-purpose, keyboard-first **voice dictation app for Linux**: hold (or toggle) one
global hotkey anywhere in the OS, speak, release — the transcript is transcribed
**locally** with NVIDIA Parakeet and **auto-pasted** into whatever app was focused.
Everything runs on your machine; nothing leaves it except the one-time model download.

Built on **Tauri 2 + React 19**. Design language: quiet, dark, precise.

## Features

- **Voice-note hotkey** — record → transcribe → auto-paste into the focused app
  (clipboard-first: if pasting is impossible, the text is always on your clipboard).
- **Record hotkey** — record to the audio library without transcribing.
- **Hold and toggle modes** — 300 ms accidental-tap rejection, lost-keyup failsafe.
- **Local STT** — Parakeet TDT 0.6B (int8 ONNX) via sherpa-onnx; two models
  (English / multilingual) with background downloads, cancel, delete, default selection.
- **Audio library** — exclusive playback, transcript sidecars, manual transcribe, safe delete.
- **Overlays** — click-through glass pills: shortcut indicator + recording/transcription
  animation (10+10 styles, in-app gallery).
- **Five paste modes** — auto (terminal-aware), Ctrl+V, Ctrl+Shift+V, Shift+Insert,
  clipboard-only; X11 terminal auto-detection; `wtype` fallback on wlroots-Wayland;
  honest clipboard-only degradation on GNOME-Wayland.

## Requirements (Linux)

| Dependency | Why | Install |
|---|---|---|
| `ffmpeg` + `ffprobe` | recording + audio prep | `sudo apt install ffmpeg` / `sudo dnf install ffmpeg` / `sudo pacman -S ffmpeg` |
| PulseAudio | microphone input | preinstalled on most desktops |
| X11 | full paste + terminal detection | default session for best results |
| `wtype` | paste on wlroots-Wayland | `sudo apt install wtype` / `sudo pacman -S wtype` |

Missing dependencies are detected at startup and surfaced as actionable setup cards
in the app (Settings → Environment).

## Development

```bash
bun install
bun run tauri:dev     # dev server + app (X11)
bun run tauri:build   # release build + bundles (.deb / .AppImage / .rpm)
```

Rust unit tests and TypeScript tests:

```bash
cd src-tauri && cargo test
bunx vitest run
```

## Architecture (short version)

- **3 webviews, 1 bundle**: `main` (the app), `indicator` + `recording-indicator`
  (always-on-top, click-through, non-focusable overlays created offscreen).
- **Rust is the single settings authority** (`settings.json`, atomic writes, `.bak` on
  corruption); overlays hydrate from `get_settings` and receive transient state via
  `overlay-ready` handshakes — no shared localStorage.
- **Global shortcuts are registered only by the main window**; a canonical combo
  vocabulary (src/lib/shortcuts/canonical.ts) bridges UI, plugin, and display formats.
- **Recorder** = external `ffmpeg` subprocess with astats level metering driven into
  the UI as a CSS variable (`--voice-level`) — visuals are `calc()`, never per-frame JS.
- **STT** = sherpa-rs with `model_type: "nemo_transducer"` hard-pinned; every model file
  is size/integrity-validated and the decoder ONNX is metadata-patched **before** the
  engine loads (validate-before-FFI: sherpa aborts the process on bad files otherwise).
- Full build plans and module docs live in [`__plans/`](./__plans/README.md); the v2
  post-mortem they distilled lives in [`__docs/features/`](./__docs/features/README.md).

## Scope notes (v1)

- Closing the main window exits the app (global shortcuts die with it); tray/daemon
  mode is a logged follow-up.
- The indicator overlays follow the primary monitor only.
- Transcription progress is time-estimated (sherpa-rs 1.12.9 exposes no recognition
  callback); the first progress event is always 0 % and drives cross-window adoption.
