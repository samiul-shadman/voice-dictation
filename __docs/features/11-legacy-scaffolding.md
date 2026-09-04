# 11 — Legacy Scaffolding (dead code to remove)

The repo began as the stock Tauri 2 + React + Vite template and evolved into a voice
dictation app. The original demo scaffolding is still wired in and should be pruned
(it also ships `greet`/`print_form` commands to the webview).

## Inventory

| Item | Location | Notes |
|---|---|---|
| **HomePage** (`/`) | `src/pages/HomePage.tsx` | Original template "Greet" demo form invoking the Rust `greet` command. Dead CSS: `.logo` hover filters and `#greet-input` in `pages.css:15-35`. |
| **FormPage** (`/form`) | `src/pages/FormPage.tsx` | Name/email/message form → Rust `print_form` command. Inline `style` overrides; still linked in the Sidebar as "Form". |
| `greet` command | `src-tauri/src/lib.rs:19-22, 47` | Registered and exposed to JS. |
| `print_form` command | `src-tauri/src/lib.rs:24-27, 47` | Powers the Output-window demo print path. |
| **AnimationsPage** | `src/pages/AnimationsPage.tsx` | Pure redirect stub to `/animations/recording` — exists only so the Sidebar has an "Animations" entry. |
| `getActiveHold()` | `src/lib/recordingHold.ts:13` | Exported, never referenced. |
| `getActiveVoiceNoteHold()` | `src/lib/voiceNote.ts:72` | Exported, never referenced. |
| `useShortcuts` raw-setter hook | `src/hooks/useShortcuts.ts` | Returns the setter directly; `ShortcutSection.update()` wraps it as a pass-through. |
| `formatTime` re-export | `src/components/RecordingAnimations.tsx:175` | Only used by the gallery page; odd export site. |
| `parakeet` cargo feature stub | `src-tauri/Cargo.toml:35-39` | `parakeet = []` kept "for backwards compatibility"; sherpa is always on. |

## UX quirks worth fixing while cleaning up

- Sidebar "Shortcut" link points to `/audio/shortcuts`, titled "Recording Shortcut",
  though it also configures the voice-note shortcut — naming mismatch.
- A default route of `/` landing on the Greet demo is confusing; the home page should
  become a dashboard (recording status, recent transcripts) or route to `/audio`.
- `window.confirm`-based destructive confirms vs the dialog plugin used elsewhere.

## Removal checklist

1. Delete `HomePage.tsx`, `FormPage.tsx`, `AnimationsPage.tsx` (or replace `/` with a
   real home and drop the `/animations` redirect in favor of a Sidebar group header).
2. Remove `greet`/`print_form` from `lib.rs` registration.
3. Remove dead CSS from `pages.css` and dead exports above.
4. Verify OutputPage still has content without the `print_form` demo path (real
   shortcut prints remain).
5. Re-check `capabilities/default.json` for permissions only the removed features used.
