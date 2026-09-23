import { describe, expect, it } from "vitest";
import { floatingAvailable, resolveIndicatorSurface } from "./indicatorMode";
import type { EnvInfo } from "../stores/env";

const X11: EnvInfo = {
  platform: "linux",
  micAvailable: true,
  accessibilityPermission: true,
  sessionType: "x11",
  wtype: null,
};

const WLROOTS: EnvInfo = {
  platform: "linux",
  micAvailable: true,
  accessibilityPermission: true,
  sessionType: "wayland-wlroots",
  wtype: true,
};

const GNOME_WAYLAND: EnvInfo = {
  platform: "linux",
  micAvailable: true,
  accessibilityPermission: true,
  sessionType: "wayland-gnome",
  wtype: false,
};

const MACOS: EnvInfo = {
  platform: "macos",
  micAvailable: true,
  accessibilityPermission: true,
  sessionType: "native",
  wtype: null,
};

describe("floatingAvailable", () => {
  it("is optimistic when env is unknown", () => {
    expect(floatingAvailable(null)).toBe(true);
  });

  it("allows floating on X11", () => {
    expect(floatingAvailable(X11)).toBe(true);
  });

  it("denies floating on Wayland sessions", () => {
    expect(floatingAvailable(WLROOTS)).toBe(false);
    expect(floatingAvailable(GNOME_WAYLAND)).toBe(false);
  });

  it("allows floating on non-Linux platforms", () => {
    expect(floatingAvailable(MACOS)).toBe(true);
  });
});

describe("resolveIndicatorSurface", () => {
  it("keeps floating on X11 in floating mode", () => {
    expect(resolveIndicatorSurface("floating", X11)).toEqual({
      floating: true,
      panel: false,
      degraded: false,
      reason: "default",
    });
  });

  it("shows only the panel on X11 in panel mode", () => {
    expect(resolveIndicatorSurface("panel", X11)).toEqual({
      floating: false,
      panel: true,
      degraded: false,
      reason: "user-panel",
    });
  });

  it("shows both surfaces on X11 in both mode", () => {
    expect(resolveIndicatorSurface("both", X11)).toEqual({
      floating: true,
      panel: true,
      degraded: false,
      reason: "user-both",
    });
  });

  it("falls back to the panel on wlroots Wayland in floating mode", () => {
    expect(resolveIndicatorSurface("floating", WLROOTS)).toEqual({
      floating: false,
      panel: true,
      degraded: false,
      reason: "wayland-panel-fallback",
    });
  });

  it("falls back to the panel on wlroots Wayland in both mode", () => {
    expect(resolveIndicatorSurface("both", WLROOTS)).toEqual({
      floating: false,
      panel: true,
      degraded: false,
      reason: "wayland-panel-fallback",
    });
  });

  it("honors panel mode on wlroots Wayland", () => {
    expect(resolveIndicatorSurface("panel", WLROOTS)).toEqual({
      floating: false,
      panel: true,
      degraded: false,
      reason: "user-panel",
    });
  });

  it("degrades on GNOME Wayland in floating mode", () => {
    expect(resolveIndicatorSurface("floating", GNOME_WAYLAND)).toEqual({
      floating: true,
      panel: true,
      degraded: true,
      reason: "gnome-wayland-degraded",
    });
  });

  it("degrades on GNOME Wayland in both mode", () => {
    expect(resolveIndicatorSurface("both", GNOME_WAYLAND)).toEqual({
      floating: true,
      panel: true,
      degraded: true,
      reason: "gnome-wayland-degraded",
    });
  });

  it("honors panel mode on GNOME Wayland", () => {
    expect(resolveIndicatorSurface("panel", GNOME_WAYLAND)).toEqual({
      floating: false,
      panel: true,
      degraded: false,
      reason: "user-panel",
    });
  });

  it("keeps floating on macOS in floating mode", () => {
    expect(resolveIndicatorSurface("floating", MACOS)).toEqual({
      floating: true,
      panel: false,
      degraded: false,
      reason: "default",
    });
  });

  it("keeps floating when env is unknown in floating mode", () => {
    expect(resolveIndicatorSurface("floating", null)).toEqual({
      floating: true,
      panel: false,
      degraded: false,
      reason: "default",
    });
  });

  it("always returns panel-only for panel mode regardless of env", () => {
    for (const env of [null, X11, WLROOTS, GNOME_WAYLAND, MACOS]) {
      expect(resolveIndicatorSurface("panel", env)).toEqual({
        floating: false,
        panel: true,
        degraded: false,
        reason: "user-panel",
      });
    }
  });
});
