# Voice Dictation

A single-purpose, keyboard-first **voice dictation app**: hold (or toggle) one
global hotkey anywhere in the OS, speak, release — the transcript is transcribed
**locally** with NVIDIA Parakeet and **auto-pasted** into whatever app was focused.
Everything runs on your machine; nothing leaves it except the one-time model download.

Built on **Tauri 2 + React 19**. Design language: quiet, dark, precise.
Platforms: **Linux** (`.deb` / `.AppImage`). The macOS and Windows ports are
deferred — the cross-platform groundwork is documented in
[`__plans/completed/13-cross-platform.md`](./__plans/completed/13-cross-platform.md).

## Features

- **Voice-note hotkey** — record → transcribe → auto-paste into the focused app
  (clipboard-first: if pasting is impossible, the text is always on your clipboard).
- **Record hotkey** — record to the audio library without transcribing.
- **Hold and toggle modes** — 300 ms accidental-tap rejection, lost-keyup failsafe.
- **Local STT** — Parakeet TDT (int8 ONNX) via sherpa-onnx; two models
  (English / multilingual) with background downloads, cancel, delete, default selection.
- **Audio library** — exclusive playback, transcript sidecars, manual transcribe, safe delete.
  Imports MP3, WAV, FLAC, OGG, M4A, AAC.
- **Overlays** — click-through glass pills: shortcut indicator + recording/transcription
  animation (10+10 styles, in-app gallery).
- **Selectable indicator surface** — floating pill (default), panel/tray icon, or both.
  A per-user setting; the panel is the automatic fallback where floating overlays
  cannot be positioned (Linux Wayland).
- **Paste modes per OS** — ⌘V on macOS, Ctrl+V/Ctrl+Shift+V/Shift+Insert on
  Windows and Linux; X11 terminal auto-detection on Linux; `wtype` fallback on
  wlroots-Wayland; honest clipboard-only degradation on GNOME-Wayland.

## Requirements

Audio capture, decoding, and MP3 encoding are **built in** (cpal, symphonia, LAME) —
no external binaries to install on any platform. The optional panel/tray surface is
the one system-library dependency: it needs the AppIndicator runtime
(`libayatana-appindicator3`) on Linux.

| Platform | Needs | Notes |
|---|---|---|
| Linux | PulseAudio or PipeWire; `libayatana-appindicator3` for the Panel/Both surface (or the Wayland fallback) | X11 gives full paste + terminal detection; wlroots-Wayland uses `wtype` (`sudo apt install wtype`); GNOME-Wayland degrades to clipboard-only paste. On GNOME the panel icon also needs the "AppIndicator and KStatusNotifierItem Support" extension |
| macOS | Microphone + Accessibility permissions | Both are requested in-app as setup cards (System Settings → Privacy & Security); paste uses ⌘V, default hotkey ⌘⇧Space |
| Windows | WebView2 (bundled with the installer) | Paste uses Ctrl+V; default hotkey Ctrl+Shift+Space |

Missing dependencies are detected at startup and surfaced as actionable setup cards
in the app (Settings → Environment).

## Development

```bash
bun install
bun run tauri:dev     # dev server + app (Linux: X11)
bun run tauri:build   # release build + bundles (.deb / .AppImage)
```

Building on macOS/Windows needs no extra system packages; on Linux install the
Tauri system dependencies (webkit2gtk 4.1, GTK 3, ALSA headers — see
`.github/workflows/ci.yml` for the full apt line).

Rust unit tests and TypeScript tests:

```bash
cd src-tauri && cargo test
bunx vitest run
```

## Releasing

Releases are cut from a tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The `release.yml` workflow builds the Linux `.deb` and `.AppImage` and attaches
both to a GitHub release (notes are generated from the commits). A version bump
must keep three files in sync — `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, and `package.json` — and add an entry to
[`CHANGELOG.md`](./CHANGELOG.md).

## Architecture (short version)

- **3 webviews, 1 bundle**: `main` (the app), `indicator` + `recording-indicator`
  (always-on-top, click-through, non-focusable overlays created offscreen).
- **Rust is the single settings authority** (`settings.json`, atomic writes, `.bak` on
  corruption); overlays hydrate from `get_settings` and receive transient state via
  `overlay-ready` handshakes — no shared localStorage.
- **Global shortcuts are registered only by the main window**; a canonical combo
  vocabulary (src/lib/shortcuts/canonical.ts) bridges UI, plugin, and display formats
  (⌘⇧ glyphs on macOS, Ctrl/Super elsewhere).
- **Recorder** = pure-Rust cpal capture → mono mixdown → hound WAV or LAME MP3, with
  RMS level metering driven into the UI as a CSS variable (`--voice-level`) — visuals
  are `calc()`, never per-frame JS.
- **STT** = sherpa-rs with `model_type: "nemo_transducer"` hard-pinned; every model file
  is size/integrity-validated and the decoder ONNX is metadata-patched **before** the
  engine loads (validate-before-FFI: sherpa aborts the process on bad files otherwise).
- **Audio decode** = symphonia → mono mixdown → rubato resample to 16 kHz, fully
  in memory (no temp files, no ffprobe).
- **Paste** = enigo keystrokes per platform + clipboard-first fallback; Linux adds
  X11 terminal detection and the `wtype` Wayland path (`paste/linux.rs`).
- Full build plans and module docs live in [`__plans/`](./__plans/completed/README.md); the v2
  post-mortem they distilled lives in [`__docs/features/`](./__docs/features/README.md).

## Scope notes (v1)

- Closing the main window exits the app (global shortcuts die with it); tray/daemon
  mode is a logged follow-up.
- The indicator overlays follow the primary monitor only.
- Transcription progress is time-estimated (sherpa-rs exposes no recognition
  callback); the first progress event is always 0 % and drives cross-window adoption.
- Terminal auto-detection is X11-only (Linux); Auto paste sends Ctrl+V / ⌘V elsewhere.
- macOS WKWebView cannot play OGG Vorbis in the player — transcription still works.
