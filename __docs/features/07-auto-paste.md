# 07 — Auto-Paste (paste.rs)

## What it does

After a voice-note transcription, the transcript is written to the clipboard and (unless
disabled) the paste keystroke is synthesized into whatever app has focus. Five modes:

| Mode | Behavior |
|---|---|
| `auto` (default) | Terminal focused → Ctrl+Shift+V; everything else → Ctrl+V |
| `ctrl_v` | Always Ctrl+V (Cmd+V on macOS) |
| `ctrl_shift_v` | Always Ctrl+Shift+V |
| `shift_insert` | Shift+Insert (unsupported via the Wayland `wtype` fallback) |
| `clipboard_only` | Copy to clipboard, no keystrokes |

Aliases parsed leniently: `ctrl-v`, `ctrlv`, `clipboard`, `none`, etc.
(`paste.rs:16-50`).

## UI / UX

Settings page → **Auto-paste** radio group (5 options with per-option hints); the
Wayland `wtype` caveat is documented directly in the UI (`SettingsPage.tsx:76-112`).
Persisted via Rust `set_paste_mode` → `settings.json`.

## Implementation (`src-tauri/src/paste.rs`)

Flow (`paste_transcript`, `paste.rs:99-139`):

1. Empty text → no-op success.
2. **Clipboard first** via `tauri_plugin_clipboard_manager` — the transcript is always
   available for a manual paste even if keystroke injection fails. This ordering is the
   safety net for every downstream failure path.
3. `clipboard_only` stops there; otherwise sleep `PASTE_DELAY = 120 ms` so the global
   shortcut's **key-up has time to propagate** before the synthetic Ctrl+V is injected
   (`paste.rs:6-10`).
4. `resolve_combo`: in `auto` mode on Linux, `focused_window_is_terminal()` →
   Ctrl+Shift+V (terminals don't bind Ctrl+V); detection failure falls back to Ctrl+V.
5. Keystroke synthesized with **enigo 0.5**: press modifiers in order, tap the key,
   release modifiers in reverse (`press_with_modifiers`, `paste.rs:205-236`); macOS
   CtrlV remapped to Cmd+V.
6. **Wayland fallback**: enigo 0.5 only drives X11. If synthesis fails and the session
   is Wayland (via `XDG_SESSION_TYPE`, else `WAYLAND_DISPLAY && !DISPLAY` — covering
   greetd/nested sessions), wait an extra 150 ms and shell out to **`wtype`**
   (`-M ctrl -k v -m ctrl`, etc.). Shift+Insert is intentionally unsupported via wtype.
7. Failure returns a message naming wtype install hints + the manual combo; the error
   string ships to the UI inside `transcribe-complete.pasteError`.

**Terminal detection** (Linux-only, `x11rb`, `paste.rs:288-393`): reads
`_NET_ACTIVE_WINDOW` off the root window, then `WM_CLASS` (instance + class, two
NUL-terminated strings), matches case-insensitively against a ~36-entry hard-coded
terminal list plus substring heuristics (`terminal|konsole|xterm|alacritty|wezterm`).
Extensive unit tests for parsing/class-matching — the dev was clearly burned by string
format variance.

**Invocation**: from the transcription worker thread when `auto_paste` is set (both
voice-note toggle and hold pass `true`, `src/lib/voiceNote.ts:30,66`).

## Gotchas

1. **Wayland is second-class by design**: enigo = X11 only; `wtype` needs the
   virtual-keyboard protocol which **GNOME/Mutter doesn't implement** ("fails there by
   design", `paste.rs:250-253`); and terminal detection can't work on Wayland (no
   WM_CLASS equivalent) so `auto` silently degrades to Ctrl+V. Effective result:
   auto-paste is reliable on X11, best-effort on wlroots Wayland, clipboard-only on
   GNOME Wayland.
2. **Timing-based synchronization** — 120 ms + 150 ms delays race the OS key-up and the
   target app's clipboard settle; nothing verifies the paste actually landed.
3. On Wayland, `auto` can't distinguish terminals — expect to manually pick
   `ctrl_shift_v` for terminal-heavy workflows.
4. The hard-coded terminal class list must be recompiled to extend; it should be a
   data/config file.
5. Paste runs on the transcription worker thread specifically to avoid deadlocking the
   Linux clipboard backend against the UI — moving it to the main thread would regress.

## Difficulties & mitigations (from git `959be5e`, `12945d9`)

| Difficulty | Evidence | Mitigation |
|---|---|---|
| Key-up of the global hotkey leaked into the synthetic paste | the 120 ms `PASTE_DELAY` comment | keep the delay; consider querying modifier state instead of a fixed sleep |
| Terminals ignore Ctrl+V | 36-entry WM_CLASS detector + `auto` mode | make the terminal list data-driven; document that Auto = X11-only |
| enigo can't drive Wayland | `wtype` subprocess fallback + extra delay | keep clipboard-first invariant as the universal fallback; surface per-session capability at startup with actionable hints |
| String-format variance in WM_CLASS / session env vars | lenient parsing + heavy unit tests | keep the tests; extend the class list with real-world samples |
