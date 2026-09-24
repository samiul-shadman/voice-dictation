# 16 — Linux Production Readiness (deb + AppImage)

Status: pending. Supersedes the Linux-relevant subset of `14-audit-remediation.md`.
Depends on `15-indicator-mode.md` (landed).

## Goal

Ship a correct, installable Linux build — `.deb` and `.AppImage` — from a repo whose
CI actually runs. This is plan 14 re-scoped to a single platform: keep the parts that
make the Linux product correct, drop the parts that only exist to support the
deferred ports, and add the packaging/release work plan 14 treated as a non-goal.

Non-goals (explicitly deferred, do not fold in): Flathub, Windows, macOS beyond a
one-word compile fix, rpm, auto-updater, code signing, multi-monitor overlays,
tray/daemon mode, **E2E / automated hotkey-path testing**. The macOS/Windows source
stays in the tree but is not built or checked. Verification for the hotkey path
stays a manual Linux pass for now.

Scope decisions (confirmed):
- CI runs on `ubuntu-latest` only. `cargo check/test` + `tsc`/`vitest` on push/PR;
  bundles are produced only on `v*` tags.
- The macOS compile error is fixed with the one-word change so the tree stays
  coherent, but macOS is removed from CI.
- Full audit-14 Linux subset: P0 + P1 + P2 + P3, then release wiring.
- Public identity: productName `Voice Dictation`, identifier
  `com.samiulshadman.voicedictation` (derived from samiulshadman.com). First release
  version `0.1.0`.
- The repo goes public before this work starts (unmetered CI).
- Git: commit and push after each phase.
- E2E deferred: Phase E ships pure-logic tests only; the hotkey → clipboard path is
  covered by the manual Linux pass. The tiered E2E design is recorded below for when
  it is picked up.

## Verified line drift

Plan 14's line numbers no longer match. The refs in this plan were re-verified
against current `master`. Notable moves: `settings.rs` poison expects now at
111/117/127/131 (was 108/114/124/128); `recorder.rs` poison expect at 611 (was 518);
empty `catch {}` count is 17 (was 25).

---

## Phase A — Scope pipelines & metadata

- [ ] `.github/workflows/ci.yml:5` — trigger branch `main` → `master`.
- [ ] `.github/workflows/ci.yml:24` — matrix `os` → `[ubuntu-latest]` only (drop
      `macos-latest`, `windows-latest`).
- [ ] `.github/workflows/release.yml:14-26` — matrix → `ubuntu-latest` only; drop
      the macOS/Windows include entries and their artifact globs.
- [ ] `src-tauri/tauri.conf.json:33` — `"targets": "all"` → `["deb", "appimage"]`.
- [ ] `tauri.conf.json:3,5` — productName `local-audio-transcription-tool-v2` →
      `Voice Dictation`; identifier → `com.samiulshadman.voicedictation`. Do this
      before the first release: the identifier determines the config dir where
      `settings.json` lives, so changing it later orphans user settings. **Any
      existing local dev install must re-download its models / re-create settings.**
      Set version `0.1.0` (`tauri.conf.json:4`, `Cargo.toml:3`, `package.json:3`).
- [ ] `README.md:9-10, 52` — state Linux-first; drop the three-platform claims and
      the rpm mention.
- [ ] `src-tauri/src/sysinfo.rs:61` — call site `ax_is_process_trusted()` →
      `AXIsProcessTrusted()` (extern at `:67`). One word; keeps the public tree
      compiling on macOS even though mac is out of CI.
- [ ] Housekeeping: move `15-indicator-mode.md` → `completed/`; annotate
      `14-audit-remediation.md` as superseded by this plan for Linux.

## Phase B — P0 blockers

- [ ] `src-tauri/Cargo.toml:52-53` — `strip = "symbols"` → `"debuginfo"`; delete
      `panic = "abort"` (unwind is the default; both `catch_unwind` guards in
      `downloader.rs` / `transcriber.rs` start working in release).
- [ ] Document the unwind decision in `AGENTS.md` §Architecture invariants, including
      that `catch_unwind` does **not** cover `exit(-1)` / `SIGABRT` / foreign C++
      exceptions — validate-before-FFI stays mandatory.
- [ ] Add one shared helper `confine_to_audio_dir(app, path) -> Result<PathBuf, String>`
      applying `is_allowed_extension` + `is_path_within_dir` and returning the
      canonicalized path. Apply to:
      - `transcriber.rs:276` `get_transcript` (currently raw path → `load_sidecar`).
      - `transcriber.rs:218` `transcribe_file` (save at `:193` writes an arbitrary
        `<name>.transcript.json`).
      - `recorder.rs:~213, 231-240` `read_recording` and `:255` `delete_recording`.
- [ ] Fix the check-then-use TOCTOU: operate on the canonical path returned by the
      helper, not the original `target` (CWE-367).
- [ ] Tests: `../../etc/passwd`, non-audio extension, path outside `audio_dir`,
      symlink-inside-`audio_dir` escape.

## Phase C — P1 correctness

- [ ] `transcriber.rs:52-60` `TranscribeCompleteEvent` — add
      `#[serde(rename_all = "camelCase")]`; add a test asserting the serialized keys
      are camelCase.
- [ ] Surface `pasteError` (`src/lib/stores/transcriber.ts:11`) and
      `recorder.lastError` (`src/lib/stores/recorder.ts:19`) as toasts. Auto-paste is
      the product; a failure currently renders nothing.
- [ ] `downloader.rs:244-248` — decoder patch failure ⇒ `DownloadOutcome::Failed`
      with a user-facing message (today it `eprintln!`s and returns `Completed`).
- [ ] `models.rs:325` `size_accepted` — tolerance only applies *with* a manifest
      entry; without one require the exact pinned size.
- [ ] `models.rs:458` `delete_model` — evict `ENGINE_CACHE` (`transcriber.rs:88`).
- [ ] `transcriber.rs` — re-run `verify_model_paths` before each recognition, not
      only on cache miss.
- [ ] Delete the dead branch at `models.rs:~308` (the `:304` path already returned).
- [ ] `downloader.rs:145` `request_cancel` — join (or hard-abort) the reader thread on
      both cancel and stall paths; only `Disconnected` joins today (`:347`). Keep the
      active entry until the thread exits; add an `is_cancelling` state distinct from
      `is_downloading`. Test: cancel mid-download ⇒ no `.part` remains, restart works.
- [ ] `recorder.rs:182,191,657,678` — replace `.recv()` with `recv_timeout`; on timeout
      return the honest error and leave `stopping` consistent.
- [ ] `recorder.rs:171` — wait for `done_rx` before `remove_file` (start/stop race
      truncates/orphans the file).
- [ ] `recorder.rs:711` `next_recording_path` — reserve with `File::create_new` or hold
      the lock across selection + registration (TOCTOU).
- [ ] Add a `recheck_environment` command (or make `detect_environment` re-detect) and
      call it when Settings → Environment mounts.
- [ ] Move the startup `wtype --help` spawn (`sysinfo.rs:75-79`) off the hot path, or
      make it lazy. (macOS Accessibility gate deferred with the port.)

## Phase D — P2 hygiene

- [ ] `tauri.conf.json:28` — `"csp": null` → at least `default-src 'self'`.
- [ ] `capabilities/default.json:25-26` — remove `clipboard-manager:allow-write-text`
      / `allow-read-text`; the frontend uses `navigator.clipboard`
      (`SettingsPage.tsx:166`, `TranscriptPanel.tsx:23`) and the Rust side uses
      `ClipboardExt` (no capability). Verify on the X11 smoke pass.
- [ ] Split capabilities so overlays inherit only `core:window:allow-*` + events —
      not `global-shortcut:*` or `core:webview:allow-create-webview-window`
      (invariant #3: one registration owner).
- [ ] `opener:default` → `allow-open-path` + `allow-reveal-item-in-dir`.
- [ ] Poison-recovery: replace the six `.expect("... lock poisoned")` with
      `poisoned.into_inner()` — `settings.rs:111,117,127,131`, `sysinfo.rs:28`,
      `recorder.rs:611`.
- [ ] `src/pages/ModelsPage.tsx:61-81` — add a `disposed` guard (unlistens are pushed
      after `await listen`, leaking and setting state after unmount).
- [ ] `src/components/ui/Dialog.tsx:70` — stop depending on the inline `onClose`
      (focus is yanked on every parent render); use a ref'd callback or split the
      effect.
- [ ] `src/components/feature/RecordingPill.tsx:17/61/78` — drop the `useLevel()`
      React-state transport; keep only the rAF `--voice-level` write (invariant #6).
- [ ] `src/lib/audioPlayback.ts:10` — bound `urlCache` (LRU ~8) and revoke on evict.
- [ ] `src/lib/OverlaySync.tsx` — call `syncVisibility()` at mount (an in-flight
      recording at startup shows no overlay until the next event).
- [ ] Audit the 17 empty `catch {}` blocks; worst is the event-subscription failure in
      `stores/transcriber.ts` that silently freezes progress UI.
- [ ] `sysinfo.rs` `run_with_timeout` — use `child.kill()` instead of `kill(pid)`
      without reaping (PID recycling).
- [ ] Dead code: `Field`/`Select`/`TextInput` exports, `default_recordings_dir`,
      `transcriber.rs:220` unused `window`, unused `regex` dep, stale
      `#[allow(dead_code)]` at `paste/mod.rs:53` and `settings.rs:106`,
      `models.rs:421` `pub` `ensure_model_ready`.

## Phase E — P3 testing

- [ ] `sysinfo.rs` tests: `detect_session_type`, the mac/windows
      `accessibility_permission` shape, `run_with_timeout` happy path. (Currently zero
      tests, and it holds the only `unsafe` FFI.)
- [ ] Add jsdom + React Testing Library.
- [ ] Fix the tautological `registry.test.ts` (`expect(style.render(...)).toBeTruthy()`).
- [ ] `engine.test.ts` — mock the full `engine.ts` surface so a new dependency fails
      loudly instead of becoming `undefined`.
- [ ] Cover the settings mutation path (`update_settings` / `diff_fields` /
      `emit_settings_changed`).
- [ ] Add the symlink case to the path-confinement tests (Phase B).
- [ ] **E2E deferred (do not implement in this pass).** The hotkey → clipboard path
      is verified manually. The tiered design is kept below as reference for a later
      milestone.

## E2E feasibility (hotkey → clipboard) — deferred reference

Not implemented in this pass. Kept so a later milestone starts from the real path
rather than re-deriving it.

How the path works today, so the test can target it:

1. The `main` window registers accelerators via the global-shortcut plugin
   (`engine.ts:228`); overlays never register (guarded at `engine.ts:270-276`).
2. A hotkey fires `Pressed`/`Released` → `dispatchShortcut` (`engine.ts:144`) →
   `hold.ts` debounce → `startRecording` / `endVoiceNoteHold` (`voiceNote.ts`).
3. `start_recording` (Rust) opens a cpal input stream and a writer thread; stop
   swaps the recording out and finalizes on a detached thread.
4. `transcribeFile(path, true)` → `transcribe_file` → sherpa engine →
   `paste_transcript` (`paste/mod.rs:147`): write text to the clipboard first, then
   sleep, then synthesize Ctrl+V (enigo) or wtype on Wayland.
5. The transcript is therefore on the clipboard even if synthesis fails — the
   assertion target for an E2E is `xclip -o`.

CI constraints: no microphone, no display, no model. A full E2E needs all three
(Xvfb for X11 key grabs, a PulseAudio/ALSA loopback as a virtual mic fed a fixed WAV
fixture, and a cached Parakeet model). Proposed tiers:

- **Tier 1 (cheap, recommended default):** Rust integration test that calls the
  transcribe→paste pipeline on a committed short WAV fixture with a cached model,
  asserting the clipboard content. Exercises the product's riskiest half
  (transcribe + paste) without the OS hotkey or mic.
- **Tier 2 (full):** Xvfb + `module-null-sink` virtual source + `xdotool key` to
  fire the hotkey + focused `xterm` + `xclip -o` assertion. Covers the whole path
  but is slow and flake-prone; gate it behind a separate workflow or manual dispatch.

## Phase F — Release readiness

- [ ] `release.yml` on `v*` tags builds `.deb` + `.AppImage` and uploads both.
- [ ] Decide the first public version (currently `0.1.0`).
- [ ] Version/changelog policy.
- [ ] Smoke the produced `.AppImage` and `.deb` on a clean X11 session.
- [ ] Verify AppIndicator behavior inside the AppImage (the tray lib is dlopened;
      floating is the default, so a missing lib should degrade, not crash).

## Verification

Per phase:
- [ ] `cd src-tauri && cargo check --all-targets` green on Linux.
- [ ] `cd src-tauri && cargo test` green.
- [ ] `bun run build` green.
- [ ] `bunx vitest run` green.
- [ ] New tests land alongside each fix (B, C, E).

Manual (Linux X11 reference platform):
- [ ] hold → speak → release → text in a focused editor; toggle mode; cancel.
- [ ] model download + cancel + delete; imported mp3/m4a transcribe + playback.
- [ ] overlay pills; panel surface; settings persistence.
- [ ] no-regression pass after each phase.

## Definition of done

- CI is green on Linux, observed (not "should be").
- Zero commands accept an unconfined path.
- No `.expect()` on a command path; `panic = "abort"` gone and the unwind strategy
  documented in `AGENTS.md`.
- Auto-paste failure is visible to the user.
- `cargo test` covers `sysinfo.rs`.
- A tagged release produces working `.deb` + `.AppImage`.
- Manual Linux pass complete (hotkey path included); E2E remains a logged follow-up.

## Pitfalls (preserve these)

- **Never re-add `panic = "abort"`.** It silently disables both `catch_unwind` guards
  with no compile error and no test failure.
- **`catch_unwind` does not catch everything.** Not `exit(-1)`, `SIGABRT`, or foreign
  C++ exceptions — it is *not* the sherpa mitigation.
- **sherpa aborts the process on invalid ONNX.** Every relaxation of
  validate-before-FFI is a process-death risk.
- **Cancel semantics are easy to fake.** Dropping a map entry is not cancellation;
  the thread must stop before anything unlocks.
- **`is_path_within_dir` must be applied to the canonicalized path *and* the operation
  must use that same canonicalized path.**
- **Don't regress Linux.** It is the reference platform.

## Suggested order

A → B → C → D → E → F. Push after each phase.
