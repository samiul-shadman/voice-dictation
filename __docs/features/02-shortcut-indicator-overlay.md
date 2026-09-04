# 02 — Shortcut Indicator Overlay & Output Log Window

## What it does

Two auxiliary windows spawned at runtime from the frontend:

- **`indicator`** (`src/lib/indicator.ts`): a 340×110 transparent, always-on-top,
  click-through floating pill shown while a global `print` shortcut is held, displaying
  the held combo + the text that will be printed.
- **`output`** (`src/lib/output.ts`): a normal 520×420 decorated window logging every
  shortcut-triggered text print (combo chip + timestamp + monospace text).

## UI / UX

- **IndicatorPage** (`src/pages/IndicatorPage.tsx`): dark glass pill, sky-blue mono combo
  chip, pop-in animation. Payload restored from localStorage (`indicator:payload`) on
  mount, then live-updated via `shortcut-indicator` events.
- **OutputPage** (`src/pages/OutputPage.tsx`): pre-hydrates from localStorage
  (`output:log`, capped at 200 entries), auto-scrolls to bottom, "Clear" button,
  "Waiting for shortcuts…" empty state.

## Implementation

- Both windows are created via `new WebviewWindow(...)` (enabled by the
  `core:webview:allow-create-webview-window` capability) — **no Rust window code**.
- Shared creation pattern: create offscreen at `x/y = -10000` with `visible:false`,
  idempotent `ensureWindow()` via `WebviewWindow.getByLabel` + a cached `pending`
  promise, resolve on `tauri://created`.
- After show, `setIgnoreCursorEvents(true)` makes the indicator click-through — with a
  documented crash workaround: calling it on an unrealized GTK window **panics tao**,
  so the window must be shown first (`indicator.ts:84-87`).
- Positioning is against `primaryMonitor()` only: indicator at 75% screen height,
  horizontally centered. **On multi-monitor setups the indicator always appears on the
  primary display**, even if the user works on another monitor.
- Because broadcasts emitted before the window exists are lost, the payload is
  duplicated into localStorage *and* sent via `emitTo`; `printToOutput` always
  opens/focuses the Output window (`output.ts:109-114`).

## Gotchas

1. **Focus stealing** — every app-scope `print` shortcut fires `printToOutput`, which
   opens/focuses the Output window mid-typing. Only the voice-note path deliberately
   avoids this (`AudioLibraryPage.tsx:88-94` skips print when `autoPaste` is set, so the
   focus isn't stolen back from the paste target).
2. **Silent position failure** — if `primaryMonitor()` fails, the window stays offscreen
   at −10000 with no error.
3. **Contradictory localStorage assumptions** — `indicatorStyle.ts:159` claims localStorage
   isn't shared across webviews, yet `IndicatorPage`/`OutputPage` hydrate from keys the
   main window wrote (same-origin WebKit views usually *do* share storage). The design
   works due to belt-and-braces event + storage redundancy.
4. `indicator.ts` and `recordingIndicator.ts` duplicate the create/position/show/
   click-through dance — a shared helper would prevent divergence.

## Difficulties & mitigations (from git `2309c2d`, `4dfe4c5`)

| Difficulty | Evidence | Mitigation |
|---|---|---|
| Can't create a hidden, positioned, transparent, click-through window in one step | `-10000` offscreen creation hack, show-then-position | extract one shared overlay-bootstrap helper; always re-send state on show |
| `setIgnoreCursorEvents` panic on unrealized GTK windows | inline comment `indicator.ts:84-87` | keep show-before-click-through ordering; add a comment+test when upgrading tao |
| Capabilities config fight — every new window needs label + permissions | `capabilities/default.json` touched in ~6 commits | document the "adding a window" checklist (doc 09) |
| New webview may miss events emitted before creation | payload duplicated in localStorage + `emitTo` | push-on-show protocol (adopted app-wide, see doc 09) |
