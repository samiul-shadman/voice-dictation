# 07 — Module: Voice-Note Pipeline (record → transcribe → paste)

Milestone: M2 (engine + manual transcription) / M4 (hotkey wiring + auto-paste) ·
Files: `lib/voiceNote.ts`, `lib/stores/transcriber.ts`,
`src-tauri/src/transcriber.rs`, `transcripts.rs`, `engines/parakeet_engine.rs`.

## Goal

The product's core loop: a voice-note hotkey records, then locally transcribes with
Parakeet, saves a transcript JSON sidecar, and auto-pastes the text into the focused
app (paste execution is doc 09; this module hands off at completion).

## Frontend

- `voiceNote.ts` (toggle + hold, built on doc 03's shared hold engine):
  - toggle: idle → `ensureIdleForNewRecording` (guard: already transcribing → friendly
    error) → `startRecording()`; busy-recording → `stopRecording()` +
    `transcribeFile(path, autoPaste=true)`.
  - hold: Pressed → `startRecording()`; Released ≥ 300 ms → stop + transcribe(true);
    < 300 ms → `cancelRecording()` (accidental tap).
- `stores/transcriber.ts` (module singleton):
  - state `{ busy, activePath, percent }`; events:
    - `transcribe-progress`: **adoption rule** — a progress event for a path with no
      active path adopts it (overlays run this store and never call transcribeFile).
      Requires the backend to emit 0 % as the first event (tested). Stale-path events
      filtered.
    - `transcribe-complete`: clears state + fans out to completeListeners
      `{path, text, modelId, durationMs, autoPaste, pasteError?}`.
    - `transcribe-error`: clears state if the path matches; surfaces a toast.
- Feedback surfaces: recording pill phases rec → transcribing (doc 10); completion
  toast "Transcribed · pasted" or "Paste failed — the text is on your clipboard" with
  the error detail. No output window (deliberately dropped).

## Backend (transcriber.rs)

- `transcribe_file {path, autoPaste}`: busy-flag guard; resolve a model (settings
  `defaultModel` if downloaded, else first in preference order
  `[parakeet-v2-en, parakeet-v3-multilingual]`); spawn a worker thread wrapped in
  `std::panic::catch_unwind(AssertUnwindSafe(...))` — panics become `transcribe-error`,
  the busy flag is never poisoned.
- Audio prep: `load_pcm16k_mono` — ffmpeg transcode to 16 kHz mono s16le temp WAV
  (`/tmp/voice-dictation-<pid>-<ms>.wav`) → `hound` decode → `Vec<f32>/32768`;
  temp file removed best-effort.
- Engine cache: one loaded engine keyed by model id — repeated voice notes skip model
  reload (major latency win).
- Progress: recognition callback → shared `AtomicU32`; watcher thread polls every
  200 ms → emits `transcribe-progress` (0 % first, clamped ≤ 99 %).
  **v3 note:** pinned sherpa-rs 0.6.8 (sherpa-onnx 1.12.9) exposes no recognition
  callback, so the watcher emits a time-estimated percent; the 0 %-first contract
  (and its Rust-side test) is unchanged.
- Completion (worker thread): save sidecar → run paste (doc 09) if autoPaste → emit
  `transcribe-complete`. **Paste runs on the worker thread** — the Linux clipboard
  backend deadlocks against the UI thread otherwise (v2 comment preserved).

## Sidecar (transcripts.rs)

`<stem>.transcript.json` → `{ audioPath, text, modelId, durationMs, createdAt }`;
save failure logged, not fatal; `get_transcript {path}` command; port the v2 unit
tests.

## Parakeet engine (engines/parakeet_engine.rs) — validate before FFI

- `sherpa-rs` TransducerRecognizer over 4 int8 ONNX files + tokens.txt.
- **`model_type: "nemo_transducer"` hard-pinned** — v2 commit 65215df: the default
  icefall decoder misreads NeMo graphs → ONNX Runtime C++ exception crosses the FFI →
  whole app dies. Keep + regression test pinning the config.
- `ensure_tokens_have_blank` pre-check (sherpa `exit(-1)`s on a missing `<blk>` — e.g.
  an HTML error page saved as tokens.txt) → friendly "re-download" error before load.
- File integrity validated (exist + exact/manifest size, doc 08) before load.
- **4800-sample zero tail padding** before recognition (truncated-final-tokens fix,
  kept + documented).

## Pitfalls carried from v2 (doc 05)

1. FFI aborts → all validations above; never hand unvalidated files to sherpa.
2. Cross-window adoption depends on the 0 % first progress event → keep + add a
   Rust-side test asserting the first emitted progress is 0.
3. /tmp roundtrip is wasteful → accepted for v1 (16 kHz mono is small; best-effort
   cleanup + unique names).
4. Two model-dir resolution paths (v2) → single resolution helper in models.rs shared
   by list_models and transcriber (doc 08).

## Tasks

- [x] transcriber.rs: busy guard / catch_unwind / engine cache / progress watcher
      (+ tests)
- [x] load_pcm16k_mono + temp cleanup
- [x] transcripts.rs + get_transcript (+ ported tests)
- [x] parakeet_engine.rs: pinned config + tail padding + token pre-check + regression
      test
- [x] transcriber store (adoption + completion listeners) — overlays consume it too
- [x] voiceNote.ts toggle/hold orchestration
- [x] completion toasts + pasteError path
- [x] TranscriptPanel integration in the library (component built in doc 06)

## Verification

- Unit: sidecar round-trip; model resolution order; busy guard; catch_unwind maps
  panic → error event; first-progress-is-0 test; pinned recognizer config snapshot.
- Manual: transcribe a real recording; re-transcribe; hotkey during transcription →
  guard message; SIGKILL mid-transcribe → relaunch shows idle (no stuck busy flag).
