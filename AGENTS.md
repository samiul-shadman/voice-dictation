# AGENTS.md — Voice Dictation

Guidance for AI coding agents working in this repository.

## Project

A single-purpose, keyboard-first **voice dictation app**: hold (or toggle) a global
hotkey anywhere in the OS → record → transcribe **locally** with NVIDIA Parakeet
(int8 ONNX via sherpa-onnx) → auto-paste the transcript into the focused app.
Multi-platform (Linux, macOS, Windows); Linux was the original target, the
cross-platform port is documented in `__plans/13-cross-platform.md`.

- **Stack:** Tauri 2 (Rust backend) + React 19 + TypeScript + Vite + Tailwind 4.
- **Design language:** quiet, dark, precise. No feature creep — single-purpose product.

## Commands

```bash
bun install                 # install frontend deps
bun run tauri:dev           # dev server + app (Linux: X11)
bun run tauri:build         # release build + bundles
bun run build               # tsc + vite build (frontend only)
bunx vitest run             # TypeScript tests

cd src-tauri
cargo test                  # Rust tests
cargo check --all-targets   # fast type check
```

There is no separate lint script; `tsc` (via `bun run build`) and `cargo check`
are the gates. Run both before declaring any change done.

## Layout

```
src/                     React frontend
  components/ui/         Design-system kit (Button, Badge, Field, toast, ...)
  components/feature/    Domain components (AudioPlayer, TranscriptPanel, ...)
  pages/                 Route pages (Record, Library, Models, Settings, ...)
  lib/                   Domain logic (voiceNote, audio, windows/, stores/, shortcuts/)
  styles/                base.css (tokens), overlay.css
src-tauri/               Rust backend
  src/lib.rs             Plugin setup + command registry (single list)
  src/settings.rs        Settings: single authority, atomic save, .bak on corruption
  src/recorder.rs        Recording (mic capture + encoding + level metering)
  src/transcriber.rs     Transcription pipeline + engine cache + progress events
  src/engines/           sherpa-rs engine wrapper (model_type pinned nemo_transducer)
  src/models.rs          Model catalog, downloads, integrity validation
  src/paste.rs           Paste engine (clipboard-first, synthetic keystrokes)
  src/sysinfo.rs         Environment detection surfaced as setup cards
  src/downloader.rs      Shared download logic (model + files)
__plans/                 Build plans (module docs, read 00 + 11 first)
__docs/features/         v2 post-mortem distilled into feature lessons
```

## Architecture invariants (do not break)

1. **Rust `settings.json` is the single settings authority.** Overlays hydrate via
   `get_settings` and receive transient state over events; never add localStorage
   settings or a second source of truth.
2. **Validate before FFI:** every model file is size/integrity-validated and the
   decoder ONNX is metadata-patched *before* the engine loads — sherpa aborts the
   process on bad files otherwise.
3. **Global shortcuts are registered only by the main window.** Combos flow through
   the canonical vocabulary in `src/lib/shortcuts/canonical.ts` (canonical format
   `ctrl+shift+space`, plugin accelerator, human display). Do not bypass it.
4. **Recorder stop protocol:** the `Recording` is swapped out under a short lock and
   finalized on a detached thread (`stopping: true` stays visible to polling). Never
   hold the recorder mutex across a long-running finalize.
5. **Overlays** (`indicator`, `recording-indicator`) are created offscreen, shown
   only after positioning, and made click-through **only after first show** (tao
   panics on unrealized GTK windows).
6. **Level metering drives visuals via the `--voice-level` CSS variable** —
   `calc()` in CSS, never per-frame JS writes.
7. **Security boundaries:** recording reads/deletes are confined by
   `is_path_within_dir` + extension allowlist; settings writes are atomic
   (`.tmp` → rename). Preserve both when touching those paths.

## Conventions

- **Wire types are `#[serde(rename_all = "camelCase")]`** — Rust structs expose
  camelCase to the frontend (e.g. `durationSecs`, `hasTranscript`).
- **Tests:** plain assertion-style fns in `#[cfg(test)]` modules with descriptive
  snake_case names (`corrupt_file_backed_up_and_defaults_restored_with_warning`).
  Same spirit for `*.test.ts` (vitest). Test pure logic, not processes.
- **No code comments unless the user asks** (or for a non-obvious v2-gotcha-style
  invariant, matching the existing style of short `// reason` lines).
- Error messages are user-facing prose: lowercase start, name the failing thing,
  give the actionable fix ("ffmpeg was not found on PATH — install ffmpeg and …").
- Keep the frontend command surface stable: commands are registered in the single
  `invoke_handler` list in `src-tauri/src/lib.rs`; events (`recording-level`,
  `recording-state`, `transcribe-progress`, `settings-changed`, …) are part of the
  contract with `src/lib/stores/*`.
- Commit style: short imperative subject; push after each completed milestone.

## Platform notes (port in progress)

- Linux remains the reference platform; X11 gives full paste + terminal detection,
  wlroots-Wayland uses `wtype`, GNOME-Wayland degrades to clipboard-only honestly.
- macOS/Windows paths are being added behind `#[cfg(target_os)]`; audio is
  pure-Rust (cpal + symphonia + rubato + mp3lame-encoder) — no external ffmpeg.
- When adding a platform branch, keep the Linux behavior byte-for-byte and prefer
  a shared trait/function over divergent copies.
- macOS needs TCC permissions surfaced as setup cards (Microphone, Accessibility);
  never synthesize input without checking `sysinfo` first.
