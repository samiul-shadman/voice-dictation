# 12 — Git History: Difficulties Faced & Mitigations

Repo: 30 commits, `806e4e5` (init, Aug 29) → `12945d9` (Sep 4). Clean working tree;
`master` is 10 commits ahead of `origin/master` (the entire voice-dictation feature set
is unpushed). README is still the stock Tauri template.

## Evolution arc

1. **Scaffold phase** (`806e4e5`–`42fd652`, Aug 29–31): form page + `print_form`,
   sidebar routing, settings page, Output window. Component/page/style reorg.
2. **Shortcut/text-printer phase** (`48d31a2`–`136ac25`, Sep 1): global OS shortcuts,
   floating indicator, ffmpeg audio recorder, IPC byte playback, hold-to-record,
   library + exclusive playback.
3. **Voice dictation phase** (`f98895f`–`12945d9`, Sep 1–4): model downloads +
   Whisper/Parakeet engines, voice-note hotkey + transcript sidecars, auto-paste with
   terminal detection + Wayland fallback, overlay animation galleries.

## Commit-by-commit difficulties

### `48d31a2` — global shortcuts
- **Difficulty**: two incompatible combo vocabularies (UI `Ctrl+Shift+A` vs plugin
  `shift+control+KeyA`); `Meta`→`Super` mapping; partial registration failures
  (already-grabbed hotkeys); register/unregister races → serialized promise `chain`.
- **Mitigation**: keep canonical-combo mapping in one tested module (done); treat
  "not registered" as a first-class UI state; add an accelerator-format regression table.

### `2309c2d` — floating shortcut indicator
- **Difficulty**: can't create a hidden+positioned+transparent+click-through window in
  one step (offscreen −10000 hack); **tao panics** if `setIgnoreCursorEvents` is called
  before the GTK window is realized; new webview misses events emitted before it
  existed → payload duplicated into localStorage + `emitTo`.
- **Mitigation**: extract one shared overlay-bootstrap helper (currently copy-pasted in
  `indicator.ts`/`recordingIndicator.ts`); always re-send state on window show.

### `aff2364` — audio recorder (1564 lines)
- **Difficulty**: native capture is hard → delegated to an `ffmpeg` subprocess
  (`-f pulse`); child-process lifecycle needed `libc::kill` SIGTERM + wait/kill
  fallback; more capabilities/`tauri.conf.json` churn.
- **Mitigation**: startup detection of ffmpeg + its input format with actionable setup
  guidance; feature-detect `libmp3lame`; keep the `Recording` guard struct.

### `5d3fbe7` — IPC byte playback
- **Difficulty**: asset-protocol playback evidently failed in the webview →
  `read_recording` returns raw bytes over IPC; blob URLs also sometimes failed →
  hand-rolled chunked base64 data-URL fallback. Extension allowlist added because the
  command is effectively an arbitrary-file-read primitive.
- **Mitigation**: prefer a properly-scoped `assetProtocol.scope` over IPC
  byte-shuttling for large files; confine `read_recording` to the recordings dir
  (currently only extension-checked — a security gap).

### `136ac25` — hold-to-record
- **Difficulty**: key-up semantics (modifiers release in any order), `event.repeat`
  auto-repeat, blur mid-hold, accidental 20 ms taps → `MIN_HOLD_MS = 300`; logic
  duplicated between app-scope (DOM events) and global-scope (plugin events) paths.
- **Mitigation**: document that one path owns a hold; add a lost-keyup timeout
  failsafe; factor the duplicated state machines.

### `fd54ea3` — voice-reactive level
- **Difficulty**: no DSP stack → parsed ffmpeg `astats` stdout as an API (−inf dBFS
  handling, throttle init offset).
- **Mitigation**: fine for visuals; switch to PCM pipe/cpal if levels drive more than
  visuals; keep the 50 ms throttle.

### `6316653` + `3ed55c9` — overlay window + transparency
- **Difficulty**: more capabilities churn (`recording-indicator` label); overlay
  `background: transparent` leaked into the main window through the shared CSS bundle
  → fixed with the `data-window` attribute scoping convention.
- **Mitigation**: adopt `data-window` scoping as a linting rule for overlay-only CSS;
  keep the "adding a window" checklist (doc 09).

### `49eff18` + `77a147f` — drifting dots / edge fades (later removed)
- **Difficulty**: visual tuning loops (6→16 dots, window 260×72→140×44, seamless loop
  via duplicated track + `mask-image` edge fades).
- **Mitigation**: keep animations CSS-var driven (`--voice-level`) rather than
  per-frame JS; the style galleries make future tuning cheap. Both styles were deleted
  by `2a87c31` — salvageable from git history if ever wanted back.

### `f98895f` — model downloads + engines (3453 lines; biggest commit)
- **Difficulty**: build-environment fight (libclang for bindgen, prebuilt
  sherpa-onnx/onnxruntime binaries) → sherpa behind an opt-in `parakeet` cargo
  feature; concurrency hygiene (cancel flags, stale-entry GC, `Arc::ptr_eq` ownership)
  implying debugging of stuck/double downloads; hardcoded sizes as integrity checks.
- **Mitigation**: pin `sherpa-rs` exactly + record the matching sherpa-onnx binary
  version; pin model URLs by HF revision or add hashes; add a cancel-then-restart
  integration test for the downloader.

### `65215df` — Parakeet fix (most instructive commit)
Four stacked problems, all with in-code comments:
1. **Wrong decoder → process abort**: sherpa-rs default selects the *icefall* decoder;
   NeMo graphs cause a C++ ONNX Runtime exception across the FFI → `Rust cannot catch
   foreign exceptions` → app dies. Fix: force `model_type: "nemo_transducer"` +
   regression test.
2. **`exit(-1)` in the C lib** on missing `<blk>` in `tokens.txt` (often an HF error
   page saved as the file) → Rust-side pre-validation returns a friendly error.
3. **HF metadata gap**: sherpa-onnx ≥1.11 requires `vocab_size`/`context_size` ONNX
   metadata the HF files lack → hand-built varint protobuf records **appended** to
   `decoder.int8.onnx` (`downloader.rs:208-278`).
4. **Re-download loop caused by the patch**: patched files exceed catalog
   `size_bytes` → ≤2048-byte tolerance special case in `is_downloaded`
   (`models.rs:304-333`).
Also: the `parakeet` feature was gutted (sherpa always on) — the opt-in build strategy
was abandoned rather than fixed.
- **Mitigation**: upstream the metadata patch or mirror decoders that already carry it;
  replace the size-tolerance hack with a patched-file manifest or content hashes;
  treat **all** engine inputs as hostile (FFI aborts kill the whole desktop app).

### `0e0bc51` + `959be5e` — voice-note + auto-paste v1
- **Difficulty**: cross-window state (pill must reflect transcription started anywhere);
  focus management (printing to Output would steal focus from the paste target).
- **Mitigation**: event-adoption in the transcriber store; the deliberate
  no-print-on-autoPaste rule in `AudioLibraryPage`.

### `12945d9` — paste modes (65-line file → 470-line rewrite)
- **Difficulty**: terminals don't bind Ctrl+V → 36-entry X11 `WM_CLASS` detector;
  enigo is X11-only → `wtype` Wayland fallback (fails by design on GNOME/Mutter);
  string-format variance everywhere → heavy unit tests; greetd unset
  `XDG_SESSION_TYPE` → `WAYLAND_DISPLAY && !DISPLAY` heuristic.
- **Mitigation**: keep the clipboard-first invariant; make the terminal list
  data-driven; document that `auto` terminal detection is X11-only.

### `2a87c31` / `bc31140` / `10a9d01` / `2b2069f` — animation galleries + sync fix
- **Difficulty**: localStorage not shared across webviews → `emitTo` event bus with
  validation (`10a9d01`); residual bug — broadcasts while the overlay doesn't exist
  are **lost** → re-sync on every show (`2b2069f`); webview quirks: SVG
  `<stop stopColor="var(...)">` doesn't work (inline style instead), `@property`
  conic-gradient doesn't animate (rotating `::before` layer instead).
- **Mitigation**: keep the push-on-show + event-adoption protocol; keep all style ids
  in one registry; consider moving style selection to the Rust settings store as the
  single authority.

## Cross-cutting lessons

1. **Multi-window state sync is the #1 recurring cost** — lost broadcasts, non-shared
   storage, state owned by whichever webview started the action. The push-on-show +
   event-adoption protocol (half-built in `indicatorStyle.ts`) should be formalized and
   applied to every overlay; move persistent selections into Rust settings.
2. **Native FFI can kill the process** — sherpa-onnx C++ exceptions / `exit(-1)` are
   uncatchable from Rust. Validate everything before crossing the FFI; keep regression
   tests; pin versions.
3. **Platform fragmentation is Linux-first reality** — X11 vs Wayland for input
   synthesis, external `wtype` dependency, Mutter's missing virtual-keyboard protocol,
   tao/GTK panics on unrealized windows, PulseAudio-only ffmpeg input. Keep
   clipboard-first and add startup capability detection with actionable errors.
4. **Config-fight surfaces**: `capabilities/default.json` (~6 commits), native-dep
   churn in `Cargo.toml`/`Cargo.lock`, `tauri.conf.json`. Keep the "adding a window"
   checklist documented.
5. **Workaround-on-workaround layering needs owners/tests**: ONNX patch → size
   tolerance; IPC bytes → base64 fallback; `@property` → pseudo-element. All are
   commented (good) but untested.
6. **Uneven test discipline** — `paste.rs`, `transcripts.rs`, `recorder.rs`,
   `parakeet_engine.rs` are tested; `downloader.rs` and `indicatorStyle.ts` are not.
7. **Highest-value hygiene step**: push the 10 unpushed commits and CI-run the Rust
   test suite on a real Linux X11 + Wayland matrix.
