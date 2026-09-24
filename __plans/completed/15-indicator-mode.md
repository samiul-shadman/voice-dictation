# 15 — Indicator Mode (floating | panel | both)

Status: pending. Depends on the completed `13-cross-platform.md` tray groundwork.

Milestone: M6 · Files: `src/lib/windows/indicatorMode.ts` (+ test),
`src/lib/OverlaySync.tsx`, `src/pages/SettingsPage.tsx`, `src-tauri/src/settings.rs`,
`src-tauri/src/tray.rs`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`.

## Goal

Let the user choose where the app announces itself: the click-through floating pill
(default), the system tray / panel icon, or both. The floating overlays remain the
default surface; the panel is the selectable alternative **and** the automatic
fallback where floating windows cannot be positioned (Linux Wayland). Never leave the
user with no visible surface: on GNOME-Wayland, where the panel icon may not render
without the AppIndicator extension, keep a degraded floating overlay and show a
Settings setup hint.

## Decisions

| Question | Decision |
|---|---|
| Setting shape | `indicatorMode: "floating" \| "panel" \| "both"`, persisted in Rust `settings.json` (single authority, invariant #1); default `"floating"`. Validated by `validate_indicator_mode`; unknown values rejected. |
| Resolution | Pure function `resolveIndicatorSurface(mode, env)` in `src/lib/windows/indicatorMode.ts` returns `{ floating, panel, degraded, reason }`; `OverlaySync` is the only consumer that acts on it. |
| Wayland auto-fallback | On any Linux Wayland session floating overlays cannot be positioned, so a `floating`/`both` request resolves to panel-only (`wayland-panel-fallback`). |
| GNOME-Wayland | Keep the floating overlay **and** the panel, mark the surface `degraded` (`gnome-wayland-degraded`), and surface an AppIndicator-extension hint in Settings. |
| Panel menu | Tray menu is exactly **Open Voice Dictation** (show + focus main) and **Quit** (`app.exit(0)`). Tray icon colour reflects idle / recording / transcribing / error via `set_tray_state`. |
| Tray lifecycle | `tray::apply` creates the tray when the resolved surface needs it and removes it otherwise; idempotent (checked by `tray_by_id`). |
| Bundle dependency | Linux bundles declare the AppIndicator runtime in `bundle.linux`: deb `libayatana-appindicator3-1`, rpm `libappindicator-gtk3`. |
| Optimistic unknown env | `floatingAvailable(null)` is `true` — before detection completes the app assumes the default floating surface rather than pre-emptively falling back. |

## Resolution matrix

`mode` × detected session → surfaces. "degraded" means floating is kept despite being
unreliable, because the panel may be invisible.

| `indicatorMode` | X11 / macOS / Windows | Wayland (wlroots) | GNOME-Wayland |
|---|---|---|---|
| `floating` (default) | floating | panel (fallback) | floating + panel, **degraded** |
| `panel` | panel | panel | panel |
| `both` | floating + panel | panel (floating dropped) | floating + panel, **degraded** |

Reason codes emitted by the resolver: `default`, `user-panel`, `user-both`,
`wayland-panel-fallback`, `gnome-wayland-degraded`.

## Behavior

| Trigger | Behavior |
|---|---|
| mode = `floating` | floating pill on X11/mac/win; on Wayland the panel icon instead |
| mode = `panel` | panel icon only, on every session; floating windows stay hidden |
| mode = `both` | floating + panel where floating works; panel only on wlroots Wayland |
| mode changes | `settings-changed` (`indicatorMode`) → `OverlaySync` re-resolves; `tray::apply` creates/removes the tray |
| GNOME-Wayland floating | degraded floating overlay + panel + Settings AppIndicator hint |

## Files touched

- `src/lib/windows/indicatorMode.ts` (+ `indicatorMode.test.ts`) — resolver and
  `floatingAvailable`.
- `src/lib/stores/settings.ts` — `IndicatorMode` type + `indicatorMode` field.
- `src/lib/OverlaySync.tsx` — surface-driven window show/hide and `set_tray_state`.
- `src/pages/SettingsPage.tsx` — mode selector and the GNOME extension hint.
- `src-tauri/src/settings.rs` — `indicator_mode` field/default, `validate_indicator_mode`,
  `set_indicator_mode`, camelCase diff field.
- `src-tauri/src/tray.rs` — lazy `apply`/`build`, Open + Quit menu, `set_tray_state`.
- `src-tauri/src/lib.rs` — register `set_indicator_mode`, call `tray::apply` at setup.
- `src-tauri/tauri.conf.json` — `bundle.linux.deb.depends` / `rpm.depends`.
- Docs: `README.md`, `AGENTS.md`, `__docs/features/08`, `09`, `13-cross-platform.md`.

## Verification

- `bunx vitest run src/lib/windows/indicatorMode.test.ts` — every mode × session pair
  asserts the matrix above (12 cases already cover X11, wlroots, GNOME-Wayland, macOS,
  and `null`).
- `bun run build` (tsc) and `cd src-tauri && cargo check --all-targets && cargo test`.
- `python3 -m json.tool src-tauri/tauri.conf.json` parses.
- Manual X11: `floating` shows the pill and no tray; `panel` shows the tray icon and no
  pill; `both` shows both; tray menu Open focuses the window and Quit exits.
- Manual Wayland (wlroots): `floating` falls back to the panel; no misplaced overlay.
- Manual GNOME-Wayland: degraded floating overlay still appears; Settings shows the
  AppIndicator extension hint; with the extension enabled the panel icon appears too.

## Risks

- **GNOME tray invisibility.** `resolveIndicatorSurface` reports `panel: true` even
  when the extension is missing, so nothing can detect "tray is on screen". Mitigation:
  the `degraded` flag keeps the floating overlay and the Settings hint explains the
  extension.
- **Bundle dependency override.** Both Linux bundlers write *only* the configured
  `depends` list (confirmed against `tauri-bundler` source: deb `settings.deb().depends`
  and rpm `settings.rpm().depends`, both `unwrap_or_default()` — no ELF/`ldd`
  auto-detection), so both lists are spelled out explicitly:
  `bundle.linux.deb.depends` = `libwebkit2gtk-4.1-0`, `libgtk-3-0`,
  `libayatana-appindicator3-1`; `bundle.linux.rpm.depends` = `webkit2gtk4.1`, `gtk3`,
  `libappindicator-gtk3`. Schema keys confirmed against the installed
  `@tauri-apps/cli/config.schema.json` (2.11.4).
- **AppIndicator soname drift.** Tauri dlopens `libayatana-appindicator3.so.1` with a
  `libappindicator3.so.1` fallback; distros that package only one of the two still
  work, but the deb/rpm dependency names differ (`libayatana-appindicator3-1` vs
  `libappindicator-gtk3`).
- **Runtime tray churn.** Toggling modes creates/removes the tray at runtime; `apply`
  must stay idempotent and must not panic when the tray was never created.
- **Unknown session.** Before `sysinfo` detection resolves, the resolver assumes
  floating (`floatingAvailable(null) === true`); a Wayland user may briefly see a
  floating request before the fallback applies.
