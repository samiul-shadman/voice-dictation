# 09 — Module: Auto-Paste Engine

Milestone: M4 · Files: `src-tauri/src/paste.rs` (+ bundled terminal data),
`sysinfo.rs` session detection, SettingsPage auto-paste section, toast wiring.

## Goal

After a voice-note transcription, put the text where the user was typing: clipboard
first (invariant), then synthesize the paste keystroke into the focused app. Five
modes; Linux capability tiers (X11 best; wlroots-Wayland via `wtype`; GNOME-Wayland
clipboard-only).

## Modes

| Mode | Behavior |
|---|---|
| `auto` (default) | terminal focused → Ctrl+Shift+V; else Ctrl+V (X11 detection only) |
| `ctrl_v` | always Ctrl+V |
| `ctrl_shift_v` | always Ctrl+Shift+V |
| `shift_insert` | Shift+Insert (no wtype fallback — unsupported) |
| `clipboard_only` | copy only, no keystrokes |

Lenient aliases (`ctrl-v`, `ctrlv`, `clipboard`, `none`, …) parsed via
`PasteMode::parse` — port the v2 tests.

## Flow (paste.rs `paste_transcript`)

1. Empty text → no-op success.
2. **Clipboard first** via the clipboard-manager plugin — the universal fallback; the
   text is always available for manual paste no matter what fails below.
3. `clipboard_only` → done. Else sleep `PASTE_DELAY = 120 ms` — the global hotkey's
   key-up must propagate before the synthetic Ctrl+V is injected (v2 comment
   preserved).
4. `auto` on X11: `focused_window_is_terminal()` → ctrl_shift_v; detection failure →
   ctrl_v fallback.
5. enigo 0.5: press modifiers in order, tap the key, release modifiers in reverse.
6. **Wayland fallback**: enigo 0.5 drives X11 only. If synthesis fails and the session
   is Wayland (`XDG_SESSION_TYPE`, else `WAYLAND_DISPLAY && !DISPLAY` — greetd-safe):
   wait an extra 150 ms → shell out to `wtype` (`-M ctrl -k v -m ctrl`, etc.).
   GNOME/Mutter lacks the virtual-keyboard protocol → fails by design → the error
   names the limitation + the clipboard fallback. Shift+Insert unsupported via wtype.
7. Failure → message with wtype install hints + the manual combo → shipped in
   `transcribe-complete.pasteError` → toast.

**Runs on the transcription worker thread** (v2: the Linux clipboard backend deadlocks
against the UI thread — preserved and commented).

## Terminal detection (X11, x11rb)

- `_NET_ACTIVE_WINDOW` → `WM_CLASS` (instance + class, two NUL-terminated strings);
  case-insensitive matching.
- **Data-driven list**: bundled `terminals.toml` (exact classes + substrings)
  compiled in via `include_str!` with the v2 ~36-entry list as the default —
  extensible without a rebuild (adopted v2 mitigation). Substring heuristics
  (`terminal|konsole|xterm|alacritty|wezterm`)
  as the final fallback.
- Port the v2 parsing/matching unit tests (string variance burned them once).

## Settings UI (SettingsPage → Auto-paste section)

- RadioCardGroup with the 5 modes; per-option hint lines (same guidance as v2,
  redesigned).
- Session banner above the group (from `detect_environment`):
  - X11 → "X11 session — all paste modes available."
  - wlroots Wayland → "Wayland: paste uses wtype — install it for best results
    (install hint). Terminal auto-detection is unavailable on Wayland; pick
    Ctrl+Shift+V if you dictate into terminals."
  - GNOME Wayland → "GNOME Wayland restricts synthetic input — paste is
    clipboard-only (press Ctrl+V manually)."
  - wtype missing + Wayland → actionable install hint.
- pasteError toast copy: "Paste failed: <reason>. The text is on your clipboard."

## Pitfalls carried from v2 (doc 07)

1. Wayland tiers by design — surfaced honestly in the UI (banner), never silently.
2. Timing-based sync (120/150 ms) — accepted; nothing verifies the paste landed;
   clipboard-first covers failure. Logged improvement: query modifier state instead
   of fixed sleeps.
3. Terminal list data-driven (above).
4. Worker-thread execution (above).

## Tasks

- [x] paste.rs port: modes / aliases / combo resolve / enigo press chain (+ ported
      tests)
- [x] Wayland detection + wtype fallback + install-hint errors
- [x] terminals.toml + loader + fallback heuristics (+ tests)
- [x] Settings section (RadioCardGroup + session banner)
- [x] pasteError → toast integration (doc 07 completion fan-out)
- [x] worker-thread call site wired to voice-note completion

## Verification

- Unit: alias parsing, WM_CLASS parsing, list matching, combo resolution matrix.
- Manual X11: text editor (ctrl_v), GNOME Terminal (auto → ctrl_shift_v),
  clipboard_only; wlroots with and without wtype installed; GNOME Wayland
  clipboard-only path with the banner shown.
