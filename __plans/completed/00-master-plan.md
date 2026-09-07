# 00 — Master Plan

## 1. Vision

A single-purpose, keyboard-first **voice dictation app for Linux**: press-and-hold (or
toggle) one global hotkey anywhere, speak, release — the transcript lands in the app
you were using. Everything runs locally; nothing leaves the machine except model
downloads.

**Design north-star:** quiet, dark, precise. The app stays out of the way; the only
always-visible artifacts are two small glass overlays (shortcut pill, recording pill).

## 2. Tech stack (pinned)

| Layer | Choice | Notes |
|---|---|---|
| Shell | Tauri 2.x | capabilities-based permissions, same as v2 |
| UI | React 19 + TypeScript + Vite | HashRouter in every webview |
| Styling | Tailwind CSS v4 + CSS custom-property tokens | dark-only theme |
| Icons | lucide-react | single icon set |
| Fonts | Inter (UI) + JetBrains Mono (combos, timers, transcripts) | self-hosted |
| Shortcuts | tauri-plugin-global-shortcut v2 (pinned 2.3.x) | registered from main window only |
| Recorder | external `ffmpeg` / `ffprobe` subprocess | PulseAudio input, hard dep |
| STT | `sherpa-rs` (Parakeet TDT 0.6B int8 ONNX) | pin exact version + binary |
| Downloads | reqwest (blocking, rustls) | connect/read timeouts |
| Paste | enigo 0.5 (X11) + `wtype` fallback (Wayland) | clipboard-first invariant |
| Clipboard | tauri-plugin-clipboard-manager | |
| Dialogs / open | tauri-plugin-dialog / opener | folder pickers, reveal folder |

**Hard runtime deps (detected at startup, actionable setup cards when missing):**
`ffmpeg`, `ffprobe` on PATH; PulseAudio; X11 (full paste) or wlroots-Wayland + `wtype`
(degraded paste); GNOME-Wayland degrades to clipboard-only by design.

## 3. Repo layout

```
├── src/                          # React frontend (all windows)
│   ├── main.tsx                  # label → data-window attribute, per-label mount
│   ├── App.tsx                   # label routing (main pages vs overlay branches)
│   ├── styles/                   # tokens.css, base.css, overlay.css
│   ├── components/
│   │   ├── ui/                   # design-system primitives (doc 01)
│   │   └── feature/              # RecordingButton, TranscriptPanel, ModelCard, ...
│   ├── pages/                    # Record, Library, Models, Shortcuts, Animations, Settings
│   ├── lib/
│   │   ├── stores/               # settings, recorder, levels, transcriber, downloads
│   │   ├── shortcuts/            # canonical.ts, engine.ts, hold.ts, capture.ts
│   │   ├── windows/              # overlay.ts, indicator.ts, recordingIndicator.ts
│   │   ├── voiceNote.ts          # toggle/hold orchestration
│   │   ├── audioPlayback.ts      # blob cache + exclusive playback
│   │   └── animations/registry.tsx
│   └── OverlaySync.tsx           # push-on-show responder (main window)
└── src-tauri/
    ├── capabilities/default.json
    └── src/
        ├── lib.rs                # plugins + command registration + setup
        ├── settings.rs           # single authority, atomic save, .bak
        ├── sysinfo.rs            # detect_environment (ffmpeg, session, wtype)
        ├── recorder.rs           # ffmpeg lifecycle + level metering
        ├── models.rs / downloader.rs
        ├── transcriber.rs / transcripts.rs / engines/parakeet_engine.rs
        └── paste.rs
```

## 4. Windows (3)

| Label | Created by | Size | Config |
|---|---|---|---|
| main | tauri.conf.json | 880×640 (min 760×560) | decorated, resizable, dark |
| indicator | lib/windows/indicator.ts | 320×96 | transparent, click-through overlay |
| recording-indicator | lib/windows/recordingIndicator.ts | 260×76 | transparent, click-through overlay |

No output window. Overlays: skipTaskbar, shadow false, focusable false, hidden; created
offscreen at −10000; shown, positioned against primaryMonitor, then
`setIgnoreCursorEvents(true)` (tao panic ordering — doc 02 §5).

## 5. Cross-cutting invariants (non-negotiable)

1. **Clipboard-first paste** — the transcript always hits the clipboard before any
   synthesized keystroke; every downstream failure degrades to "paste manually" with a
   surfaced `pasteError`.
2. **Validate before FFI** — sherpa-onnx can abort the process (`exit(-1)`, C++
   exceptions across FFI). Every model file is validated in Rust (existence, exact
   size / patched-manifest size, `<blk>` token check) before engine load.
3. **Single-authority settings** — all persistent state lives in Rust `settings.json`
   (atomic writes + `.bak`). localStorage caches nothing another window needs.
4. **Push-on-show state sync** — overlays hydrate from settings on mount, emit
   `overlay-ready`, and main pushes transient state via `emitTo`. Events are
   state-adoption signals. No broadcast-before-existence bugs (doc 11 §3).
5. **One registration owner** — global shortcuts are registered only by the `main`
   window. Overlay webviews never touch the shortcut plugin (v2 gotcha fixed).
6. **Adding a window checklist** — label + App.tsx branch + capabilities entry +
   `data-window` CSS scoping + emitTo producers (doc 02 §6).

**Scope note (v1):** closing the main window exits the app — global shortcuts die with
it. A tray/daemon mode is a logged follow-up, not v1 scope.

## 6. Product acceptance criteria

- Hold hotkey → speak → release → text appears in the focused app within ~1 s of
  transcription end (X11); clipboard fallback everywhere else.
- Toggle mode equivalent; sub-300 ms taps ignored everywhere.
- Recordings persist to the library; list / exclusive play / safe delete all work.
- Both Parakeet models downloadable, cancellable, deletable; default selection honored.
- Five paste modes configurable with per-mode guidance; errors surface as toasts.
- Both overlays: never steal focus, never intercept clicks, respect
  `prefers-reduced-motion`.
- `cargo test` green on a clean Linux box; TS unit tests for shortcut/hold logic.

## 7. Risk register (full table in doc 12)

- sherpa FFI process aborts → validate-before-FFI + pinned `nemo_transducer` +
  regression test.
- Native build fights → pin `sherpa-rs` exactly; record the matching sherpa-onnx
  binary; CI build from clean.
- Webview quirks → no `@property` animation; inline style for SVG var stops; blob
  URL + base64 playback fallback.
- Capabilities churn → checklist; consider per-window capability split.
- Upstream drift (HF files) → pinned URLs + exact-size + patched-size manifest.
