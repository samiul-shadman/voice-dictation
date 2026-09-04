# 02 — App Shell: Windows, Routing, Navigation

Milestone: M0.

## 1. Windows (3)

| Label | Created by | Size | Key config |
|---|---|---|---|
| main | tauri.conf.json | 880×640, min 760×560 | decorated, resizable, dark |
| indicator | src/lib/windows/indicator.ts | 320×96 | transparent, noDecorations, alwaysOnTop, skipTaskbar, shadow:false, focusable:false, hidden, offscreen −10000 |
| recording-indicator | src/lib/windows/recordingIndicator.ts | 260×76 | same overlay config |

Capabilities: `capabilities/default.json` includes all three labels + permissions
(global-shortcut register/unregister, core webview create, dialog, clipboard-manager,
opener). One file for v1; split per window if churn bites (v2 touched it ~6 times).

## 2. Main window information architecture

Left sidebar (200 px, 13 px labels, grouped):

```
VOICE        Record        /record
             Library       /library
MODELS       Models        /models
CUSTOMIZE    Shortcuts     /shortcuts
             Animations    /animations
─────────────
             Settings      /settings
```

Content column: max-w 860 px, PageHeader + sections. Sidebar footer: environment dot
(green = deps ok, amber = ffmpeg/session problem) → click opens Settings.

- `/` = RecordPage (home is the app's purpose; no redirect stubs, no greet demo).
- **Getting-started strip** on /record when needed: compact inline card listing
  "set a hotkey" / "download a model" with deep links — only shown while incomplete.
- First-run: if `detect_environment` reports missing ffmpeg → setup card pinned above
  content on /record and /settings (copyable install commands per distro family).

## 3. Routing

- **HashRouter in every window** (overlays are created by setting `url.hash` — required).
- `main.tsx`: `document.documentElement.dataset.window = label` at module scope.
- `App.tsx`: early-return per overlay label (IndicatorPage / RecordingIndicatorPage),
  each wrapped in HashRouter with catch-all `*` route; main renders the sidebar app.

## 4. CSS scoping (v2 leak lesson)

- Overlay-only transparency lives in styles/overlay.css scoped to
  `:root[data-window="indicator"]` / `:root[data-window="recording-indicator"]`.
- The shared bundle must never set an opaque background on `:root` unconditionally.

## 5. Overlay bootstrap (shared, once)

`src/lib/windows/overlay.ts` — single implementation (v2 duplicated this dance in two
files and they drifted):

```
createOverlay(label, size, url)
  → getByLabel reuse + cached pending promise; new WebviewWindow({x:-10000, y:-10000,
    visible:false, ...}); await tauri://created
ensureShown(label, position)
  → position vs primaryMonitor() → set_position → show
makeClickThrough(label)
  → setIgnoreCursorEvents(true)   // ONLY after first show — tao panics on unrealized
                                  // GTK windows; keep the comment; re-verify on tao upgrades
```

Position failure → log + one retry; never leave a window parked at −10000 silently
(v2 gotcha).

## 6. "Adding a window" checklist (all five steps required)

1. Label constant + create/ensure lib module (built on overlay.ts).
2. App.tsx branch + page component (HashRouter wrapper).
3. Label + permissions in capabilities/default.json.
4. `:root[data-window="<label>"]` scoping for overlay-only CSS.
5. Register the label in every `emitTo` producer + OverlaySync push-on-show.

## 7. Focus and lifetime policy

- Overlays are `focusable:false` + skipTaskbar + shadow:false — dropping any changes
  Linux overlay behavior (v2 finding). The hotkey → recorder → paste focus chain stays
  with the user's target app.
- Main never auto-focuses on background events; toasts and overlays carry feedback.
- v1 scope: closing main exits the app (global shortcuts die with it). Tray/daemon is
  a logged follow-up (doc 00 §5).

## Verification

- Boot → `WebviewWindow.getAll()` lists 3; overlay transparency + click-through on
  both; hash deep-links work for overlays; setup card renders when ffmpeg absent.
