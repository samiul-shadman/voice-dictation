import { describe, expect, it } from "vitest";
import { conflictMessage, resolveShortcutView } from "./viewState";
import type { ShortcutConfigs, ShortcutViewConfig } from "./viewState";

function cfg(over: Partial<ShortcutViewConfig> = {}): ShortcutViewConfig {
  return { combo: null, trigger: "hold", enabled: true, ...over };
}

function configs(over: Partial<ShortcutConfigs> = {}): ShortcutConfigs {
  return { voiceNote: cfg(), record: cfg(), ...over };
}

describe("conflictMessage", () => {
  it("flags a combo already held by the other enabled action", () => {
    const state = configs({ record: cfg({ combo: "ctrl+shift+space" }) });
    expect(conflictMessage("voiceNote", "ctrl+shift+space", state, true)).toBe(
      "Already used by Record",
    );
  });

  it("matches regardless of the vocabulary the combo was typed in", () => {
    const state = configs({ record: cfg({ combo: "ctrl+shift+a" }) });
    expect(conflictMessage("voiceNote", "Ctrl+Shift+KeyA", state, true)).toBe(
      "Already used by Record",
    );
  });

  it("allows a combo held by a disabled action, which the engine never registers", () => {
    const state = configs({ record: cfg({ combo: "ctrl+shift+space", enabled: false }) });
    expect(conflictMessage("voiceNote", "ctrl+shift+space", state, true)).toBeNull();
  });

  it("allows any combo while the master switch is off", () => {
    const state = configs({ record: cfg({ combo: "ctrl+shift+space" }) });
    expect(conflictMessage("voiceNote", "ctrl+shift+space", state, false)).toBeNull();
  });

  it("ignores an unset combo on the other action", () => {
    expect(conflictMessage("voiceNote", "ctrl+shift+space", configs(), true)).toBeNull();
  });

  it("allows an action to keep the combo it already owns", () => {
    const state = configs({ voiceNote: cfg({ combo: "ctrl+shift+space" }) });
    expect(conflictMessage("voiceNote", "ctrl+shift+space", state, true)).toBeNull();
  });

  it("treats an empty or modifier-only combo as no combo", () => {
    const state = configs({ record: cfg({ combo: "ctrl" }) });
    expect(conflictMessage("voiceNote", "", state, true)).toBeNull();
    expect(conflictMessage("voiceNote", "ctrl+shift", state, true)).toBeNull();
  });

  it("drops the conflict once the other action gives the combo up", () => {
    const taken = configs({ record: cfg({ combo: "ctrl+shift+space" }) });
    expect(conflictMessage("voiceNote", "ctrl+shift+space", taken, true)).not.toBeNull();
    const freed = configs({ record: cfg({ combo: null }) });
    expect(conflictMessage("voiceNote", "ctrl+shift+space", freed, true)).toBeNull();
  });
});

describe("resolveShortcutView", () => {
  it("returns the stored config when there is no pending patch", () => {
    const stored = cfg({ combo: "ctrl+shift+space" });
    expect(resolveShortcutView(stored, undefined)).toBe(stored);
  });

  it("layers a pending patch over the stored config", () => {
    const stored = cfg({ combo: "ctrl+shift+space", trigger: "hold", enabled: true });
    expect(resolveShortcutView(stored, { combo: "ctrl+alt+k" })).toEqual({
      combo: "ctrl+alt+k",
      trigger: "hold",
      enabled: true,
    });
  });

  it("lets a pending null combo represent a cleared binding", () => {
    const stored = cfg({ combo: "ctrl+shift+space" });
    expect(resolveShortcutView(stored, { combo: null }).combo).toBeNull();
  });

  it("keeps a second toggle computing from the pending value, not the stale one", () => {
    const stored = cfg({ enabled: true });
    const afterFirst = resolveShortcutView(stored, { enabled: false });
    expect(afterFirst.enabled).toBe(false);
    const afterSecond = resolveShortcutView(afterFirst, { enabled: true });
    expect(afterSecond.enabled).toBe(true);
  });
});