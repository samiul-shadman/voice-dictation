# 04 — Module: Shortcut Indicator Pill

Milestone: M3 · Files: `lib/windows/indicator.ts`, `pages/IndicatorPage.tsx`,
App.tsx branch, OverlaySync handshake (doc 11 §3).

## Goal

A click-through glass pill confirming "your hotkey fired and what it will do": shown
while a hold is pressed; a brief flash for toggles. Purely informational — never
focusable, never clickable.

## Behavior

| Trigger | Behavior |
|---|---|
| hold Pressed | show pill: Kbd combo + action label; hide on Released |
| toggle Pressed | show 1.2 s "started" state (accent dot), auto-hide |
| recording / transcribing starts | hide — the recording-indicator (doc 10) takes over |
| global shortcuts disabled | never shown |

Content: horizontal pill — [Kbd: Ctrl+Shift+Space] "Voice note" (+ pulsing dot while
active). Must fit the 320×96 window with 12 px margin.

## Window

- `indicator` — 320×96; transparent, decorations false, alwaysOnTop, skipTaskbar,
  shadow false, focusable false, hidden; created offscreen at −10000; positioned on
  show: primary monitor, horizontal center, y = 75 % height. Multi-monitor: primary
  display only (documented limitation, v2 parity).
- Click-through via `setIgnoreCursorEvents(true)` **after first show** (tao panics on
  unrealized GTK windows — keep the inline comment + ordering; re-verify on tao
  upgrades). Owned by the shared `overlay.ts` helper (doc 02 §5).

## State flow (uses the doc 11 §3 protocol)

- Main shortcut engine emits `shortcut-armed {combo, action, trigger}` /
  `shortcut-disarmed` via `emitTo('indicator', …)`.
- IndicatorPage: on mount → start listeners + emit `overlay-ready {label:'indicator'}`;
  OverlaySync (main) re-pushes current armed/disarmed state on ready (covers
  broadcast-before-existence).
- **No localStorage mirroring** — events + re-push suffice for this transient state
  (v2 duplicated payloads into localStorage; unnecessary once the protocol exists).

## Pitfalls carried from v2 (doc 02)

1. Broadcasts emitted before the window exists are lost → overlay-ready re-push.
2. setIgnoreCursorEvents panic ordering → show-first; one helper owns the ordering.
3. primaryMonitor() failure → window parked at −10000 silently → helper logs + retries.
4. Focus stealing → `focusable:false` belt; never call set_focus.

## Tasks

- [x] indicator.ts (ensure/show/hide) on the overlay.ts helper
- [x] IndicatorPage: pill layout, Kbd chip, action label, active dot, pop-in/out
- [x] armed/disarmed listeners + overlay-ready handshake with OverlaySync
- [x] toggle-mode 1.2 s timed flash; hold-mode pressed/released lifecycle
- [x] hand-off: hide when recorder/transcriber becomes active (subscribe stores)
- [x] App.tsx branch + capabilities + data-window CSS scoping (checklist doc 02 §6)

## Verification

- Manual X11: hold → pill pops in; release → hides; toggle → 1.2 s flash; start a
  recording mid-hold → shortcut pill hides, recording pill appears; clicks pass
  through; no taskbar entry; typing in another app is never interrupted.
