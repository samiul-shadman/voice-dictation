# 14 — Audit Remediation (code quality + architecture debt)

Status: superseded on Linux by `16-linux-production-readiness.md`, which re-scopes
this audit to the deb/AppImage target and re-verifies the drifted line numbers. The
macOS/Windows items here remain the reference for when those ports resume.

Origin: full-codebase audit (11k LOC, 4 commits) after the cross-platform port landed.
The app is functionally complete on paper (M0–M5 all landed) but has one
disqualifying defect — **the macOS build does not compile** — plus a set of
invariant violations, two unbounded-resource leaks, and a silent failure on the
product's single most important path (auto-paste).

This plan is ordered by severity, not by module. P0 unblocks the port; P1 fixes
things that lose data or lie to the user; P2 is hygiene; P3 is what stops the
next one of these from shipping.

---

## Goal

Get from "complete on paper" to "actually correct on three platforms" without
regressing Linux — the reference platform stays byte-for-byte.

Non-goals (do not fold into this work): tray/daemon mode, auto-updater, code
signing, multi-monitor overlays. All four are already deferred in
`13-cross-platform.md` and `00-master-plan.md` §5.

---

## P0 — Blockers

### P0.1 macOS does not compile

`src-tauri/src/sysinfo.rs:58` calls `ax_is_process_trusted()`; the extern block at
`sysinfo.rs:64` declares `AXIsProcessTrusted()`. No `#[link_name]`, no alias,
nothing else in the tree defines the lowercase name → `E0425` on every macOS
target. `.github/workflows/ci.yml:20-24` runs `cargo check --all-targets` on
`macos-latest`, so that job is either red or has never run.

Tasks:
- [ ] Rename the call site to `AXIsProcessTrusted()`.
- [ ] Add a CI run on macOS and confirm `cargo check --all-targets` is green
      before touching anything else — everything below assumes a building tree.

### P0.2 `panic = "abort"` silently deletes both panic guards

**Decision: switch to unwind.**

`src-tauri/Cargo.toml:46` sets `panic = "abort"` for release. `downloader.rs:183`
and `transcriber.rs:241` both rely on `catch_unwind` to turn a worker panic into a
user-facing `model-download-error` / `transcribe-error` event. Under abort the
process dies before any unwinding starts — the guards are dead code in release.
Same for the six `.expect("... lock poisoned")` sites (`settings.rs:108,114,124,128`,
`sysinfo.rs:25`, `recorder.rs:518`): in release these are process death, not an
error return.

Why unwind wins here:
- Dev does not set `panic`, so it defaults to `unwind` — the guards work locally
  and the app never shows you the release failure mode. That divergence is worth
  more than the size saving on its own.
- The size saving is a few MB at most (`opt-level="z"` + `lto` + `strip` already
  did the heavy lifting; most of the binary is statically-linked sherpa-onnx, which
  is unaffected). Models are 652 MB each (`models.rs:62`). The trade is noise.
- This app is panic-prone by nature: realtime cpal callbacks, FFI, background
  downloads, arbitrary user-supplied audio files through symphonia.

Tasks:
- [ ] Delete `panic = "abort"` from `Cargo.toml:46`. Unwind is the default — this
      one line is the whole fix; both `catch_unwind` guards start working in
      release with no code change.
- [ ] Consider `strip = "debuginfo"` instead of `strip = "symbols"` (`Cargo.toml:45`).
      With symbols stripped, unwinding gives you a panic message but
      `RUST_BACKTRACE` has no function names — which undercuts the
      diagnosability being bought here.
- [ ] Document the choice in `AGENTS.md` §Architecture invariants so nobody
      re-adds `panic = "abort"` and silently re-breaks the guards.
- [ ] Add a note there that `catch_unwind` cannot catch `exit(-1)` / `SIGABRT` /
      foreign C++ exceptions — it does **not** cover the sherpa FFI risk in
      invariant #2. Validate-before-FFI (P1.3–P1.5) stays mandatory and
      independent of this decision.

### P0.3 `get_transcript` is an unconfined arbitrary file read

`transcriber.rs:275-278` passes a raw webview-supplied `path` straight to
`load_sidecar`. No `is_allowed_extension`, no `is_path_within_dir`. Any JSON on
disk that deserializes into `TranscriptData` (unknown fields ignored) is returned
verbatim. Sibling commands `read_recording` / `delete_recording`
(`recorder.rs:220-263`) get this right — this is the one command that violates
invariant #7.

### P0.4 `transcribe_file` is an arbitrary filesystem write

`transcriber.rs:217-223` takes any absolute path, and on success
`transcribe.rs:193` calls `save_sidecar`, writing `<name>.transcript.json` next to
whatever path the webview chose. Should be confined to `audio_dir` exactly like
`read_recording`.

Tasks (P0.3 + P0.4 together):
- [ ] Add one shared helper — `confine_to_audio_dir(app, path) -> Result<PathBuf, String>`
      — that applies `is_allowed_extension` + `is_path_within_dir` and returns the
      **canonicalized** path.
- [ ] Use it in `get_transcript`, `transcribe_file`, `read_recording`,
      `delete_recording`.
- [ ] Fix the TOCTOU while there: `recorder.rs:227-246` canonicalizes for the
      check but then operates on the original `target` (`:246`, `:261`). Act on
      `canonical_target` (CWE-367).
- [ ] Tests: symlink-inside-audio-dir escape, `../../etc/passwd`, non-audio
      extension, path outside `audio_dir`.

---

## P1 — Correctness: user-visible failure

### P1.1 Auto-paste failure is structurally invisible

`transcriber.rs:58-59` emits `pasteError`; `src/lib/stores/transcriber.ts:11`
declares it; **no component reads it** (grep: zero consumers outside the
declaration). Auto-paste is the product. When it fails the user gets nothing.
Same shape: `src/lib/stores/recorder.ts:19` `lastError` — a failed stop or discard
renders literally nothing, and `RecordingButton.tsx:56-64` `handleDiscard` has no
`catch`.

Tasks:
- [ ] Consume `pasteError` in the transcriber store and surface it as a toast
      ("could not paste automatically — the transcript is on your clipboard").
- [ ] Wire `lastError` into a toast on stop/discard failure.
- [ ] Add `pastError` / `autoPaste` / `modelId` to the store's consumed fields so
      they stop being dead declarations.

### P1.2 `transcribe-complete` breaks the camelCase wire contract

`transcriber.rs:52-60` — `TranscribeCompleteEvent` is the only emitted struct
missing `#[serde(rename_all = "camelCase")]` (compare `recorder.rs:20`,
`models.rs:12`, `sysinfo.rs:7`). It emits `model_id`, `duration_ms`, `auto_paste`,
`paste_error`; TS declares `modelId`, `durationMs`, `autoPaste`, `pasteError`.
Latent only because nothing reads those fields yet — i.e. latent only because of
P1.1. Fix both together.

Tasks:
- [ ] Add `#[serde(rename_all = "camelCase")]`.
- [ ] Add a Rust test asserting the serialized keys are camelCase (cheap guard
      against the next struct).
- [ ] Grep every emitted struct and confirm the attribute is present.

### P1.3 Decoder patch failure is reported as success

`downloader.rs:241-246` — `patch_parakeet_decoder` fails → `eprintln!`, delete
manifest, still return `DownloadOutcome::Completed`. Frontend shows
`model-download-done`. Per invariant #2 an unpatched decoder makes sherpa abort the
process. This is the exact failure mode the invariant exists to prevent.

### P1.4 Decoder size tolerance admits an unpatched decoder

`models.rs:332` — with no manifest, any `decoder.int8.onnx` within ±2048 bytes of
the pinned size passes `verify_dir_with`. An *unpatched* decoder (missing
`vocab_size` / `context_size`) sails through to sherpa.

### P1.5 Engine cache bypasses validate-before-FFI

`transcriber.rs:129-135` re-validates only on cache miss; afterwards every
transcription uses the engine with zero on-disk re-validation. And `delete_model`
(`models.rs:458`) never evicts `ENGINE_CACHE` — you can delete a cached model's
files out from under a live engine.

Tasks (P1.3–P1.5):
- [ ] Patch failure ⇒ `DownloadOutcome::Failed` with the user-facing message.
- [ ] Tighten `size_accepted`: tolerance applies only *with* a manifest entry;
      without one, require the exact pinned size.
- [ ] Evict `ENGINE_CACHE` in `delete_model` and in any model-dir change.
- [ ] Re-run `verify_model_paths` before each recognition, not only on cache miss
      (it is a few `metadata` calls; measure before objecting).
- [ ] Delete the dead branch at `models.rs:308-314` (`:304` already returned early).

### P1.6 `cancel_download` does not cancel

`downloader.rs:322-352` — on cancel/stall the reader thread is abandoned: the
socket + thread leak and keep writing a `.part` that was just `remove_file`d
(`:328`, `:338`). Only the `Disconnected` branch (`:344`) joins. And because
`request_cancel` (`:143`) drops the map entry immediately, `is_downloading` goes
false, so `delete_model` (`models.rs:460`) and `set_models_dir` (`models.rs:490`)
unlock while the old thread still writes — and a second `start_download` happily
writes the same `.part`.

Tasks:
- [ ] Join (or hard-abort) the reader thread on both the cancel and stall paths.
- [ ] Keep the active entry until the thread has actually exited; add an
      `is_cancelling` state distinct from `is_downloading`.
- [ ] Test: cancel mid-download ⇒ no `.part` files remain and a restart succeeds.

### P1.7 Stop / cancel can hang forever

`recorder.rs:169-184` — `.recv()` with no timeout on an `#[tauri::command(async)]`
command. `finish_stop` (`:562`) blocks on `done_rx.recv()`; if the mp3 encoder or
disk stalls, an async-runtime worker thread is consumed permanently and the UI
waits forever. Same in `finish_cancel` (`:585`).

Tasks:
- [ ] `recv_timeout` with a bounded wait; on timeout return the honest error
      ("the recording took too long to finalize") and leave `stopping` consistent.
- [ ] Add a test for the timeout branch shape.

### P1.8 Start/stop race clobbers files

`recorder.rs:158-162` — cleanup drops `stream` + `chunk_tx` and immediately
`remove_file(&path)` while the writer thread (`:122-131`) is still draining.
Result: orphaned or truncated file on disk.

Tasks:
- [ ] Wait for `done_rx` (with timeout, per P1.7) before removing the file.
- [ ] Fix the `next_recording_path` TOCTOU (`recorder.rs:618`: `while path.exists()`
      then a later `File::create` in the writer thread) — reserve with
      `File::create_new` or hold the lock across path selection + registration.

### P1.9 `sysinfo` is a frozen startup snapshot

`sysinfo.rs:18-21` writes once at setup; `:36-39` returns the cache forever. No
re-detect path exists (grepped: single writer). Plug in a mic → the card never
updates. On macOS `accessibility_permission` is captured before permission was
ever granted and is permanently `None`.

Consequence: **`paste_transcript` synthesizes input on macOS without ever checking
Accessibility** — `paste/mod.rs:147-207` never reads `accessibility_permission`.
`AGENTS.md` says "never synthesize input without checking `sysinfo` first". The
guard does not exist.

Tasks:
- [ ] Add a `recheck_environment` command (or make `detect_environment` re-detect
      on demand) and call it when the Settings → Environment page mounts.
- [ ] Gate macOS paste behind `accessibility_permission == Some(true)`; surface a
      setup card instead of synthesizing when it is false.
- [ ] Remove the startup `wtype --help` spawn (`sysinfo.rs:73-78`) from the hot
      path, or make it lazy — it costs a spawn on every launch and up to 5 s on a
      hung binary.

---

## P2 — Architecture hygiene

### P2.1 Duplication (six classes, one helper each)

| Duplicated | Sites | Fix |
|---|---|---|
| Atomic write (`tmp` → rename → remove-tmp) | `settings.rs:188`, `transcripts.rs:13`, `models.rs:125`, `models.rs:315` | one `atomic_write(path, bytes)` helper |
| Sidecar path | `transcripts.rs:6` vs `recorder.rs:292` (divergent failure behaviour) | keep one, `pub(crate)` |
| Mono mixdown | `audiodecode.rs:14` vs `recorder.rs:355` | one shared fn |
| Writable probe | `settings.rs:282` (`.write`) vs `models.rs:502` (`.write_test`) | one helper |
| Overlay lifecycle (TS) | `windows/indicator.ts:13-22` ≡ `windows/recordingIndicator.ts:13-26` | one factory over `overlay.ts:11` |
| Error → string (TS) | 9 identical copies: `recorder.ts:31`, `downloads.ts:34`, `voiceNote.ts:7`, `TranscriptPanel.tsx:43`, `RecordPage.tsx:40`, `LibraryPage.tsx:29`, `ModelsPage.tsx:29`, `SettingsPage.tsx:120`, `ShortcutsPage.tsx:47` | one `lib/errors.ts` |

### P2.2 Capabilities / blast radius

- [ ] `tauri.conf.json:27-29` — `csp` is `null`. Set at least `default-src 'self'`.
- [ ] `capabilities/default.json:25-26` — `clipboard-manager:allow-read-text` and
      `allow-write-text` are granted but the plugin is never imported (frontend
      uses `navigator.clipboard`). Delete both; the Rust side uses `ClipboardExt`
      and needs no capability.
- [ ] Split capabilities: overlays inherit `global-shortcut:allow-register/unregister`,
      `core:webview:allow-create-webview-window`, `dialog`, `opener`, clipboard.
      They need `core:window:allow-*` + events only. The current single file
      contradicts invariant #3 (one registration owner).
- [ ] `opener:default` implies `allow-open-url`; tighten to `allow-open-path` +
      `allow-reveal-item-in-dir`.
- [ ] Longer term: create the two overlays in Rust and drop
      `core:webview:allow-create-webview-window` entirely — it is the single most
      dangerous core permission here.

### P2.3 Poison-recovery on the remaining `.expect` sites

Demoted from P0.2: unwind means the app survives these, but they still fail the
command with a bare panic instead of a real error. `settings.rs:114` is inside
`with_settings`, which every command calls — the blast radius is the whole app.

- [ ] Replace all six `.expect("... lock poisoned")` with `poisoned.into_inner()`,
      matching `transcriber.rs:127`, which already does this correctly:
      `settings.rs:108,114,124,128`, `sysinfo.rs:25`, `recorder.rs:518`.
- [ ] Add a lint gate (or a grep in CI) so no new `.expect()` lands on a command path.

### P2.4 Frontend + worker state and resource bugs

- [ ] `ModelsPage.tsx:59-83` — listener leak + setState-after-unmount: `unlisten`
      fns are pushed *after* `await listen(...)` with no `disposed` guard (correct
      pattern already exists at `OverlaySync.tsx:98-102`).
- [ ] `Dialog.tsx:33-70` — deps `[open, onClose]`, and `onClose` is an inline arrow
      at `LibraryPage.tsx:260` / `ModelsPage.tsx:267`. Focus is yanked back on
      every parent render (click Delete → focus jumps to Cancel mid-operation).
      Use a ref'd callback or split the effect.
- [ ] `RecordingPill.tsx:17,54-67` — level is in React state (20 Hz re-render)
      *and* a rAF loop writes `--voice-level`. Two transports for one value,
      violating invariant #6. Drop the subscription; `level` is passed to
      `render()` at `:81` and no animation style reads it anyway.
- [ ] `audioPlayback.ts:10` — `urlCache` retains every recording's full
      `ArrayBuffer` + object URL for process lifetime. Bound it (LRU, ~8 entries)
      and revoke on evict.
- [ ] `OverlaySync.tsx:89-91` — `syncVisibility` is never called at mount, so a
      recording already in flight at startup shows no overlay until the next event.
- [ ] 25 empty `catch {}` blocks. Worst: `transcriber.ts:72` — a failed event
      subscription silently freezes all progress UI. Audit each; log or surface.
- [ ] `sysinfo.rs:129-140` `run_with_timeout` never joins the waiter thread and
      `kill`s `pid` without reaping — on timeout the PID may have been recycled.
      Use `child.kill()` instead.

### P2.5 Dead code

- [ ] `Field`, `Select`, `TextInput` — exported from `components/ui/index.ts:14-19`,
      imported nowhere. Delete or use.
- [ ] `default_recordings_dir` (`recorder.rs:265`) is `settings.audio_dir` verbatim,
      already available via `get_settings`.
- [ ] `transcriber.rs:220` — `window: tauri::Window` immediately `let _ = window`.
- [ ] `Cargo.toml:26` — `regex` unused. `:25` `libc` and `:27` `toml` are Linux-only
      in practice; move under `[target.'cfg(target_os = "linux")'.dependencies]`.
- [ ] `paste/mod.rs:53` — stale `#[allow(dead_code)]` (`CmdV` is matched on every
      platform). `settings.rs:106` — stale allow on `warning()`.
- [ ] `models.rs:421` — `ensure_model_ready` is `pub` in a crate-internal module.

---

## P3 — Testing & hardening

Reality today: **no integration or E2E test exists.** The product's core path
(hold hotkey → speak → release → text lands in the focused app) has never been
automatically exercised. Frontend: 41 tests / 5 files, all pure logic. Rust: ~67
tests, all pure logic.

- [ ] **`sysinfo.rs` has zero tests** — and it holds the only `unsafe` FFI, the
      platform cfg fan-out, and the compile error. Add tests for `detect_session_type`,
      the mac/windows `accessibility_permission` shape, and a `run_with_timeout`
      happy path.
- [ ] `paste/mod.rs:338,363` — the macOS and Windows test modules never execute on
      Linux CI. Either run them somewhere or note the gap explicitly.
- [ ] Add jsdom + React Testing Library. Without it the Dialog focus bug, `KeyInput`
      capture lifecycle, and every page flow are structurally untestable.
- [ ] Fix the tautological test: `registry.test.ts:26-43` asserts
      `expect(style.render(...)).toBeTruthy()` — a React element is always truthy.
      The out-of-range-percent case proves nothing.
- [ ] `engine.test.ts:63-73` mocks only the 3 currently-used functions; a new
      dependency in `engine.ts` becomes silently `undefined` instead of failing.
- [ ] Cover the settings mutation path (`update_settings` / `diff_fields` /
      `emit_settings_changed`) — currently untested.
- [ ] Add the symlink case to the path-confinement tests (P0.4).
- [ ] One real E2E: script a hotkey press and assert the clipboard receives the
      transcript. Even a Linux-X11-only CI job is worth more than 40 unit tests here.

---

## Pitfalls (preserve these)

- **Never re-add `panic = "abort"`.** It silently disables both `catch_unwind`
  guards (P0.2) with no compile error and no test failure — the code looks
  identical and the safety is simply gone. It is documented in `AGENTS.md` now;
  if a size win is ever wanted, measure it against a 652 MB model first.
- **`catch_unwind` does not catch everything.** It cannot catch `exit(-1)`,
  `SIGABRT`, or foreign C++ exceptions. It covers Rust-side panics only
  (symphonia on malformed audio, downloader parse errors, mutex poisoning) — it
  is *not* the sherpa mitigation.
- **sherpa aborts the process on invalid ONNX** — every relaxation of
  validate-before-FFI (tolerance, cache, patch-failure-swallow) is a process-death
  risk, not a quality risk. P1.3–P1.5 exist for this reason.
- **Cancel semantics are easy to fake.** Setting a flag and dropping the map entry
  looks like cancellation and is not. The thread must actually stop before anything
  unlocks.
- **`is_path_within_dir` must be applied to the canonicalized path *and* the
  operation must use that same canonicalized path** — check-then-use on two
  different values is CWE-367.
- **`strip = "symbols"` plus unwind gives half a diagnosis.** You get the panic
  message but no function names in `RUST_BACKTRACE`. P0.2 covers switching to
  `strip = "debuginfo"` if backtraces are wanted.
- **Don't regress Linux.** It is the reference platform and the only one with any
  manual verification. Run the Linux smoke pass after each phase.

---

## Verification

Per phase:
- [ ] `cd src-tauri && cargo check --all-targets` green on **all three** CI OSes
      (this is currently false — P0.1).
- [ ] `cargo test` green; `bunx vitest run` green; `bun run build` green.
- [ ] New tests land alongside each fix (P0.4, P1.6, P1.7, P3).

Manual (blocked on real hardware — see `13-cross-platform.md:60-62`):
- [ ] Linux X11: hold → speak → release → text in a focused editor; toggle mode;
      cancel; model download + cancel + delete; imported mp3/m4a transcribe +
      playback; overlay pills; settings persistence.
- [ ] macOS: same pass, plus confirm the Accessibility card appears and paste is
      refused when the permission is absent (P1.9).
- [ ] Windows: same pass.
- [ ] Explicit Linux no-regression pass after each phase.

## Definition of done

- CI is green on ubuntu/macos/windows — not "should be", actually observed.
- Zero commands accept an unconfined path.
- No `.expect()` on a command path; `panic = "abort"` is gone and the unwind
  strategy is documented in `AGENTS.md`.
- Auto-paste failure is visible to the user.
- `cargo test` covers `sysinfo.rs`; frontend has one E2E of the hotkey path.
- `AGENTS.md` invariants updated where this plan changed the contract (panic
  strategy, revalidation-on-every-recognize).

## Suggested order

P0.1 (one word, unblocks everything) → P0.2 → P0.3+0.4 → P1.1+1.2 → P1.3–1.5 →
P1.6 → P1.7+1.8 → P1.9 → P2 → P3. Push after each phase.
