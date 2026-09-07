# 08 — Module: Parakeet Models (catalog, downloads, ONNX patch)

Milestone: M2 · Files: `src-tauri/src/models.rs`, `downloader.rs`,
`pages/ModelsPage.tsx`, `components/feature/ModelCard.tsx`, `lib/stores/downloads.ts`.

## Goal

Manage exactly **two** local STT models — NVIDIA Parakeet TDT 0.6B int8 ONNX builds
from the sherpa-onnx HF mirrors — with background downloads, cancel, delete, default
selection, and a user-overrideable models dir. Whisper is out of scope by design.

## Catalog (models.rs, static)

| id | Model | Languages | Source (HF) |
|---|---|---|---|
| `parakeet-v2-en` | Parakeet TDT 0.6B v2 | en | csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8 |
| `parakeet-v3-multilingual` | Parakeet TDT 0.6B v3 | 25 EU langs | csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 |

- 4 files each: `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`,
  `tokens.txt`. Exact URLs + `size_bytes` per file pinned in the catalog (copy from v2
  `models.rs`, re-verify against HF during M2). Multi-file → per-id subdir
  `<models_dir>/<id>/…`.
- Auto-selection preference order: v2 (en) first, then v3.

## Downloader (downloader.rs)

- Thread-per-model, blocking reqwest (rustls), **connect + read timeouts (30 s /
  60 s idle)** — v2 hung "downloading" forever on stalled connections (gotcha #2, fixed).
- Write `<file>.part`; verify exact byte size vs catalog; atomic rename.
- Progress events `model-download-progress {id, downloaded, total, percent}` throttled
  (≥ 2 MiB or ≥ 5 %); `model-download-done / -error / -cancelled`.
- `DownloadState(Mutex<HashMap<id, ActiveDownload>>)` with `Arc<AtomicBool>` cancel
  flags; entry removed only if `Arc::ptr_eq` matches (guards clobbering a newer
  retry); finished threads GC'd via `is_finished()`; cancel deletes the `.part`.
- v2 test gap: add a **cancel-then-restart integration test**.

## ONNX decoder patch + integrity (validate-before-FFI)

- sherpa-onnx ≥ 1.11 requires `vocab_size` / `context_size` ONNX metadata that the HF
  decoders lack → `patch_parakeet_decoder` binary-searches the protobuf and appends
  hand-built varint `MetadataEntry` records (vocab_size = non-empty line count of
  tokens.txt; context_size = 2). Double-patch byte-scan guard (kept from v2).
- **v2 fix:** the patched file no longer matches the catalog size (v2 used a ±2048-byte
  tolerance hack). v3 writes a `<id>/patched.json` manifest
  `{ "decoder.int8.onnx": <patchedSize> }` after patching; `is_downloaded` compares
  manifest sizes when present, falling back to the ±2048 tolerance only for
  un-manifested legacy dirs.
- Delete: refuses while downloading or if the model is the default; removes the subdir.
- Engines verify size (not just `is_file()`) using the same integrity check — closes
  the v2 existence-vs-load race (gotcha #5).

## Models dir (settings)

- `set_models_dir {dir|null}`: null/empty → default `<app_data>/models`; must be
  absolute; created + `.write_test` probe; **blocked while any download is active**.
- Single resolution helper shared by models + transcriber (v2 split-resolver fix).

## UX (/models) — two cards, no filter machinery

- Metrics strip: "1 / 2 downloaded · 1.7 GB on disk".
- Storage card: mono path + Custom/Default badge + Browse… + Reset + Open folder
  (opener plugin); hint that dir changes lock during downloads.
- Two large ModelCards: name, language chips, params, total size, status line (Not
  downloaded / Downloading… N % / Ready / error), 4 px progress bar, actions:
  Download · Cancel · Set default (radio-marked) · Delete.
- Validation failures (size/token errors) hint re-download in the card status line.
- No search/sort/tabs (v2 had 11 models; two cards need no chrome).

## Pitfalls carried from v2 (doc 06)

1. Hard-coded upstream sizes are brittle → pinned URLs + manifest; document the
   re-verification step when upgrading sherpa-onnx.
2. No download timeout → added (above).
3. Patched-size mismatch → manifest (above).
4. Hand-rolled protobuf patching is fragile → keep the byte-scan guard; record the
   sherpa-onnx version alongside the pinned sherpa-rs version; consider mirroring
   decoders that already carry metadata.
5. Existence-vs-load race → integrity-checked loads (above).

## Tasks

- [x] models.rs: catalog + integrity (manifest-aware) + resolution helper (+ tests)
- [x] downloader.rs: threads / cancel / ptr_eq / timeouts (+ cancel-restart test)
- [x] patch_parakeet_decoder + manifest writer (+ protobuf append unit test)
- [x] models dir settings + write probe + download lockout
- [x] stores/downloads.ts (progress map) + useDownloads
- [x] ModelsPage: metrics, storage card, 2 ModelCards, actions, progress, errors
- [x] delete guards (downloading / default) + UI messaging

## Verification

- Unit: patch builder (append-only, double-patch guard), manifest integrity math,
  delete guards, size checks.
- Manual: download v2 → cancel mid-way → `.part` gone → restart completes; corrupt
  tokens.txt → transcription fails with a friendly "re-download" error (not a crash);
  set default; deleting the default refused; custom-dir change with an active download
  blocked with a clear message.
