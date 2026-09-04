# 09 — Multi-Window Architecture & Cross-Window State Sync

## What it does

One React bundle serves **four webviews**, discriminated by Tauri window label. Three
windows (output, indicator, recording-indicator) are created at runtime from the
frontend; only `main` is declared in `tauri.conf.json`.

| Label | Created by | Config | Purpose |
|---|---|---|---|
| `main` | `tauri.conf.json:13-19` | 800×600, decorated | Sidebar app UI |
| `output` | `src/lib/output.ts:68-80` | 520×420, resizable, centered, decorated | Shortcut print log |
| `indicator` | `src/lib/indicator.ts:21-42` | 340×110, transparent, no decorations, always-on-top, skipTaskbar, no shadow, unfocusable, hidden, offscreen (−10000) | Held-shortcut pill |
| `recording-indicator` | `src/lib/recordingIndicator.ts:10-30` | 250×64, same overlay config | Recording/transcribing animation |

Window creation is enabled by the `core:webview:allow-create-webview-window`
capability; `capabilities/default.json` applies to all four labels.

## Implementation

- **Label routing** (`src/main.tsx:8`, `src/App.tsx:24-61`): at module scope,
  `document.documentElement.dataset.window = getCurrentWebviewWindow().label`;
  `App.tsx` early-returns a per-overlay render branch (each wrapped in a `HashRouter`
  with a catch-all `*` route — hash routing is required because overlay windows are
  created by setting `url.hash` on the current URL).
- **CSS scoping**: overlay-only transparency is scoped to
  `:root[data-window="indicator"]` / `:root[data-window="recording-indicator"]`
  (`global.css:17-22`) — native `transparent: true` alone wasn't enough because the
  shared CSS bundle gave the root an opaque background (commit `3ed55c9`).
- **Overlay bootstrap pattern** (duplicated in `indicator.ts`, `recordingIndicator.ts`):
  create offscreen at −10000, hidden → `ensureWindow()` idempotent via
  `getByLabel` + cached pending promise → position against `primaryMonitor()` →
  show → only then `setIgnoreCursorEvents(true)` (tao panics on unrealized GTK
  windows otherwise) → re-push current state.
- **Event bus** (global `app.emit` from Rust — every window hears everything — plus
  targeted `emitTo` from the frontend): `recording-state`, `recording-level`,
  `transcribe-progress/-complete/-error`, `model-download-*`,
  `shortcut-indicator`, `shortcut-output(/-cleared)`, `indicator-style-changed`.
- **State sync protocol** (the app's central pattern):
  1. Push state to the overlay on every show (broadcasts before creation are lost).
  2. Treat events as *state-adoption* signals (overlay flips `busy` on any
     `transcribe-progress` with no active path).
  3. Mirror selections into localStorage as a belt-and-braces snapshot.
- **State without a state library**: ~10 hand-rolled module-singleton stores
  (`Set<() => void>` listeners + `useSyncExternalStore`): shortcuts, audio dir/format,
  recording state, mic level, transcriber, model downloads, indicator styles,
  global-shortcut status.

## "Adding a window" checklist

1. Window label constant + `create/ensure` lib module (copy the overlay bootstrap
   pattern).
2. `App.tsx` branch + page component (HashRouter wrapper).
3. Add the label to `capabilities/default.json` (and any new permissions).
4. Scope overlay-only CSS via `:root[data-window="<label>"]`.
5. Register the label in any `emitTo` producers that target it.

## Gotchas

1. **`useGlobalShortcuts` / `useShortcutListener` run in every window**, including
   overlays — overlay webviews register the same OS accelerators and keydown handlers.
   Process-global plugin semantics make this risky (duplicate handling / registration
   noise). Scope these hooks to the main window.
2. **Primary-monitor-only positioning** — overlays appear on the primary display even
   when the user works on another monitor; no per-monitor DPI handling.
3. **Lost-broadcast class of bugs** — any new state pushed to an overlay must follow
   the push-on-show protocol or it will silently not apply (this bit the project at
   least twice: payload duplication, style re-sync `2b2069f`).
4. Contradictory localStorage-sharing assumptions (doc 08 gotcha 1).
5. `focusable: false` + `skipTaskbar` + `shadow: false` are all required for an
   unobtrusive Linux overlay; dropping any of them changes behavior.

## Difficulties & mitigations (from git `4dfe4c5`, `2309c2d`, `6316653`, `3ed55c9`, `2b2069f`)

| Difficulty | Evidence | Mitigation |
|---|---|---|
| Capabilities file churn on every new window | touched in ~6 commits | keep the checklist above; consider splitting capabilities per window |
| GTK/tao crash on `setIgnoreCursorEvents` before realization | documented inline in both overlay libs | keep show-first ordering; re-verify after tao upgrades |
| Overlay created after a broadcast missed it | payload duplicated in localStorage + emitTo; re-sync on show | formalize the three-step sync protocol; consider moving persistent selections into the Rust settings store so any window can read the authority |
| Shared CSS bundle leaking overlay styles | `data-window` attribute scoping fix | make label-scoping a linting/naming rule for overlay CSS |
