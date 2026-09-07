# 10 — Module: Recording-Indicator Animations & Gallery

Milestone: M5 (classic styles land earlier: recording-classic in M3,
transcription-classic in M2 for progress feedback) · Files:
`lib/animations/registry.tsx`, `components/feature/RecordingPill.tsx`,
`pages/AnimationsPage.tsx`, recording-indicator window + CSS.

## Goal

The `recording-indicator` overlay (260×76) shows a **recording animation** while
recording and a **transcription animation** (live percent) while transcribing. Users
pick styles from in-app galleries; selection syncs across windows.

## Registry

`lib/animations/registry.tsx` — static entries `{ id, name, desc, render(args) }`;
unknown id → classic fallback.

- **Recording styles (10)** — args `{ elapsed, level }` (elapsed ticks every 500 ms;
  level 0..1 from `recording-level`): classic (pulse dot + REC + mono timer + 12
  level bars), pulse-halo, wave-bars, ripple, orbit, breathing-orb, ecg, equalizer,
  sonar, shimmer.
- **Transcription styles (10)** — args `{ percent }`: classic (spinner + shimmer
  progress), dots, shimmer-bar, skeleton, pulse-glow, dual-orbit, ring (real-percent
  dash offset), slide-bar, cursor, double-ring.

## Gallery page (/animations)

- SegmentedControl tabs: Recording | Transcription (tab choice is a local UI pref —
  the only allowed localStorage key).
- Card grid (auto-fill, min 220 px): live preview (recording: static level 0.6 +
  500 ms clock; transcription: mock percent cycling 12 → 100 → 4 every 450 ms), name,
  "In use" badge, one-line description, "Use for recording/transcription" button.
- The galleries double as the living component library (no Storybook).

## Pill + selection flow

- `RecordingPill` renders per selected style; renders nothing when idle.
- Selection persisted via settings (`indicatorRecordingStyle` /
  `indicatorTranscriptionStyle`) → `set_indicator_style {kind, id}` command →
  broadcast `indicator-style-changed {kind, id}`.
- **Authority fix (v2):** the overlay reads styles from `get_settings` on mount (no
  localStorage mirroring) + listens for changes; OverlaySync re-pushes on
  overlay-ready (doc 11 §3).
- Visibility: `RecordingIndicatorSync` (main window) shows the overlay when
  `useRecording().busy || transcriber.busy` — including cross-window adopted jobs
  (doc 07) — and hides when both settle. Position: primary monitor bottom-center;
  show-then-click-through ordering per doc 02 §5.

## CSS conventions (v2 webview lessons — hard rules)

- Level-reactive visuals use the `--voice-level` CSS var (set ≤ 20 Hz,
  rAF-throttled) + `calc()` — **no per-frame JS animation**.
- **`@property` does not animate in the webview** → rotating `::before` layer for
  conic/ring effects.
- **SVG `<stop stop-color="var(…)">` doesn't work** → inline `style` attribute.
- Overlay-fit overrides scoped under `:root[data-window="recording-indicator"]`
  (compact paddings so every style fits 260×76 without clipping).
- `prefers-reduced-motion` → kill-switch block (opacity-only state changes).
- Timers: the pill re-renders at 2 Hz (elapsed) + up to 20 Hz (level); memoize style
  renders if profiles demand.

## Tasks

- [x] registry + classic recording style (M3) + classic transcription style (M2)
- [x] remaining 18 styles (M5) — CSS-var driven, overlay-fit verified per style
- [x] RecordingPill + visibility sync + cross-window adoption
- [x] set_indicator_style command + settings fields + broadcast + push-on-show
- [x] AnimationsPage gallery (tabs, previews, use / in-use)
- [x] reduced-motion + data-window scoping + no-@property / inline-SVG audit

## Verification

- Manual: switch a style while the overlay is visible (live swap); every style fits
  260×76 (screenshot sweep); reduced-motion honored; percent animates with real
  values during a long transcription; never takes focus or clicks.
