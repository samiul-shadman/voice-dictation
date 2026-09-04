# 04 — Audio Library & Playback

## What it does

Lists saved recordings with metadata, plays them (exclusively — one at a time), deletes
them (with transcript sidecar cleanup), and is the launch point for manual transcription.

## UI / UX (`/audio/library`, `src/pages/AudioLibraryPage.tsx`)

- List rows: name, format, duration (`--:--` when unknown), size, modified date.
- **Transcribe button** per untranscribed item — disabled while any transcription or
  recording is busy; shows a live percent from the transcriber store. Once a transcript
  exists, a "Transcript saved" badge replaces it.
- **Delete**: inline trash-SVG icon button (moved from a text button in commit
  `b6cbcf4`) with `window.confirm` guard.
- Inline collapsible **TranscriptPanel** per item (see doc 05).
- Auto-refresh triggers: audio dir changed (subscribes `subscribeAudioDir`), recording
  stopped (edge-detect via `wasRecordingRef`), transcription completed
  (`onTranscribeComplete`).

## Implementation

- `list_recordings {dir}` returns `RecordingMeta[]` (newest first) — `{path, name,
  size, durationSecs?, format, modified, hasTranscript}` (`recorder.rs:357-390`).
  `hasTranscript` is computed by checking for the `<stem>.transcript.json` sidecar.
- **Exclusive playback** (`src/lib/audioPlayback.ts`): a `Set<HTMLAudioElement>`
  registry; `claimExclusivePlayback` pauses every other playing element when one starts.
  Wired in `AudioPlayer.tsx:75-78`. The browser provides no such primitive, so this is
  a manual policy.
- `AudioPlayer` (`src/components/AudioPlayer.tsx`): loads the blob URL per recording,
  falls back to the base64 data-URL on `<audio>` error, shows "Loading player…" /
  "Could not load audio" states.
- Delete flow: `window.confirm` → `delete_recording` (Rust re-validates extension and
  refuses to delete the in-progress recording; removes sidecar best-effort) →
  `forgetRecordingUrl` (revoke blob URL) → refresh list.

## Gotchas

1. `window.confirm` for destructive actions is inconsistent with the polished dialog
   plugin used elsewhere (folder pickers).
2. Duration is unknown (`--:--`) until `ffprobe` succeeds at stop time; old files
   created by other means will show unknown duration.
3. Deleting a recording whose blob URL is currently playing: the URL is revoked but
   the `<audio>` element may keep playing from the revoked URL until paused.
4. The library is directory-scoped — recordings in another configured dir are invisible.

## Difficulties & mitigations (from git `f9144da`, `b6cbcf4`, `5d3fbe7`)

| Difficulty | Evidence | Mitigation |
|---|---|---|
| Two audio elements playing simultaneously | manual exclusive-playback registry needed | keep the registry; alternatively enforce at the store level (single `playingPath` state) |
| Delete racing the active recording | Rust refuses to delete the in-progress file, with unit tests (`recorder.rs`) | keep the lock-based refusal; add a frontend hint for why delete failed |
| Blob URL lifecycle leaks | `forgetRecordingUrl` revocation on delete | also revoke on library unmount/dir change if memory becomes an issue |
