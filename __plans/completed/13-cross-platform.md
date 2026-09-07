# 13 — Cross-Platform Port (macOS + Windows)

Status: in progress. Linux is the reference platform and must not regress.

## Goal

Run the same voice-dictation product on Linux, macOS, and Windows from one codebase:
hold/toggle a global hotkey → record → local Parakeet transcription → auto-paste into
the focused app. Bundle size stays small and the app runs smoothly on all three.

## Decisions

| Question | Decision |
|---|---|
| Audio capture/decode | **Pure Rust**: cpal (capture), symphonia (decode), rubato (16 kHz resample). ffmpeg is removed entirely. |
| Recording formats | MP3 (192k, mp3lame-encoder) + WAV (hound). Settings keep `mp3 \| wav`. |
| Code signing/notarization | Deferred — unsigned builds; optional CI secrets later. |
| Auto-updater | Deferred — clean follow-up once multi-platform releases exist. |

## UX spec (per platform)

| Capability | Linux | macOS | Windows |
|---|---|---|---|
| Mic capture | cpal (PulseAudio/PipeWire) | cpal (CoreAudio) + TCC prompt | cpal (WASAPI) |
| Paste auto | Ctrl+Shift+V in terminals (X11 detection), else Ctrl+V; wtype on wlroots; clipboard-only on GNOME-Wayland | Cmd+V | Ctrl+V |
| Paste modes offered | all 5 | auto / cmd_v / clipboard_only | all 5, terminal detection off |
| Shortcut display | Ctrl ⇧ Space | ⌘⇧Space (default `meta+shift+space`) | Ctrl+Shift+Space |
| Env cards | mic, wtype, session | mic TCC, Accessibility TCC | mic |
| Overlays | unchanged | same APIs (verify) | same APIs (verify) |

## Architecture

- `recorder.rs` public commands unchanged; internals: cpal input stream → mono mixdown
  → writer thread (hound wav / mp3lame-encoder mp3). RMS levels computed in the stream
  callback, throttled 50 ms → `recording-level` (same semantics as the old astats path).
- `transcriber.rs` decode: symphonia → mono → rubato → 16 kHz f32, fully in memory.
  Import allowlist extends to `mp3|wav|flac|ogg|m4a`; path-confinement rules unchanged.
- `sysinfo.rs`: `EnvInfo = { platform, micAvailable, accessibilityPermission?,
  sessionType, wtype? }` — no external-binary checks.
- `paste/`: shared enigo chains + `linux.rs` (X11 terminal detection, wtype) behind cfg;
  mac routes through Meta key.
- `canonical.ts`: platform-aware human display (⌘ ⇧ ⌥ on mac) + accelerator mapping.
- sherpa-rs: bump pin to a version whose `-sys` build fetches per-target sherpa-onnx
  prebuilts; verify early (spike) — fallback: build from source (cmake) or vendor libs.

## Tasks

- [x] Spike: sherpa-rs multi-OS prebuilts (0.6.8 dist.json covers linux-x64/arm64, mac-x64/arm64, win-x64 — no bump needed)
- [x] Cargo deps: cpal, symphonia (+aac/isomp4/wav/ogg), rubato, mp3lame-encoder, audioadapter-buffers; x11rb → linux target
- [x] recorder.rs cpal rewrite + RMS metering + mp3/wav encode (writer thread + done channel)
- [x] transcriber.rs in-memory decode + extended allowlist (mp3|wav|flac|ogg|m4a|aac)
- [x] sysinfo.rs platform EnvInfo + TCC checks (mac: AXIsProcessTrusted via ApplicationServices)
- [x] paste.rs split per OS (paste/mod.rs + paste/linux.rs keeps X11/wtype byte-for-byte)
- [x] settings: mac default `meta+shift+space`; paste-mode validation unchanged
- [x] Frontend: env.ts shape, canonical.ts ⌘⇧⌥ display + per-platform accelerators, Settings/Record/App per-OS cards
- [x] `[profile.release]`: opt-level "z", lto, strip, codegen-units 1
- [x] CI matrix (ubuntu/macos/windows) + release.yml per-OS bundles
- [x] README per-OS requirements + parity table

Remaining (needs real hardware/CI):
- [ ] Verify mac/win builds on CI (first run compiles sherpa prebuilts + bindgen)
- [ ] Manual smoke per OS (hold→paste, toggle, model download, imports, overlays)

## Pitfalls

- WKWebView (mac) cannot play ogg-vorbis in `<audio>` — transcription still works;
  AudioPlayer shows a graceful "playback unsupported" fallback.
- symphonia does not decode ogg-opus — reject with an actionable message.
- mac: never synthesize input before Accessibility is granted; first mic access must
  surface the TCC prompt via cpal and map denial to a setup card.
- enigo 0.5 key names differ per platform (`Key::Meta`); keep combos in one table.
- tao click-through is safe only after first show — overlay ordering stays.
- sherpa aborts the process on invalid ONNX — keep validate-before-FFI intact.

## Verification

- `cargo test` + `bunx vitest run` + `bun run build` green on all 3 platforms (CI matrix).
- Manual smoke per OS: hold→auto-paste into a text editor, toggle mode, cancel,
  model download, imported mp3/m4a transcribe + playback, overlay pills, settings
  persistence; explicit no-regression pass on Linux.
