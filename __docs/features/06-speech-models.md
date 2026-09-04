# 06 — Speech Models: Catalog, Downloads, Custom Dir, ONNX Patching

## What it does

Manages 11 local STT models — 9 Whisper ggml files (tiny → large-v3-turbo q8_0, from
`huggingface.co/ggerganov/whisper.cpp`) and 2 NVIDIA Parakeet TDT 0.6B models (v2
English, v3 25 EU languages, from `csukuangfj/sherpa-onnx-nemo-parakeet-*`) — with
background downloads, progress events, cancellation, deletion, a default-model
selection, and a user-overrideable models directory.

## UI / UX (`/models`, `src/pages/ModelsPage.tsx`)

- **Metrics grid**: Downloaded (count + total bytes), Available, Downloading, Default.
- **Storage location**: current path + Custom/Default badge, default-path hint, text
  input + Browse… (dialog plugin), "Use this folder", "Reset to default", "Open folder".
  All dir mutations are disabled while any download is active (with a warning hint).
- **Filter bar**: tabs `all | downloaded | available | downloading` with counts, search
  box, engine select, sort select. Filter prefs persist in localStorage
  (`models:tab/search/engine/sort`).
- **Grouped listing**: "Downloading" always visible; collapsible Downloaded / Available
  sections on the All tab. Empty-state hints mention the custom-dir caveat.
- **ModelCard**: check/"Default ✓" badges, engine/license/languages/params/size,
  description, status line (Not downloaded / Downloading… N% / error / ✓ Ready),
  Download / Cancel / Set default / Delete buttons, 160 px progress bar.

## Implementation

- **Catalog** (`models.rs`): static table with exact HF URLs and **hardcoded
  `size_bytes` per file** — size is the integrity check for `is_downloaded` (exists &&
  length matches). Whisper models live flat in the models dir; multi-file Sherpa models
  in a per-id subdirectory.
- **Downloader** (`downloader.rs`): per-model background `std::thread` with blocking
  reqwest (rustls); `DownloadState(Mutex<HashMap<id, ActiveDownload>>)` with
  `Arc<AtomicBool>` cancel flags. Writes to `<file>.part`, verifies exact byte size
  against the catalog, then atomically renames. Progress events
  (`model-download-progress/done/error/cancelled`) throttled to every ≥2 MiB / ≥5% /
  completion. Stale finished entries are GC'd via `handle.is_finished()`;
  `run_download` removes its map entry only if the cancel `Arc` pointer matches
  (`Arc::ptr_eq`) — guards against clobbering a newer retry. Cancel deletes the `.part`.
- **Custom models dir** (`settings.rs:189-215`): must be absolute; created +
  write-tested via a `.write_test` probe file; `None`/empty resets to default
  (`<app_data>/models`); changes blocked while downloads are active.
- **Delete** (`models.rs:398-444`): refuses while downloading or if the model is the
  default; Parakeet deleted by removing its subdir, Whisper file-by-file.

## Gotchas

1. **Hard-coded upstream sizes are brittle** — any upstream re-upload breaks downloads
   with "expected N bytes" failures (`downloader.rs:361-367`).
2. **Blocking reqwest with no timeout** — a hung connection leaves the model
   "downloading" until cancel is pressed.
3. **The ONNX decoder patch** (see below) mutates the canonical artifact, so its size no
   longer matches the catalog — `is_downloaded` special-cases `decoder.int8.onnx` up to
   **+2048 bytes** tolerance (`models.rs:304-333`), otherwise patched files would
   re-download forever.
4. **Hand-rolled protobuf patching is extremely fragile** — `patch_parakeet_decoder`
   binary-searches the ONNX protobuf for `vocab_size`/`context_size` metadata and, if
   missing, **appends hand-built varint-encoded `MetadataEntry` protobuf records** to
   `decoder.int8.onnx` (`vocab_size` = non-empty line count of `tokens.txt`,
   `context_size` = `"2"`). Required because sherpa-onnx ≥1.11 demands metadata that
   HF-hosted decoders lack. A byte-scan guards against double-patching, but any
   sherpa-onnx/HF format change can break it.
5. Existence-vs-load race: a partially overwritten file during re-download can
   transiently report `downloaded: true` while engine load would fail (engines check
   `is_file()` but not size).
6. `openModelsFolder` dynamically imports the opener plugin and degrades to a thrown
   "open it manually" error.
7. Empty-state wording quirk: "models in the default location are not shown here" is
   confusing when no custom dir is set.

## Difficulties & mitigations (from git `f98895f`, `dcffbe6`, `65215df`)

| Difficulty | Evidence | Mitigation |
|---|---|---|
| Native build fights (libclang, bindgen, prebuilt sherpa-onnx/onnxruntime binaries) | sherpa behind opt-in `parakeet` cargo feature, then feature gutted in `65215df` | pin `sherpa-rs` exactly; document the matching sherpa-onnx binary version; CI-build from clean |
| sherpa-onnx ≥1.11 rejects HF decoders missing ONNX metadata | hand-written protobuf append in `downloader.rs:208-278` | upstream the patch or mirror decoders that already carry metadata; replace the ±2048-byte size hack with a manifest of patched sizes or content hashes |
| Download thread stuck/double-download bugs (implied by hygiene code) | `Arc::ptr_eq` ownership checks, `is_finished()` GC | keep as-is; add an integration test for cancel-then-restart |
| Sizes/URLs drift | hardcoded catalog | pin by HF revision; consider hash checks instead of size equality |
