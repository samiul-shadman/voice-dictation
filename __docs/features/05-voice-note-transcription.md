# 05 — Voice-Note: Record → Transcribe → (Auto-Paste)

## What it does

The core dictation flow: a `voice-note` shortcut records audio (toggle or hold), then
transcribes it locally with Whisper or Parakeet, saves a transcript JSON sidecar next to
the audio, and (optionally) auto-pastes the text into the focused app.

## UI / UX

- Shortcut configured on `/audio/shortcuts` (Recording + Voice-note sections, each with
  toggle/hold and app/global scope — see doc 01).
- The recording-indicator overlay shows recording (level bars) then transcribing
  (spinner/percent) phases (doc 08).
- **TranscriptPanel** (`src/components/TranscriptPanel.tsx`): collapsible per-recording
  panel in the library; lazily loads the sidecar via `get_transcript`; shows model id +
  created-at + text; **Copy** button (clipboard API → hidden-textarea
  `execCommand("copy")` fallback); **Re-transcribe** button (disabled while busy or
  while paused recording).
- **AudioLibraryPage** completion handling: if `autoPaste`, it deliberately does **not**
  print to the Output window (that would steal focus back from the paste target) — it
  only surfaces `pasteError`; otherwise the transcript text is printed to Output.

## Implementation

### Frontend (`src/lib/voiceNote.ts`, `src/lib/transcriber.ts`)

- `toggleVoiceNote()`: recording → `stopRecording()` + `transcribeFile(path,
  autoPaste=true)`; idle → guard "already transcribing" (`ensureIdleForNewRecording`)
  and `startRecording()`.
- Hold: `startVoiceNoteHold`/`endVoiceNoteHold` — release ≥300 ms → stop + transcribe +
  auto-paste; sub-300 ms → `cancelRecording()` (accidental tap).
- `transcriber.ts` is a module-singleton state machine (`busy`, `activePath`, percent)
  fed by backend events:
  - `transcribe-progress` — **adopts jobs started in any window**: the overlay webview
    never calls `transcribeFile`, so it flips `busy` when a progress event arrives for
    no active path (backend emits 0% at start). Stale-path events are filtered.
  - `transcribe-complete` — clears state, fans out to `completeListeners`
    (`{path, text, modelId, durationMs, autoPaste, pasteError?}`).
  - `transcribe-error` — clears state if path matches.

### Backend (`src-tauri/src/transcriber.rs`, `transcripts.rs`, `engines/*`)

- `transcribe_file {path, autoPaste}`: sets a busy flag, resolves a model, spawns a
  worker thread wrapped in `std::panic::catch_unwind(AssertUnwindSafe(...))` so a
  panicking engine can't poison the busy flag — errors become `transcribe-error`.
- **Audio prep**: `load_pcm16k_mono` — any input is ffmpeg-transcoded to 16 kHz mono
  s16le WAV in a temp file (`/tmp/tauri-transcribe-<pid>-<ms>.wav`), decoded with
  `hound` into `Vec<f32>` / 32768. Temp file deleted best-effort.
- **Engine cache**: `TranscriberState.engine` caches one loaded engine keyed by model id
  — repeated voice notes skip model reload (significant latency win).
- **Progress**: whisper progress callback → shared `AtomicU32`; watcher thread polls
  every 200 ms and emits `transcribe-progress` clamped to ≤99%.
- **Sidecar** (`transcripts.rs:35-52`): `recording-123.mp3` →
  `recording-123.transcript.json` containing `{audioPath, text, modelId, durationMs,
  createdAt}`. Save failure is logged, not fatal. Extensive unit tests.
- **Auto-paste runs in the worker thread** — explicit comment: avoids deadlocking the
  Linux clipboard backend against the UI (`transcriber.rs:361-369`). See doc 07.
- **Model resolution**: settings `default_model` if downloaded, else first downloaded
  model in a fixed `PREFERENCE_ORDER` (whisper-base … parakeet last)
  (`transcriber.rs:25-37, 79-118`).
- **Whisper engine** (`engines/whisper_engine.rs`): `whisper-rs 0.14`, greedy sampling
  (`best_of: 1`), language `"en"` for `*-en` ids else `"auto"`, all printing disabled,
  segments space-joined.
- **Parakeet engine** (`engines/parakeet_engine.rs`): `sherpa-rs` TransducerRecognizer
  over 4 int8 ONNX files + `tokens.txt`; **`model_type` hard-set to `"nemo_transducer"`**
  (see gotcha #1); **4800 zero-sample tail padding** to avoid truncated final tokens;
  **`ensure_tokens_have_blank`** pre-validation (sherpa `exit(-1)`s on missing `<blk>`);
  regression test pins the config (`parakeet_engine.rs:151-171`).

## Gotchas

1. **C++ exceptions across FFI abort the process.** sherpa-rs's default decoder type
   selects the *icefall* decoder, which misreads NeMo graphs → ONNX Runtime C++
   exception crosses the FFI → `fatal runtime error: Rust cannot catch foreign
   exceptions` → **the whole app dies**. Fixed by pinning `model_type:
   "nemo_transducer"` + a regression test.
2. **sherpa-onnx calls `exit(-1)`** (uncatchable) if `tokens.txt` lacks `<blk>` (e.g. an
   HTML error page saved as the tokens file by a failed download). Mitigated by the Rust
   pre-check returning a friendly "re-download" error.
3. Cross-window "adoption" relies on the backend emitting a **0% progress event at
   start** — if that ever changes, the overlay won't show the transcribing phase for
   jobs started in another window (`transcriber.ts:54-63`).
4. Every transcription round-trips audio through `/tmp` via ffmpeg — wasteful for long
   files; cleanup is best-effort.
5. Two parallel model-dir resolution paths exist (in-memory settings state vs re-reading
   settings.json from disk) — `list_models` prefers state-aware, `transcriber` uses the
   file-based resolver.
6. `getActiveHold()` / `getActiveVoiceNoteHold()` are dead exports.
7. Sidebar labels this page "Recording Shortcut" though it also configures voice-note.

## Difficulties & mitigations (from git `f98895f`, `0e0bc51`, `959be5e`, `65215df`)

| Difficulty | Evidence | Mitigation |
|---|---|---|
| sherpa/Parakeet build fights (libclang/bindgen, prebuilt onnxruntime binaries) | sherpa initially behind an opt-in cargo feature; feature later removed (always-on) in `65215df` | pin `sherpa-rs` exactly; record the matching sherpa-onnx binary version; CI-build on a clean Linux box |
| Wrong decoder type killed the entire app | NeMo `model_type` fix + regression test in `65215df` | never hand model files to the FFI without Rust-side validation; keep the test |
| Corrupt/truncated downloads → uncatchable `exit(-1)` | `ensure_tokens_have_blank` pre-check | treat all engine input as hostile; validate every file before load |
| Truncated final tokens | 4800-sample tail padding constant | keep padding; document why |
| Serialization of transcription jobs | `busy` mutex + `catch_unwind` guard | keep poison recovery via `into_inner()`; consider applying it to recorder/downloader states too |
