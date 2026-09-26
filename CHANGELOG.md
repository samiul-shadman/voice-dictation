# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-09-26

### Fixed

- Blank window when the packaged app is launched on Linux — the app now disables
  WebKitGTK's DMA-BUF renderer at startup (it fails to allocate GBM buffers on
  some X11/NVIDIA drivers), matching the dev-time workaround.

## [0.1.2] - 2026-09-25

### Fixed

- Linux bundles now ship the sherpa-onnx shared libraries: the `.deb` installs
  them under `/usr/lib/voice-dictation` (and the binary gains an RPATH to match),
  and the AppImage bundles them, so the app launches without a system-wide
  install. Adds the `patchelf` build dependency for the AppImage step.

## [0.1.0] - 2026-09-25

### Added

- First public Linux release — `.deb` and `.AppImage`.
- Hold or toggle a global hotkey, speak, and get the transcript pasted into the
  focused app. Transcription runs entirely locally with NVIDIA Parakeet
  (int8 ONNX via sherpa-onnx).
- English and multilingual model catalog with background download, cancel,
  delete, and integrity validation.
- Audio library with transcript sidecars, exclusive playback, and safe delete.
- Click-through overlay pills (10 recording + 10 transcription styles) and a
  selectable indicator surface: floating pill, panel/tray icon, or both.

[Unreleased]: https://github.com/samiul-shadman/voice-dictation/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/samiul-shadman/voice-dictation/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/samiul-shadman/voice-dictation/compare/v0.1.0...v0.1.2
[0.1.0]: https://github.com/samiul-shadman/voice-dictation/releases/tag/v0.1.0
