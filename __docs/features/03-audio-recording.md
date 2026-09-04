# 03 — Audio Recording (ffmpeg-backed)

## What it does

Records microphone audio to `recording-<unix-ms>.wav|.mp3` by spawning an **external
`ffmpeg` process** — there is no in-process audio capture. Also provides live mic-level
metering for the indicator animations and blob-URL playback.

## UI / UX (`/audio` Recorder page, `src/pages/AudioPage.tsx`)

- **Format radio**: MP3 (default) / WAV.
- **Destination folder**: shows current dir, "Change folder" via the dialog plugin,
  "Reset to default" (`<app_data>/recordings`).
- Big green **Start recording** button; while recording it becomes a red pill with a
  blinking dot, elapsed timer, and **Stop & save** / **Discard** buttons.
- "Saved …" confirmation line with format/duration/path; error line for failures.

## Implementation (backend: `src-tauri/src/recorder.rs`)

- **Spawn** (`recorder.rs:79-112`):
  `ffmpeg -f pulse -i default -ac 1 -ar 44100 -af "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-"`
  + `pcm_s16le` (WAV) or `libmp3lame -b:a 192k` (MP3). stdout piped, stderr nulled.
- **Lifecycle**: `RecorderState(Mutex<Option<Recording>>)`; stop sends `SIGTERM`
  (`libc::kill`) with a 5-second wait-then-kill loop; duration probed afterwards with
  `ffprobe -show_entries format=duration`. Immediate-exit after spawn is reported as
  "no audio input device" (`recorder.rs:128-130`).
- **Level metering** (`recorder.rs:136-166`): a thread parses
  `lavfi.astats.Overall.RMS_level=` lines from ffmpeg's stdout, maps dBFS to a clamped
  0..1 float (−inf → −90 dB → 0.0; `(db+60)/60`), throttles to one event per 50 ms, and
  emits global `recording-level` events. **No PCM streaming** — levels only.
- **Commands**: `start_recording {format, outputDir}`, `stop_recording → RecordingMeta`,
  `cancel_recording` (stop + delete file), `recording_state`, `list_recordings {dir}`,
  `delete_recording {path}` (rejects non-audio extensions + the in-progress file; also
  removes the transcript sidecar), `read_recording {path}` → raw bytes via
  `tauri::ipc::Response`, `default_recording_dir`.
- **Playback** (`src/lib/audio.ts:203-239`): frontend invokes `read_recording`, wraps
  the bytes in a Blob → `URL.createObjectURL`, cached per path
  (`loadRecordingUrl`). `AudioPlayer` has a **base64 data-URL fallback**
  (`loadRecordingDataUrl`, 32 KiB chunked `String.fromCharCode`) for WebKit blob-URL
  failures. `forgetRecordingUrl(path)` revokes URLs on delete.
- **State sync**: `recording-state` events keep the frontend store
  (`useRecording()` via `useSyncExternalStore`) live; `toggleRecording` re-queries
  `recording_state` before acting.
- **Hold orchestration** (`src/lib/recordingHold.ts`): `startHold`/`endHold` with the
  300 ms tap threshold; near-instant release races are caught and ignored.
- Recorder settings (dir + format) live in **localStorage**
  (`settings:audio-dir`, `settings:audio-format`), *not* the Rust settings.json.

## Gotchas

1. **Hard-coded PulseAudio input** (`-f pulse -i default`): recording cannot work on
   Windows/macOS or pure-ALSA/JACK systems. The non-unix `kill` branch
   (`recorder.rs:191-194`) is dead weight — spawn would fail there first.
2. **`ffmpeg`/`ffprobe` must be on PATH** — no bundling, no detection at startup.
3. **Blocking work under lock** — `stop_recording` holds the recorder mutex through
   SIGTERM + 5 s wait + ffprobe (`recorder.rs:323-336`); `recording_state` polls during
   that window block too (tolerable — command threads, not the main thread).
4. **Arbitrary-file-read surface** — `read_recording` accepts any path with a
   `.wav`/`.mp3` extension (`recorder.rs:430-448`); it is not confined to the
   recordings dir. Combined with `csp: null` + asset scope `**`, security is loose.
5. **Base64 fallback** duplicates large files in memory (O(n) binary strings).
6. Inconsistent mutex-poison handling: `TranscriberState` recovers via `into_inner()`;
   recorder/downloader return "state is poisoned" errors.

## Difficulties & mitigations (from git `aff2364`, `5d3fbe7`, `fd54ea3`)

| Difficulty | Evidence | Mitigation |
|---|---|---|
| Audio capture is hard natively (cpal etc.) → delegated to ffmpeg child | 1564-line commit spawning ffmpeg | detect ffmpeg + input format at startup with actionable setup guidance; feature-detect `libmp3lame` |
| ffmpeg child lifecycle is fiddly | raw `libc::kill` SIGTERM + wait/kill fallback loop, `Recording` guard struct | keep the guard-struct ownership; add tests for stop-during-recording |
| Asset-protocol playback failed in webview → symptom commits | `5d3fbe7` "Serve recording bytes over IPC and play via blob URLs" + base64 fallback | prefer properly-scoped `assetProtocol.scope` over IPC byte-shuttling for large files; keep extension check + confine path to recordings dir |
| Voice reactivity without a DSP stack | ffmpeg `astats` stdout parsed as an API (−inf handling, 20 Hz throttle) | fine for visuals; switch to PCM pipe/cpal if levels ever drive more than visuals |
