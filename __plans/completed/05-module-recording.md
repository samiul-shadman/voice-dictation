# 05 — Module: Audio Recording (ffmpeg)

Milestone: M1 · Files: `src-tauri/src/recorder.rs`, `sysinfo.rs` (detection),
`lib/stores/recorder.ts`, `pages/RecordPage.tsx`, `components/feature/RecordingButton.tsx`.

## Goal

Record the microphone to MP3/WAV files in the configured folder; expose live mic level
for overlays; list/read/delete recordings for the library. External `ffmpeg` subprocess
(no in-process capture) — the v2-proven approach.

## Backend (recorder.rs)

- State: `RecorderState(Mutex<RecorderInner>)` — `Inner { recording: Option<Recording>,
  stopping: bool }`; `Recording { child, format, path, started_at }` guard struct.
- Spawn (v2 command line, kept):
  `ffmpeg -f pulse -i default -ac 1 -ar 44100 -af "astats=metadata=1:reset=1,
  ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-"` + `pcm_s16le` (wav) or
  `libmp3lame -b:a 192k` (mp3); stdout piped (astats lines), stderr nulled.
- Level thread: parse `lavfi.astats.Overall.RMS_level=` dBFS → clamp `(db+60)/60`
  (−inf → 0.0); throttle 50 ms; emit global `recording-level {level}`. Levels drive
  visuals only.
- **Stop fix (v2 gotcha #3):** `stop_recording` sets `stopping=true`, then performs
  SIGTERM (`libc::kill`) + wait-5 s-then-kill + ffprobe duration on a **detached
  thread**; the state mutex is not held across the 5 s. `recording_state` may report
  `stopping: true` meanwhile.
- Immediate exit after spawn → error "no audio input device".
- Commands: `start_recording {format}` · `stop_recording → RecordingMeta` ·
  `cancel_recording` · `recording_state` · `list_recordings` (dir from settings,
  newest first, `hasTranscript` via sidecar check) · `delete_recording {path}`
  (extension allowlist, refuses the in-progress file, removes `.transcript.json`
  sidecar best-effort) · `read_recording {path}` → raw bytes via
  `tauri::ipc::Response`, **confined to the recordings dir + allowlist** (v2
  arbitrary-read security fix) · `default_recordings_dir`.
- File naming: `recording-<unix-ms>.mp3|.wav` in settings `audioDir`.

## Startup detection (sysinfo.rs → `detect_environment`)

Probe once at setup, cache, include with settings payload:
`{ ffmpeg, ffprobe, libmp3lame, pulseInput, sessionType: 'x11'|'wayland-wlroots'|'wayland-gnome'|'other', wtype }`.

- ffmpeg: `ffmpeg -version`; libmp3lame: parse version/config output; pulseInput:
  short `ffmpeg -f pulse -i default -t 0.2 -f null -` smoke test.
- UI consumes: amber setup card on /record + /settings when a dep is missing, with
  copyable install commands (apt/dnf/pacman) naming exactly what is broken (v2
  "detect at startup with actionable guidance" mitigation adopted).

## Frontend

- `stores/recorder.ts`: singleton (`busy`, `stopping`, `meta`, `lastError`) fed by
  `recording-state` events + command returns; `useSyncExternalStore` hook
  `useRecording()`. `toggleRecording` re-queries `recording_state` before acting.
- RecordPage (max-w 680, centered):
  - Hero card: RecordingButton — idle: 72 px circular primary (Mic icon + "Record");
    recording: rose ring driven by `--voice-level`, elapsed timer (mono 20 px),
    actions Stop & save (primary) / Discard (ghost danger). Space starts/stops when
    the page is focused (secondary affordance; the global hotkey is the real path).
  - Format row: SegmentedControl MP3 | WAV (persisted setting).
  - Destination row: mono path + Change… (dialog plugin) + Reset to default; writes
    settings `audioDir` (validated: absolute + write probe — same logic as models dir).
  - Last-saved toast: "Saved recording-….mp3 · 12.4 s · 214 KB" + Reveal folder.
  - Missing-ffmpeg setup card replaces the hero when detection failed.
- Hold integration (doc 03 engine): `startRecordHold` / `endRecordHold` map to
  start / cancel-or-stop; < 300 ms tap → cancel, no file.

## Pitfalls carried from v2 (doc 03)

1. PulseAudio hard-coded input — accepted (Linux-only product); detect_environment
   names it explicitly.
2. ffmpeg/ffprobe on PATH — startup detection + setup cards (adopted mitigation).
3. Blocking work under lock — fixed with detached stop thread + `stopping` flag.
4. `read_recording` arbitrary read — confined to the recordings dir + allowlist.
5. Base64 data-URL fallback — kept for webkit blob-URL failures (chunked 32 KiB
   `String.fromCharCode`), used only on `<audio>` error.
6. Blob URL revoke on delete (`forgetRecordingUrl`).

## Tasks

- [x] recorder.rs spawn / stop (stopping-flag, detached) / cancel + unit tests
      (meta, allowlist, sidecar removal, refusal rules)
- [x] level parsing thread + 50 ms throttle + events
- [x] read_recording confinement + tests
- [x] sysinfo.rs detect_environment + settings payload
- [x] recorder store + useRecording
- [x] RecordPage hero (FAB, level ring, timer, stop/discard) + format + destination
- [x] dependency setup cards
- [x] save toast + Reveal folder (opener plugin)

## Verification

- Unit: stop-during-recording race; delete in-progress refused; extension allowlist
  rejections; read outside dir rejected.
- Manual: mp3 + wav round-trips; discard mid-recording leaves no file; level events
  ~20 Hz; missing-ffmpeg card shows install hint; app restart during recording →
  state recovers cleanly.
