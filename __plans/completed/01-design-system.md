# 01 — Design System ("Quiet Dark Studio")

Milestone: M0 (tokens + primitives) — consumed by every module.

## 1. Direction and principles

- **Quiet dark studio**: near-black neutrals, one violet accent, hairline borders,
  layered low shadows, generous whitespace. Color is information: violet = interactive,
  rose-red = recording only, green = success. Nothing else gets saturated color.
- **Keyboard-first**: every primary action reachable by key; visible focus rings;
  hotkey combos rendered in mono Kbd chips throughout the UI.
- **Calm motion**: 120–240 ms, one easing curve; overlays animate with CSS only; the
  mic level drives visuals via a CSS variable, never per-frame JS.
- **Honest states**: empty, loading, error, and disabled are designed, not implied.

## 2. Tokens (styles/tokens.css)

Colors (dark-only for v1; CSS-var swap leaves room for a light theme later):

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0A0B0F` | page background |
| `--surface` | `#101318` | cards, inputs |
| `--surface-2` | `#171B22` | raised, hover, chips |
| `--border` | `rgba(255,255,255,.08)` | hairlines |
| `--border-strong` | `rgba(255,255,255,.14)` | hover borders |
| `--text` | `#E7EAF0` | primary text |
| `--text-2` | `#A2AAB8` | secondary text |
| `--text-3` | `#6B7280` | muted/hints |
| `--accent` | `#8B7CF7` | interactive accent (violet) |
| `--accent-strong` | `#A79BFF` | accent hover |
| `--accent-soft` | `rgba(139,124,247,.14)` | accent fills, selected states |
| `--rec` | `#F43F5E` | recording state ONLY |
| `--ok` | `#34D399` | success |
| `--warn` | `#FBBF24` | warnings (missing deps, registration issues) |
| `--err` | `#F87171` | errors |

Typography: Inter 400/500/600 (UI); JetBrains Mono 400/500 (combos, timers, durations,
paths, transcript text).

Type scale: caption 11 · body-s 13 (default UI) · body 14 · subtitle 16 · title 20 ·
page 26 (600, −0.02em tracking).

Space scale (4 base): 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48.
Radius: sm 8 · md 12 · lg 16 · pill 999.
Shadows: rest `0 1px 2px rgba(0,0,0,.4)` · raised `0 8px 24px rgba(0,0,0,.45)` ·
overlay pill `0 12px 32px rgba(0,0,0,.55)`.

## 3. Tailwind v4 setup

- `@import "tailwindcss"`; `@theme` maps the CSS vars above to utilities
  (`bg-surface`, `text-text-2`, `border-border`, ...).
- Conventions: page container `px-6 py-6 max-w-[860px]`; section card
  `rounded-2xl border bg-surface p-5`; hint text `text-13 text-text-3`.

## 4. UI kit (components/ui — one file per primitive + index.ts)

| Component | Spec |
|---|---|
| Button | primary (accent) / secondary (surface-2 + border) / ghost / danger; sizes sm 28 · md 36 · lg 44; loading spinner state |
| IconButton | 32×32 ghost; tooltip required |
| Kbd | mono chip: surface-2, border, radius 6, px 6 py 2, 12px |
| KeyInput | capture-mode combo input (spec in doc 03) |
| SegmentedControl | 2–3 options, sliding thumb, 4px inset, 160 ms |
| RadioCardGroup | vertical cards; selected = accent border + accent-soft bg; per-option hint |
| Switch | 36×20, 160 ms thumb |
| Select | native select, styled surface-2 |
| TextInput | 36px, accent focus ring |
| Field | label + control + hint/error line |
| Progress | 4px accent bar; optional mono percent suffix |
| Spinner | 16/20px, 800 ms linear |
| Badge | success (ok-soft) / neutral / warn |
| SectionCard | title + description + children |
| Dialog | blur scrim, surface radius-16 panel, Esc + scrim close, destructive variant |
| Toast | bottom-right; auto-dismiss 4 s; error persists with action button |
| Tooltip | dark, 120 ms delay |
| EmptyState | icon + title + hint + primary action |
| PageHeader | 26px title + one-line description |

## 5. Iconography

lucide-react only, stroke 1.75: Mic, AudioLines, LibraryBig, Cpu, Keyboard, Wand,
Settings, Play, Pause, Square, Trash2, Copy, RefreshCw, FolderOpen, X, Check,
CircleAlert. Sizes: 16 inline · 20 controls · 24 empty states.

## 6. Motion

- Durations 120/180/240 ms; ease `cubic-bezier(.2,.8,.2,1)`; pop-in = scale .96→1 + fade.
- Mic level: CSS var `--voice-level` (0..1) set via rAF-throttled JS at ≤20 Hz on the
  recording pill; all level-reactive visuals are `calc()` on that var (no per-frame JS).
- `prefers-reduced-motion: reduce` → global kill-switch block; keep opacity-only
  state changes.

## 7. Accessibility

- Focus-visible rings everywhere; ARIA labels on icon buttons; dialogs trap focus;
  SegmentedControl is a radiogroup; gallery previews `aria-hidden` (decorative).
- Contrast: primary text ≥ 7:1, secondary ≥ 4.5:1, text on accent-soft ≥ 4.5:1.

## 8. Overlay aesthetics (both overlay windows)

- Glass pill: `background: rgba(16,19,24,.72); backdrop-filter: blur(14px)
  saturate(1.2);` hairline border, pill radius, overlay shadow; content is a Kbd chip
  + label (doc 04) or an animation (doc 10).
- Compact paddings; the pill must fit 320×96 / 260×76 windows with 12 px margin.

## 9. Do / Don't

- Don't: `window.confirm`/`alert`; saturated color outside accent/rec/ok; per-frame JS
  animation; light theme in v1; emoji in UI.
- Do: show missing-dependency setup cards inline on affected pages; toast every
  background completion; human units everywhere (`2 min ago`, `3.4 MB`, `1:23`).

## 10. Files

- styles/tokens.css · styles/base.css (reset, scrollbars, focus) · styles/overlay.css
  (`data-window`-scoped transparency — doc 02 §4).
- The animation gallery pages double as living component previews (no Storybook).
