# 08 — Recording Indicator Overlay & Animation Styles

## What it does

A dedicated `recording-indicator` overlay window (250×64, transparent, always-on-top,
bottom-center of the primary monitor, click-through) renders a **recording animation**
while recording and a **transcription animation** (with live percent) while
transcribing. Styles are user-selectable from gallery pages.

> **History**: earlier iterations were a voice-reactive "drifting dots" pill
> (`49eff18`) then a "continuous dot stream with edge fades" (`77a147f`), both removed
> when `2a87c31` replaced the indicator with the current "classic" pill + style gallery.
> The classic style's 12 live level bars are their surviving descendant. Those designs
> exist only in git history now.

## UI / UX

- **RecordingAnimationsPage** (`/animations/recording`): gallery of **13 recording
  styles**, card grid (auto-fill, min 220 px), each card renders the live animation
  (ticking preview clock + static level 0.6) with name, "In use" badge, description,
  and "Use for recording".
- **TranscriptionAnimationsPage** (`/animations/transcription`): same pattern for
  **13 transcription styles**, preview driven by a mock percent cycling 12→100→4 every
  450 ms.
- The overlay pill itself (`RecordingPill`): recording style renders
  `{ time: elapsed, level }` (elapsed ticks every 500 ms); transcription style renders
  `{ percent }`; renders nothing when idle.

## Implementation

- **Registry** (`src/lib/animationRegistry.tsx`): static code-defined entries
  `{ id, name, desc, render(args) }` — no dynamic registration. Recording styles:
  classic (pulsing core + REC + timer + 12 level bars), pulse-halo, wave-bars,
  ripple-mic, soft-blink, orbit, breathing-orb, ecg, equalizer, sonar, typing-dots,
  gradient-ring, shimmer. Transcription styles: classic (spinner + shimmer progress),
  spinner, dots, shimmer-bar, skeleton, pulse-glow, dual-orbit, eq, ring (real-percent
  dash offset), slide-bar, cursor, double-ring, gradient-border. Unknown IDs fall back
  to `[0]` (classic).
- **Style selection & cross-window sync** (`src/lib/indicatorStyle.ts`):
  selections cached in module state + localStorage (`indicator:recording-style` /
  `indicator:transcription-style`) with validation guards. **Dual-channel sync**:
  (a) `emitTo("recording-indicator", "indicator-style-changed", payload)` on every set;
  (b) every webview also `listen`s to the same event and updates its cache.
  Because **broadcasts sent while the overlay doesn't exist are lost**,
  `RecordingIndicatorSync` (mounted invisibly in the main window) re-broadcasts styles
  on every overlay show, and the overlay re-reads localStorage on mount
  (`refreshIndicatorStyleFromStorage`).
- The overlay window config mirrors doc 02: offscreen creation, show-before-
  `setIgnoreCursorEvents` (tao panic workaround), `primaryMonitor()`-only positioning.
- `RecordingIndicatorSync` shows the overlay when `useRecording() || transcribing.busy`
  — including transcription jobs adopted cross-window (doc 05).
- **Overlay-fit CSS** (`recording-indicator.css:190-246`): a
  `.recording-indicator-overlay`-scoped override block compacts gallery pills to fit
  the 250×64 window. A `prefers-reduced-motion` block kills all animation.

## Gotchas

1. **The localStorage contradiction**: `indicatorStyle.ts:159` claims localStorage isn't
   shared across webviews while `refreshIndicatorStyleFromStorage` relies on the
   overlay reading what the main window wrote. Same-origin WebKit views usually do
   share storage, so the storage path is redundant belt-and-braces — one of the two
   comments is wrong.
2. **Adoption depends on the 0%-at-start progress event** (doc 05) — if the backend ever
   skips it, cross-window transcription won't animate.
3. RecordingPill re-renders on every level event (20 Hz) even if the selected style
   doesn't use `level`; plus 2 Hz elapsed-timer ticks. Fine, but worth memoizing if
   styles grow.
4. Radio `name="paste-mode"`/`name="audio-format"` global name-spacing quirk (doc 01).
5. The `@property`-based conic-gradient animation was replaced with a rotating
   `::before` layer because `@property` doesn't animate in the webview
   (`animations.css:999` comment); SVG `<stop stopColor="var(...)">` also doesn't work —
   inline `style` is used instead.

## Difficulties & mitigations (from git `2a87c31`, `bc31140`, `10a9d01`, `2b2069f`, `6316653`, `3ed55c9`)

| Difficulty | Evidence | Mitigation |
|---|---|---|
| localStorage not shared / events lost across webviews | `10a9d01` event bus + `2b2069f` "sync overlay styles on show" | formalize the push-on-show + event-adoption protocol (doc 09); consider moving style selection to the Rust settings store as the authority |
| Overlay transparency leaked into the main window | `3ed55c9` scoped transparency via `data-window` attribute | keep the `:root[data-window=...]` scoping convention; enforce it for any new overlay-only CSS |
| Visual tuning loops (dots count, window size 260×72→140×44, mask fades) | `49eff18`, `77a147f` diffs | keep animations CSS-var driven (`--voice-level`) rather than per-frame JS; preview galleries make future tuning cheap |
| Webview CSS/SVG quirks (`@property`, SVG var() stops) | inline comments in `animations.css`, `ClassicIndicatorViews` | keep the "no @property" and inline-style-SVG conventions documented |
