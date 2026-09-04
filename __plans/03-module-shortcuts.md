# 03 — Module: Global Shortcuts (toggle / hold)

Milestone: M3 · Files: `lib/shortcuts/*` (canonical.ts, engine.ts, hold.ts, capture.ts),
`pages/ShortcutsPage.tsx`, `components/ui/KeyInput.tsx`, settings schema slice (doc 11).

## Goal

OS-wide hotkeys only — no app-scope mode. Two independently configured actions:

| Action | Purpose |
|---|---|
| `voice-note` | record → transcribe → auto-paste (the headline feature) |
| `record` | record → save to library (no transcription) |

Per action: `{ combo: string|null, trigger: 'hold'|'toggle', enabled: boolean }` plus a
global master switch `globalShortcutsEnabled` (doc 11 §1 schema).

## UX spec (ShortcutsPage /shortcuts)

- PageHeader + master Switch "Global shortcuts"; status line beneath: "2 registered"
  or the first registration error in warn color.
- Two ShortcutCards (voice-note first, marked as primary):
  - Row 1: action icon + name + one-line description.
  - Row 2: KeyInput (combo capture) + SegmentedControl [Hold | Toggle] + enable Switch.
  - Hint line switches with trigger:
    - Hold: "Press and hold to run. Release to finish. Taps under 300 ms are ignored."
    - Toggle: "Press once to start. Press again to stop."
  - Status line per action: "Registered" (ok) / "Not registered — <reason>" (warn) /
    "Off" (muted).
- KeyInput behavior: focus → "Press keys…" capture; any modifier+key combo accepted;
  modifier-only rejected; Esc cancels; Backspace/Delete clears; blur ends capture;
  live Kbd preview while capturing.
- Duplicate combo across the two actions → inline field error (canonical comparison,
  not raw strings — v2 gotcha #2 fixed).

## Architecture

- **Rust**: plugin host only (`tauri-plugin-global-shortcut` 2.3.x pinned;
  capabilities allow-register/unregister). Config persisted via settings.rs;
  `settings-changed` drives frontend re-sync. No shortcut logic in Rust.
- **canonical.ts** (pure, unit-tested):
  - `comboFromKeyboardEvent(e)` → DOM-event combo string.
  - `canonicalCombo(raw)` → normalizes UI (`Ctrl+Shift+A`) and plugin
    (`shift+control+KeyA`) vocabularies: strip `Key`/`Digit`/`Numpad` prefixes,
    lowercase, order modifiers ctrl < alt < shift < meta.
  - `toAccelerator(canon)` → plugin accelerator (`Meta`→`Super` rewrite).
  - `humanize(canon)` → display form.
- **engine.ts** (main window ONLY):
  - `syncGlobalShortcuts()` — diffs registered vs desired (settings store);
    unregisters stale, registers new; **all registration serialized through a promise
    chain** (register/unregister race guard, v2-proven).
  - Single `onShortcutEvent` handler: match canonical combo + `event.state`
    (Pressed/Released) + trigger → dispatch:
    | action / trigger | Pressed | Released |
    |---|---|---|
    | voice-note · hold | startVoiceNoteHold | endVoiceNoteHold |
    | voice-note · toggle | toggleVoiceNote | — |
    | record · hold | startRecordHold | endRecordHold |
    | record · toggle | startRecording | stopRecording |
  - Pressed also emits `shortcut-armed {combo, action, trigger}`; Released emits
    `shortcut-disarmed` (consumed by doc 04).
  - **Guard: `if (label !== 'main') return` — overlays never register** (v2 ran these
    hooks in every webview → duplicate handling + status noise).
  - Per-action registration outcome → settings store `shortcutStatus[action]` → UI.
  - Ignore `event.repeat` for hold Pressed.
- **hold.ts** (one shared state machine for both actions — v2 had two near-copies):
  `beginHold(kind)` / `endHold(kind)`; ends shorter than `MIN_HOLD_MS = 300` are
  accidental taps → cancel path; **lost-keyup failsafe: 120 s hard timeout auto-stops**
  (v2 had only a blur failsafe); window `blur` also releases.
  Toggles reuse the same start/stop functions as the recorder/voiceNote modules.

## Pitfalls carried from v2 (doc 01)

1. Combo vocabulary mismatch (UI vs plugin) — solved by canonical.ts as the single
   source; add a fixture table of real plugin payloads as unit tests.
2. Partial registration (hotkey grabbed by another app) — surfaced per-action as
   first-class UI status, never silent.
3. Register/unregister races — serialized chain; debounce concurrent sync calls.
4. Key-up semantics across modifier orders — hold release matched on the non-modifier
   key (modifiers release in any order).
5. Duplicated hold machines — merged into hold.ts.

## Tasks

- [x] canonical.ts + fixtures/unit tests
- [x] engine.ts: diff-sync + serialized chain + main-window guard + status reporting
- [x] hold.ts shared machine + 300 ms tap threshold + 120 s timeout + blur failsafe
      (fake-timer tests)
- [x] settings schema (shortcuts) + setters + settings-changed wiring
- [x] ShortcutsPage: 2 cards, KeyInput capture, SegmentedControl, Switch, statuses
- [x] duplicate-combo validation (canonical) + inline errors
- [x] emit shortcut-armed / shortcut-disarmed on Pressed / Released
- [ ] Manual matrix: X11 hold/toggle × both actions; grabbed-hotkey error path

## Verification

- Unit: canonical fixtures; hold timing; diff-sync against a fake plugin API.
- Manual: hold voice-note → pill appears → speak → release (paste E2E lands in M4);
  toggle record → pill timer → toggle stops; register a combo already owned by the OS
  → status shows the reason; disable master switch → nothing registered.
