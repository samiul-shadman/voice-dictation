# 06 — Module: Audio Library & Playback

Milestone: M1 · Files: `pages/LibraryPage.tsx`, `components/feature/AudioPlayer.tsx`,
`components/feature/TranscriptPanel.tsx` (built here, consumed by doc 07),
`lib/audioPlayback.ts` (+ blob cache in `lib/audio.ts`).

## Goal

Browse, play, manage, and manually transcribe saved recordings. One recording plays at
a time (exclusive playback). This page is also where transcripts become visible.

## UX spec (/library)

- Row layout (list, not cards — density): [Play/Pause 36 px] [name (ellipsis) + meta
  line: format chip · duration mono · size · relative date] [badges: "Transcript"
  ok-badge when a sidecar exists] [Transcribe button when absent] [Delete IconButton].
- Row body click → expands the inline TranscriptPanel (when a transcript exists).
- Delete → ConfirmDialog (destructive variant): "Delete recording-….mp3 and its
  transcript?" — **no window.confirm** (v2 consistency fix).
- Auto-refresh on: audioDir setting change (subscribe), recording stopped (edge-detect
  via wasRecording ref), transcription completed (transcribe-complete).
- Empty state: Mic icon, "No recordings yet", hint "Hold your voice-note hotkey
  anywhere — or press Record on the Record page." + button → /record.
- Header: item count + total size; fixed newest-first sort; current dir shown
  (library is directory-scoped — changing dirs happens in Settings).

## Implementation

- `list_recordings` (doc 05) → `RecordingMeta { path, name, format, size,
  durationSecs?, modified, hasTranscript }`; duration renders `--:--` until
  ffprobe-known.
- **Exclusive playback** (`audioPlayback.ts`): registry `Set<HTMLAudioElement>`;
  `claimExclusivePlayback(el)` pauses every other playing element on play. The browser
  provides no primitive — manual policy (v2-proven).
- `AudioPlayer`: blob-URL per path via `read_recording` IPC → `URL.createObjectURL`,
  cached per path (`loadRecordingUrl`); **base64 data-URL fallback** (chunked 32 KiB)
  on `<audio>` error; Loading / "Could not load audio" states.
- Delete flow: ConfirmDialog → `delete_recording` (Rust guards: allowlist, in-progress
  refusal, sidecar removal) → pause if playing → `forgetRecordingUrl` (revoke blob)
  → refresh list.
- Transcribe button: `transcribeFile(path, autoPaste=false)` via the transcriber store
  (doc 07); disabled while any transcription or recording is busy; label shows the
  live percent from the store; success → badge replaces the button (list refreshes on
  transcribe-complete).

## Pitfalls carried from v2 (doc 04)

1. window.confirm inconsistency → ConfirmDialog component.
2. Unknown duration for foreign files → `--:--` (accepted).
3. Delete while playing → pause first, then revoke (handled in the flow above).
4. Directory-scoped listing → dir shown in the header; switch via Settings.

## Tasks

- [x] audioPlayback exclusive registry + wiring in AudioPlayer
- [x] blob cache + base64 fallback + revoke-on-delete
- [x] LibraryPage rows + human formatting utils (size, relative time, duration)
- [x] TranscriptPanel: lazy `get_transcript` load; meta line (model id · duration ·
      created); readable transcript text; Copy (clipboard API → hidden-textarea
      `execCommand("copy")` fallback); Re-transcribe (busy-aware)
- [x] ConfirmDialog destructive flow
- [x] refresh triggers (settings dir change, recording edge, transcribe-complete)
- [x] empty state

## Verification

- Manual: two rows → play both alternately (only one audible); delete the playing row
  (pauses, refreshes); transcribe from library → percent on the button → badge;
  switch audio dir → list empties/repopulates; empty state renders.
