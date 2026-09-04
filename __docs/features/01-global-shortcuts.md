# 01 — Global & In-App Shortcuts

## What it does

A configurable shortcut system with two scopes and three actions:

- **Scope**: `app` (only while the app window is focused) or `global` (OS-wide, via
  `tauri-plugin-global-shortcut`).
- **Action**: `print` (types text into the Output window — legacy), `record`
  (start/stop a recording), `voice-note` (record → transcribe → auto-paste).
- **Trigger**: `toggle` (press to start, press again to stop) or `hold`
  (press-and-hold to record, release to stop/cancel).

## UI / UX

- **ShortcutSection** (`src/components/ShortcutSection.tsx`, Settings page): CRUD list for
  `print` shortcuts — combo chip, printed text, enabled checkbox, Edit/Delete, add/edit
  form with `ShortcutInput` + textarea. Global scope shows a master "Enable global
  shortcuts" checkbox and a registration-failure status string.
- **AudioShortcutSection** (`src/components/AudioShortcutSection.tsx`, `/audio/shortcuts`):
  same CRUD pattern plus **scope radio** (App/Global) and **trigger radio**
  (Toggle/Hold), with long explanatory hints about hold vs toggle and auto-paste.
- **ShortcutInput** (`src/components/ShortcutInput.tsx`): read-only input; focusing it
  enters "Press keys…" capture mode. Escape cancels, Backspace/Delete clears, any
  modifier+key combo is accepted via `comboFromKeyboardEvent` and auto-blurs.
  Modifier-only presses are rejected by the section components.
- Duplicate-combo detection across both scopes with a scope-aware error message.

## Implementation

- **Data model** (`src/lib/shortcuts.ts:12-20`):
  `{ id, combo, text, enabled, scope, action, trigger }`.
  Persisted in localStorage `settings:shortcuts` + `settings:global-enabled` with a
  pub/sub store consumed via `useSyncExternalStore`.
- **Combo canonicalization** (`shortcuts.ts:31-93`): the UI records `Ctrl+Shift+A`-style
  strings, but the plugin reports `shift+control+KeyA`. `canonicalCombo()` normalizes
  both vocabularies (strips `Key`/`Digit`/`Numpad` prefixes, lowercases, reorders).
  `toAccelerator()` maps `Meta`→`Super` for the plugin.
- **App scope** (`hooks/useShortcutListener.ts`): window `keydown`/`keyup` handlers,
  `preventDefault`, `event.repeat` guards. Hold release is tracked by matching the
  non-modifier key (modifiers release in any order), with window `blur` as a failsafe.
- **Global scope** (`src/lib/globalShortcuts.ts:122-162`): `syncGlobalShortcuts()` diffs
  the currently-registered OS shortcuts against the desired set (unregister stale,
  register new). All registration is serialized through a promise chain to avoid
  concurrent register/unregister races. A single `onShortcutEvent` handler dispatches by
  canonical combo + `event.state` (`Pressed`/`Released`) + trigger mode.
- **Hold state machines** (`src/lib/recordingHold.ts`, `src/lib/voiceNote.ts`): module
  singletons; releases shorter than `MIN_HOLD_MS = 300ms` are treated as accidental taps
  and cancelled.
- The Rust side only hosts the plugin (`tauri-plugin-global-shortcut` v2.3.2, pinned in
  `Cargo.toml:23`); capabilities `global-shortcut:allow-register/unregister`
  (`capabilities/default.json:9-10`).

## Gotchas

1. **Overlays register shortcuts too** — `useGlobalShortcuts()` runs unconditionally in
   *every* webview (`App.tsx:30-31`), so overlay windows also call `register` for the
   same accelerators. The plugin is process-global; this can produce duplicate
   handling or spurious "Not registered" status noise. Scoping these hooks to the main
   window would be safer.
2. **Duplicate detection compares raw strings**, not canonical combos — `Ctrl+A` vs a
   `ctrl+KeyA` variant could evade it (low practical risk since both come from the same UI).
3. **Lost key-up** — if the app loses focus mid-hold and never gets keyup, the hold
   state machine relies on the `blur` safety net; a timeout failsafe would be more robust.
4. **Duplicated hold logic** — `recordingHold.ts` and `voiceNote.ts` are near-identical
   state machines that could share one helper.
5. Radio-group `name` collisions: `${action}-scope`/`${action}-trigger` — a third section
   with the same action would break radio grouping.

## Difficulties & mitigations (from git `48d31a2`, `136ac25`)

| Difficulty | Evidence | Mitigation |
|---|---|---|
| Two incompatible combo vocabularies (UI vs plugin events) | whole `canonicalCombo` layer; `Meta`→`Super` rewrite | keep the mapping in one tested module (done); add a regression table for accelerator formats |
| Partial registration failures (hotkey grabbed by another app) | serialized `chain` promise queue, status string surfaced in UI | treat "not registered" as a first-class UI state (done) |
| Key-up semantics across modifier orders, auto-repeat, blur | `event.repeat` guards, non-modifier key tracking, `blur` failsafe, 300 ms tap threshold | document that only one path (app vs global) may own a hold; add a lost-keyup timeout |
