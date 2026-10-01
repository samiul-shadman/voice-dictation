# 17 — Engine Prewarm & Honest Transcription Timings

Status: **planned — not started.** Do not implement until explicitly told to.

## Goal

The first transcription after every app launch is several seconds slower than every
one after it. Remove that penalty, and fix the two measurement bugs it exposes.

Two deliverables, both rooted in the same lazy `ENGINE_CACHE`:

1. **The engine is already warm by the time the user needs it.** A background prewarm
   loads it at launch and again (idempotently) on recording start.
2. **Reported timings are true.** The first transcript's `durationMs` currently
   includes the model load and is persisted to the sidecar, and the progress bar
   races to 99 % and freezes during the load.

Non-goals (explicitly deferred, do not fold in):

- **Engine eviction / idle-unload.** Decided *against* — see "Scope decisions". The
  engine stays resident for the process lifetime.
- **Child-process model probe** (`--probe-model <dir>` re-exec). A real alternative to
  the crash-marker for zero launch-crash exposure, at the cost of a second load per
  `EngineKey`. Recorded in "Residual risk" as the escape hatch, not built here.
- **A permanent sidecar process** hosting the engine. Would also survive ONNX aborts
  *during* transcription, but is a much larger diff.
- **An "indeterminate" animation mode** for the recording pill.
- **OS/desktop notifications.** `tauri-plugin-notification` is not a dependency and
  could not help: the process that would fire it is already dead.

## Root cause

`ENGINE_CACHE` (`transcriber.rs:89`) is a process-global
`Mutex<Option<(String, TransducerEngine)>>` that starts as `None`, and nothing loads
it at startup. The first `transcribe_file` call falls into the `stale` branch of
`with_engine` (`transcriber.rs:130-134`) and pays `load_engine`
(`parakeet_engine.rs:38-44`): a full ONNX Runtime session over the 652 MB
`encoder.int8.onnx` — graph init, weight load, arena allocation, 2-thread pool
spin-up (`num_threads = 2`, `parakeet_engine.rs:30`).

Every later call is a cache hit. So it is "first after **each app launch**", not first
ever. Two smaller first-run-only costs stack on top: the 652 MB may not be in the OS
page cache (adds a disk read), and ORT's first `Run()` faults in the weight pages and
grows its arena.

## Scope decisions (confirmed):

- **Never evict.** The engine lives for the process lifetime. The cost is a permanent
  **~700 MB–1 GB RSS** — that is the deliberate trade, and the reason idle-unload was
  considered and dropped.
- **A+B hybrid prewarm:** launch prewarm *and* a recording-start kick. Idempotent under
  the `ENGINE_CACHE` mutex, so the double-kick needs no coordination flag.
- **Both prewarm sites are ungated.** Prewarm runs on fresh installs, not just after a
  proven success.
- **The `start_recording` kick is ungated** — the load overlaps the user's first
  dictation, and an abort there happens while they are already interacting rather than
  at launch.
- **Safety is a crash-marker file, not a settings flag.** No `AppSettings` field, no
  `diff_fields` entry, no clearing in `set_default_model` / `set_models_dir`.
- **Verify SHA-256 at download finalize; do not persist the hashes.**
- Engine cache key must include the models directory (Phase A).
- One new command (`get_startup_notice`) — a necessary exception to "keep the frontend
  command surface stable", because `get_settings_warning` is structurally the wrong
  channel (see Phase F).
- Commit style: short imperative subject; push after each phase.

---

## Phase A — Engine cache key + shared staleness check

The cache is keyed on `model_id` alone, which is safe *today* only because `BUSY`
(`transcriber.rs:85`) serialises transcriptions and the cache is always empty right
after `evict_all_engines()`. A background prewarm thread destroys both safety
properties. Concretely: prewarm starts loading from `~/models` → user changes the
models dir → `set_models_dir` evicts (`models.rs:511`) → prewarm finishes and writes
an engine from the *old* directory → the next transcription's key matches and silently
uses the old model.

- [x] `transcriber.rs:89` — key becomes `EngineKey { model_id: String, dir: PathBuf }`
      (`dir` = `paths.encoder.parent()`), `ENGINE_CACHE` becomes
      `Mutex<Option<(EngineKey, TransducerEngine)>>`. Deriving `dir` from the loaded
      path means the key describes where the files *actually came from*, so it cannot
      disagree with a separate lookup.
- [x] `transcriber.rs:122-137` — extract the inline staleness check into
      `load_if_stale(&mut Option<(EngineKey, TransducerEngine)>, &ModelPaths) -> Result<bool, String>`
      shared by `with_engine`, `ensure_engine` and `prewarm`. Three call sites must not
      each grow their own copy — this is also what keeps invariant 2 (validate before
      FFI, `parakeet_engine.rs:39`) in exactly one place.
- [x] Add `ensure_engine(&ModelPaths) -> Result<bool, String>` (returns whether it
      loaded) and `engine_is_cold(&ModelPaths) -> bool`.
- [x] `with_engine` keeps its current signature **and its fallback-reload behaviour**:
      if eviction lands between `ensure_engine` and `with_engine`, the second call
      reloads rather than panicking.
- [x] Mutex poisoning: every lock already uses `poisoned.into_inner()`. Keep it.

### Landed notes

`ensure_engine` and `engine_is_cold` are not called by anything yet, so `cargo check`
emits two `dead_code` warnings. They are consumed by Phase C (`ensure_engine`,
`engine_is_cold`) and Phase E (`prewarm`) and the warnings clear then. There is no
`#![deny(warnings)]` in the crate, so this does not gate.

`lock_engine_cache()` was added alongside `load_if_stale` to collapse the three
identical poison-recovering lock blocks into one; that was not in the original plan but
the duplication would otherwise have grown by one with `prewarm`.

An audit confirmed the change is compile-only: no existing test touched `ENGINE_CACHE`,
`with_engine`, or either evict function, and no other module names the cache type. It
also confirmed `PathBuf`'s `PartialEq` is **component-wise**, so the new `dir` component
can only ever cause a redundant reload, never a false hit — two paths that compare
equal cannot be different directories. That one-sided property is locked by
`engine_key_mismatch_can_only_cost_a_reload_never_the_wrong_engine`.

## Phase B — `phase` on progress events

Pure data-model change, no behaviour. Done in isolation so Phase C and Phase H are
wiring rather than design under pressure.

- [x] `transcriber.rs:23-51` — `ProgressEvent` gains `phase: ProgressPhase`, where
      `ProgressPhase` is `#[serde(rename_all = "lowercase")]` with `Loading` /
      `Transcribing`.
- [x] `ProgressEvent::loading(path)` **must emit `percent: 0.0`.** The doc-07 adoption
      rule (`transcriber.rs:255-256`) says overlays may mount mid-transcription and
      adopt the active job from the *first* event they see, and the Rust side guarantees
      that event is 0 %. The frontend depends on it at
      `src/lib/stores/transcriber.ts:50-53`. Any other value breaks overlay adoption.
- [x] `spawn_progress_watcher` (`transcriber.rs:161-178`) stamps `Transcribing` on
      every tick. This is what naturally transitions the UI out of `loading`, so there
      is no watcher/timing race (Phase C starts the watcher after the load).

## Phase C — Load before the progress watcher

The highest-value phase, and the least intuitive. **Reordering only** — no timer is
touched, which is the point: reordering makes the existing timer correct.

Current order in `run_transcription` (`transcriber.rs:180-236`):
`ensure_model_ready` → decode → start watcher → `started` → `with_engine` (load **and**
recognize) → `duration_ms`.

New order:
`ensure_model_ready` → *emit `loading` if `engine_is_cold`* → **`ensure_engine`** →
decode → start watcher → `started` → `with_engine` (warm cache hit) → `duration_ms`.

- [x] **Bug 1 — inflated `durationMs`.** `started` is taken at `transcriber.rs:197`,
      *before* `with_engine`, and elapsed at `:201`. Since `with_engine` both loads and
      recognises, the first run's duration includes the load, is persisted into the
      sidecar (`:208-213`) and displayed by `TranscriptPanel.tsx:117`. Fix: hoist the
      load out so the existing timer measures only `recognize`. Do **not** move the
      timer inside the closure.
- [x] **Bug 2 — bar freezes at 99 %.** `estimated_total_ms = audio_duration_ms * 0.35`
      (`transcriber.rs:192`) has no term for load time, so the watcher races to its
      ceiling during the load and sits there — reads as a hang. Fix: start the watcher
      *after* the load, so the estimate only covers the work it models.
- [x] Accepted benign race: `engine_is_cold` is a read and `ensure_engine` a write, with
      the prewarm thread between them. If prewarm wins we emit `loading` and the
      watcher's first tick immediately overwrites it — a sub-200 ms flash. Closing it
      needs a second lock or a generation counter for a cosmetic effect that resolves
      itself. Leave it, but document it in a `// reason` line.

## Phase D — SHA-256 verification at download finalize

Most truncated/corrupt-download cases — the realistic source of malformed ONNX — are
caught here as an ordinary `Err`, which is the **only mechanism in this plan that
produces a reliable user-visible error** (it becomes `model-download-error` →
`ModelCard`). A catchable error is worth far more than any amount of crash containment.

- [x] `models.rs:34-39` — `ModelFile` gains `sha256: Option<&'static str>`, with a
      `// reason` comment on why it is optional.
- [x] `models.rs:54-84` — add the six verified hashes below to `CATALOG`. Keep the
      existing verification-date comment (`models.rs:50-53`) current.
- [x] `models.rs` — **do not persist the hashes.** `patch_parakeet_decoder`
      (`models.rs:290-321`, called from `downloader.rs:250`) appends bytes to the
      decoder *after* download, so a stored pre-patch decoder hash could never be
      re-verified — a permanent landmine that would need special-casing exactly like
      `size_accepted` (`models.rs:323-328`). Verify-once-at-finalize has no such
      problem. (If ongoing on-disk corruption detection is wanted later: re-hash the
      decoder after patching and store that instead.)
- [x] `downloader.rs:296-315` — hash the `.part` file in `finalize_download` **before**
      the atomic rename at `:310`, streaming with a 64 KB buffer. A corrupt transfer
      must never become a real file. On mismatch: remove the `.part` (same as the size
      branch at `:304-309`) and return `Err`.
- [x] `downloader.rs:290-293` — the existing `DownloadOutcome::Failed` path already
      surfaces the message via `model-download-error` → `ModelCard`. No new plumbing.
- [x] Error prose per `AGENTS.md`: `"encoder.int8.onnx failed its integrity check — the
      download was corrupted — retry the download"`.
- [x] `src-tauri/Cargo.toml` — add `sha2 = "0.10"`. It is **already in `Cargo.lock`
      transitively** (0.10.9, via rustls), so this costs no new crate download or
      rebuild. No hex crate needed: `format!("{hasher:x}")` on the `Digest` output.

### Landed notes

The user-facing string is `encoder.int8.onnx: failed its integrity check (sha-256
mismatch) — the transfer was corrupted — retry the download`. `download_file` already
prefixes `{file.name}: `, so `finalize_download` returns the clause only. "the transfer
was corrupted" rather than "the download was corrupted" avoids ending the sentence with
"download … retry the download".

Hashing lives in a `sha256_of_file(&Path) -> Result<String, String>` helper so it is
testable against a small temp file. `finalize_accepts_matching_sha256` derives its
expected digest from the file itself, so the real check on the hasher is
`sha256_of_bytes_matches_known_digest`, which pins it to the NIST vector for `"abc"`.

`Cargo.lock` gained the single `sha2` dependency edge. That is build-generated from the
`Cargo.toml` change; the crate itself was already locked at 0.10.9 and needed no network.



Sourced from the HF tree API. All sizes cross-check exactly against the pinned catalog.

```
parakeet-v2-en  (csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8)
  encoder.int8.onnx  a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab   652184296
  decoder.int8.onnx  b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e     7257753
  joiner.int8.onnx   7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2     1739080
  tokens.txt         (no LFS -> None)

parakeet-v3-multilingual  (csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8)
  encoder.int8.onnx  acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247   652184281
  decoder.int8.onnx  179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e    11845275
  joiner.int8.onnx   3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3     6355277
  tokens.txt         (no LFS -> None)
```

### Two traps, recorded so they are not re-introduced

- **Use `lfs.oid`, never the top-level `oid`.** For the LFS `.onnx` files the top-level
  `oid` is the SHA-1 of the LFS *pointer*, not of the content. Using it rejects every
  download.
- **`tokens.txt` has no obtainable SHA-256.** It is not in Git-LFS (9 KB / 94 KB, under
  the threshold), so its top-level `oid` is a git blob SHA-1 and the API exposes no
  content hash. Leave it `None` — it is already covered *semantically* by
  `ensure_tokens_have_blank` (`parakeet_engine.rs:8-19`), which is a stronger guarantee
  than a hash for a file whose contract is "must contain a `<blk>` line".

## Phase E — Crash-marker prewarm

An ONNX abort (`exit(-1)`, `SIGABRT`, or a C++ exception across the FFI) kills the
process outright. **Nothing in-process can survive it, ever** — no `Drop`, no
`app.emit`, no JS context. The app simply vanishes. There is also no OS-notification
plugin, and one could not help: the process that would fire it is already dead.
`eprintln!` is likewise invisible in a packaged GUI app with no attached terminal.

So the crash cannot report itself. The **next launch** can, because a marker file
survives it. The marker's real value is not preventing a crash — it is **keeping the
app launchable so the user can reach the Models page and re-download.** Without it a
bad model makes the app permanently unopenable with zero diagnostics.

Marker at `app_data_dir()/engine-prewarm-marker`, contents `"{model_id}::{dir}"`. Both
ends derive from `resolve_models_dir` (`models.rs:97-103`), so the key is stable across
launches without canonicalization. A renamed models dir simply yields a different key,
which is correct.

- [x] `transcriber.rs` — add `crash_marker_path`, `crash_marker_matches`,
      `arm_crash_marker` (returns `bool`), `disarm_crash_marker`.
- [x] `prewarm(&AppHandle)`: early-return if `downloader::any_active()`; spawn a
      detached thread that re-checks `any_active()`, resolves the model via
      `resolve_model_id` (`transcriber.rs:112-120`), `ensure_model_ready`, returns if
      `!engine_is_cold`, returns if `crash_marker_matches`, returns if
      `!arm_crash_marker(...)`, then `catch_unwind(ensure_engine)` and
      `disarm_crash_marker` afterwards.
- [x] **Disarm on *any* return, `Ok` or `Err`** — this is a deliberate refinement over
      "delete on success". The marker's semantic is *"the load call did not return"*,
      which is exactly the abort/exit/signal case. A normal `Err` means the load
      completed and merely wasn't acceptable; keeping the marker would permanently
      disable prewarm for a transient failure.
- [x] **If `arm_crash_marker` fails** (unwritable app data dir), skip the prewarm
      rather than risk an unstoppable crash loop.
- [x] `run_transcription` — `disarm_crash_marker` after `with_engine` returns `Ok`. This
      is what makes the marker **self-healing with no exit hook**, and it is load-bearing,
      not decorative. See the table below.
- [x] The **transcription path is never marker-gated** — it must always attempt the
      load so the user gets a real error.
- [x] `any_active()` is an **optimization, not a correctness layer.** `finalize_download`
      renames atomically (`downloader.rs:310`), so a half-written `encoder.int8.onnx` is
      unreachable — you see either no file or a complete previous one. Size check +
      atomic rename suffices; `any_active()` just avoids a pointless 3 s load.
- [x] `catch_unwind` here is diagnostics + not losing a detached thread, **not** a
      safety net for the abort case. Say so in a `// reason` line so a future reader
      does not mistake it for the sherpa mitigation.

### Marker self-healing matrix

| scenario | outcome |
|---|---|
| abort in prewarm, model actually fine | marker survives → next launch skips prewarm → transcription succeeds → marker cleared → prewarm re-enabled. One slow dictation, self-healed. |
| genuinely bad model | prewarm aborts → marker survives → prewarm stays off → first transcription aborts, exactly as today. Unchanged behaviour. |
| **user quits during the 3 s prewarm** (very reachable on login-autostart) | marker orphaned → one launch with prewarm off → transcription succeeds → cleared. **No permanent degradation.** |

The third row is the one that would otherwise have required a `RunEvent` exit hook in
`lib.rs` — and it is the reason the transcription-side `disarm` exists.

### Landed notes

The marker functions were split into `&Path` variants (`write_crash_marker_at`,
`read_crash_marker_at`, `crash_marker_matches_at`, `disarm_crash_marker_at`) with thin
`&AppHandle` wrappers on top. `AppHandle` cannot be constructed in a unit test, so the
split is what makes `crash_marker_round_trips_key`,
`crash_marker_does_not_match_a_different_directory` and
`disarm_crash_marker_clears_any_contents` possible at all.

`EngineKey::id()` was added to produce the marker string (`"{model_id}::{dir}"`) that
every marker comparison shares.

The planned `crash_marker_cleared_when_load_returns_err` test is not directly
testable — the disarm-on-`Err` behaviour lives inside `prewarm`'s closure, which needs a
real `AppHandle` and a real model load. What is locked in its place is the property it
rests on: `disarm_crash_marker_clears_any_contents` asserts disarm removes the file
regardless of its contents, which is why it is safe to call on the `Err` path.
`arming_the_crash_marker_fails_on_an_unwritable_path` covers the other guard.



## Phase F — Startup notice

`get_settings_warning` is **not** a toast: its only consumer is
`SettingsPage.tsx:372`, which renders a static banner inside the Settings page
(`SettingsPage.tsx:565-575`). Reusing it would mean the user has to go looking for the
explanation — the opposite of the goal. The notice needs its own channel.

- [x] `settings.rs:92-115` — `SettingsState` gains a **separate**
      `startup_notice: Mutex<Option<String>>` with a setter, so the two warnings cannot
      collide in the existing `Option<String>`. Leave `warning` and
      `get_settings_warning` completely untouched.
- [x] `settings.rs` — new `#[tauri::command] get_startup_notice(app) -> Option<String>`.
- [x] `lib.rs:39-72` — register it in the single `invoke_handler` list.
- [x] `transcriber.rs` — `note_orphaned_prewarm_marker(&AppHandle)`: if the marker
      matches the current key, set the startup notice.
- [x] `lib.rs:30-38` `setup` — add `note_orphaned_prewarm_marker(app.handle())` then
      `prewarm(app.handle())`, synchronously, after `tray::apply` and after
      `app.manage(settings)` (`:32`, which `resolve_model_id` needs).
- [x] **The synchronous ordering is load-bearing.** Detect before the UI can query
      (reading a few hundred bytes), act asynchronously (the multi-second load). Doing
      the check inside the prewarm thread races the frontend's query and can miss the
      notice entirely.
- [x] `src/App.tsx:112-158` `OutcomeToasts` — one effect mirroring the existing
      precedent at `App.tsx:147-149`:
      `invoke<string | null>("get_startup_notice")` → on non-null,
      `toast("error", notice, { action: { label: "Re-download", onClick: () => navigate("/models") } })`.
- [x] Copy: *"The model failed to load last time, so preloading was disabled.
      Transcriptions may fail."*
- [x] **This toast is sticky by design** — `toast.tsx:55` sets no timer when
      `kind === "error" && action` is present. That is the correct choice: it demands a
      decision. (Contrast: the 4000 ms default at `toast.tsx:51`, which applies to
      toasts without an action.)
- [x] The notice reappears on every launch while the marker exists, matching
      `get_settings_warning`'s behaviour (it shows every visit until the file is fixed).
      Deliberate: the condition is still true and still needs resolving.

### Landed notes

`settings::startup_notice` has to bind the mutex guard to a local before cloning —
returning the clone directly is E0597, because the guard temporary would outlive the
`State` it borrows from.

The planned tests `startup_notice_set_when_marker_matches`,
`startup_notice_absent_when_marker_key_differs` and
`startup_notice_does_not_disturb_settings_warning` were dropped. All three need a live
`AppHandle` with managed state, which this crate has no harness for, and asserting on a
`Mutex<Option<String>>` field would test the container rather than the behaviour. The
behaviour those guards protect — marker matching and its directory sensitivity — is
covered on the `transcriber.rs` side by the `crash_marker_*` tests, and the notice's
observable half is covered in `src/App.test.tsx`.

`OutcomeToasts` was exported so the notice could be tested without mounting the whole
app shell. Its test has to import `ToastViewport` from the same module instance the app
got after `vi.resetModules()`, or the viewport watches a different copy of the toast
store and no toast ever appears.


## Phase G — Wiring

- [x] `lib.rs:30-38` — launch prewarm, **ungated** (see Phase F for the two added lines;
      this is the wiring note). Detached, so `setup` returns immediately.
- [x] `recorder.rs:80` `start_recording` — `prewarm(&app)`, **ungated**, placed *after*
      `stream.play()` succeeds so the mic is already live and the load overlaps the
      user's first dictation. Placing it earlier would have it compete with cpal device
      init.
- [x] Double-kick safety: `load_if_stale` is idempotent under the `ENGINE_CACHE` mutex,
      so launch + recording-start prewarm racing means one loads and the other returns
      early or blocks then returns early. No coordination flag needed.

## Phase H — Frontend

- [x] `src/lib/stores/transcriber.ts:14-18` — `TranscriberState` gains
      `phase: "loading" | "transcribing"`, default `"transcribing"`, reset in
      `clearActive()` (`:31-33`).
- [x] `src/lib/stores/transcriber.ts:48-57` — normalise with
      `payload.phase === "loading" ? "loading" : "transcribing"`. **Keep the field
      optional at the wire boundary**: `OverlaySync.tsx:39-53` synthesises its own
      `transcribe-progress` events, and an absent field must keep meaning the historical
      behaviour.
- [x] `src/lib/OverlaySync.tsx:48-51` — forward `phase` in the synthetic emit.
- [x] `src/components/feature/TranscriptPanel.tsx:138` and
      `src/pages/LibraryPage.tsx:45` — show "Loading model…" instead of a percentage
      when `phase === "loading"`.
- [x] `src/components/feature/RecordingPill.tsx:82` — **unchanged**, still renders
      `percent: 0`. The animation registry clamps 0 % to a valid frame
      (`registry.test.ts:45-55`), so it is legitimate. The pill simply sits still for a
      few seconds, which is honest; the two surfaces with *text* carry the message.
      Adding an indeterminate mode would be feature creep against the
      single-purpose-product rule.
- [x] `src/lib/stores/settings.ts:16-30` — **no change** (the settings flag is gone).

### Landed notes

A `TranscribePhase` type alias was exported from `stores/transcriber.ts` rather than
inlining the union at each use.

`LibraryPage.tsx` renders a `w-28` text label during `loading` — the same width box the
`Progress` bar it replaces occupies, so rows do not reflow when the phase changes.

The `OverlaySync` emit itself is not directly tested; it is a one-line pass-through and
the receiving end's absent-`phase` default is covered in `stores/transcriber.test.ts`.


---

## Verification

Per phase:
- [x] `cd src-tauri && cargo check --all-targets` green.
- [x] `cd src-tauri && cargo test` green.
- [x] `bunx vitest run` green.
- [x] `bun run build` green.

New Rust tests:
- [x] `engine_key_changes_when_models_dir_changes` — locks in Phase A. Without it, a
      future refactor back to a model-id-only key silently reintroduces the
      wrong-model bug with no test failure.
- [x] `engine_key_stable_for_same_model_and_dir`.
- [x] `engine_key_mismatch_can_only_cost_a_reload_never_the_wrong_engine` — documents
      the component-wise `PathBuf` asymmetry and which direction it is safe in.
- [x] `eviction_matches_on_model_id_regardless_of_directory` — covers the `delete_model`
      path (`models.rs:467` passes an id and no dir). Needs the `cache_matches_model`
      predicate extracted so it is testable without a real engine.
- [x] `engine_is_cold_against_an_empty_cache`.
- [x] `progress_event_loading_starts_at_zero` — locks in the adoption-rule constraint.
- [x] `progress_event_serializes_phase_lowercase`.
- [x] `crash_marker_round_trips_key`.
- [x] `disarm_crash_marker_clears_any_contents` — landed instead of the planned
      `crash_marker_cleared_when_load_returns_err`; see Phase E landed notes for why the
      original was not directly testable.
- [x] `arming_the_crash_marker_fails_on_an_unwritable_path` (plus
      `crash_marker_does_not_match_a_different_directory`).
- [x] *(dropped — `startup_notice_set_when_marker_matches` needs a live `AppHandle`; see
      Phase F landed notes.)*
- [x] *(dropped — `startup_notice_absent_when_marker_key_differs`, same reason; the marker
      side is covered by the `crash_marker_*` tests.)*
- [x] *(dropped — `startup_notice_does_not_disturb_settings_warning`, same reason.)*
- [x] `sha256_of_bytes_matches_known_digest` — `"abc"` →
      `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`.
- [x] `finalize_rejects_sha256_mismatch_and_removes_part` (plus
      `finalize_accepts_matching_sha256`).
- [x] `finalize_accepts_nonexistent_expected_hash`.
- [x] `catalog_sha256_values_are_lowercase_hex_64`.
- [x] Update `first_progress_event_is_zero` (`transcriber.rs:306-311`) — the struct
      gained a field; also assert `phase == "transcribing"`.
- [x] **No settings tests** — nothing in `settings.json` changed.

New vitest tests:
- [x] loading → transcribing transition in the store.
- [x] absent `phase` defaults to `"transcribing"`.
- [x] `TranscriptPanel` shows "Loading model…".
- [x] `startup notice fires a sticky error toast that does NOT auto-dismiss` — fake
      timers, advance past 4000 ms, still present. This is the regression guard for
      Phase F's core promise.

Manual (Linux X11 reference platform):
- [ ] Fresh install → launch → confirm the model is **not** loaded at launch if the
      marker is absent but prewarm is ungated, i.e. confirm prewarm *does* run and the
      first dictation is warm. (Fresh install has no marker, so prewarm runs.)
- [ ] Corrupt a downloaded model file to right-size garbage → relaunch → expect one
      crash → relaunch → expect a **launchable app with the sticky notice** → Models
      page reachable → re-download → notice clears.
- [ ] Quit the app mid-prewarm → relaunch → confirm no permanent prewarm disable.
- [ ] Truncate a `.onnx` mid-transfer (or point the catalog hash at a wrong value) →
      confirm the download fails with the named-file integrity error and a retry.
- [ ] Confirm `durationMs` on the first clip is realistic, and that it is no longer
      inflated by the load.
- [ ] Confirm the progress bar shows "Loading model…" then advances normally.
- [ ] No-regression pass after each phase.

## Definition of done

- First transcription after a launch is not measurably slower than the second.
- Reported `durationMs` excludes model load, for the first job and all later ones.
- The progress bar does not freeze at 99 % during a load.
- A right-sized-but-corrupt model can crash the app at launch **at most once**, after
  which the app always launches and explains why via a sticky, actionable notice.
- A truncated or corrupt download fails with a named-file integrity error, never
  reaching the engine.
- No `AppSettings` field added; `settings.json` semantics unchanged.
- `cargo test` and `vitest` green; manual Linux pass complete.

## Pitfalls (preserve these)

- **`catch_unwind` is not the sherpa mitigation.** It cannot catch `exit(-1)`,
  `SIGABRT`, or foreign C++ exceptions. In `prewarm` it is diagnostics only.
- **A crashed process cannot notify the user.** No `Drop`, no event, no toast, no
  desktop notification. The next launch is the only opportunity, and the marker file
  is the only evidence.
- **Use `lfs.oid`, not `oid`**, when pinning model hashes.
- **Do not persist the decoder hash** — `patch_parakeet_decoder` runs after download
  and makes any pre-patch hash permanently unverifiable.
- **`ProgressEvent::loading` must emit `percent: 0.0`** or the doc-07 overlay adoption
  rule breaks.
- **The transcription path must never be marker-gated**, and the transcription-side
  `disarm` must not be dropped as redundant — it is what makes a quit-during-prewarm
  self-heal.
- **Model hashes are `Option`.** A `tokens.txt` hash cannot be obtained; do not invent
  one, and do not add a hash crate that can't produce it.
- **Don't regress Linux.** It is the reference platform.

## Risks that need a real machine, not a test

- [ ] **~700 MB–1 GB RSS held for the process lifetime.** This is the entire cost of
      "never evict". Measure `ps -o rss` after the load settles. If it is unacceptable,
      idle-unload is the lever — and note it reintroduces the first-dictation stall
      after every idle period.
- [ ] **CPU contention with mic capture** during a recording-start prewarm on
      low-core machines → possible dropouts. Listen on the worst machine available.

## Residual risk

A bad model can still crash the app **at launch, once**. The marker prevents a second
launch-crash, not the first, and the hash check shrinks the class to roughly
"incompatible custom model". If even one launch-crash is unacceptable, the escape
hatch is to swap Phase E's marker for a `--probe-model <dir>` child process: prewarm
runs only after a child exits 0, at the cost of loading the model twice per `EngineKey`.
Nothing else in this plan changes.

## Suggested order

A → B → C → D → E → F → G → H. Push after each phase. Phase C is the highest-value
step and the one most worth a second opinion on — if the reordering has an unforeseen
consequence, that is where it will be.
