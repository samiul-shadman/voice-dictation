import type { EnvInfo } from "../stores/env";
import type { IndicatorMode } from "../stores/settings";

export type IndicatorSurfaceReason =
  | "default"
  | "user-panel"
  | "user-both"
  | "wayland-panel-fallback"
  | "gnome-wayland-degraded";

export interface IndicatorSurface {
  floating: boolean;
  panel: boolean;
  degraded: boolean;
  reason: IndicatorSurfaceReason;
}

export function floatingAvailable(env: EnvInfo | null): boolean {
  if (env === null) return true;
  return env.platform !== "linux" || env.sessionType === "x11";
}

export function resolveIndicatorSurface(
  mode: IndicatorMode,
  env: EnvInfo | null,
): IndicatorSurface {
  const canFloat = floatingAvailable(env);
  const isGnomeWayland = env?.platform === "linux" && env.sessionType === "wayland-gnome";
  const wantsFloating = mode === "floating" || mode === "both";
  const wantsPanel = mode === "panel" || mode === "both";

  if (mode === "panel") {
    return { floating: false, panel: true, degraded: false, reason: "user-panel" };
  }

  if (!canFloat && wantsFloating) {
    if (isGnomeWayland) {
      return { floating: true, panel: true, degraded: true, reason: "gnome-wayland-degraded" };
    }
    return { floating: false, panel: true, degraded: false, reason: "wayland-panel-fallback" };
  }

  return {
    floating: wantsFloating,
    panel: wantsPanel,
    degraded: false,
    reason: mode === "both" ? "user-both" : "default",
  };
}
