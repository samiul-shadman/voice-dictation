import { describe, expect, it } from "vitest";
import { canonicalCombo, comboFromKeyboardEvent, humanize, toAccelerator } from "./canonical";

function fakeEvent(
  partial: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key" | "code">,
): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...partial,
  } as KeyboardEvent;
}

describe("canonicalCombo", () => {
  it("normalizes plugin vocabulary", () => {
    expect(canonicalCombo("shift+control+KeyA")).toBe("ctrl+shift+a");
    expect(canonicalCombo("Control+Shift+Space")).toBe("ctrl+shift+space");
    expect(canonicalCombo("Super+KeyN")).toBe("meta+n");
    expect(canonicalCombo("Meta+Shift+A")).toBe("shift+meta+a");
    expect(canonicalCombo("Alt+NumpadAdd")).toBe("alt+add");
    expect(canonicalCombo("Control+Digit1")).toBe("ctrl+1");
    expect(canonicalCombo("Control+Minus")).toBe("ctrl+minus");
    expect(canonicalCombo("Shift+PageDown")).toBe("shift+pagedown");
    expect(canonicalCombo("Control+Alt+ArrowUp")).toBe("ctrl+alt+up");
    expect(canonicalCombo("Control+F5")).toBe("ctrl+f5");
    expect(canonicalCombo("NumpadDecimal")).toBe("decimal");
  });

  it("normalizes UI vocabulary", () => {
    expect(canonicalCombo("Ctrl+Shift+A")).toBe("ctrl+shift+a");
    expect(canonicalCombo("Cmd+Q")).toBe("meta+q");
    expect(canonicalCombo("Win+D")).toBe("meta+d");
    expect(canonicalCombo("Option+Left")).toBe("alt+left");
    expect(canonicalCombo("PgUp")).toBe("pageup");
    expect(canonicalCombo("Del")).toBe("delete");
    expect(canonicalCombo("Escape")).toBe("esc");
    expect(canonicalCombo("Return")).toBe("enter");
    expect(canonicalCombo("Ctrl + Shift + A")).toBe("ctrl+shift+a");
  });

  it("orders modifiers ctrl < alt < shift < meta", () => {
    expect(canonicalCombo("Meta+Ctrl+Shift+A")).toBe("ctrl+shift+meta+a");
    expect(canonicalCombo("shift+meta+alt+control+KeyB")).toBe("ctrl+alt+shift+meta+b");
  });

  it("rejects combos without a key", () => {
    expect(canonicalCombo("")).toBe("");
    expect(canonicalCombo("ctrl")).toBe("");
    expect(canonicalCombo("ctrl++")).toBe("");
    expect(canonicalCombo("control+shift+meta")).toBe("");
  });
});

describe("comboFromKeyboardEvent", () => {
  it("builds canonical combos from DOM events", () => {
    expect(
      comboFromKeyboardEvent(fakeEvent({ key: "a", code: "KeyA", ctrlKey: true, shiftKey: true })),
    ).toBe("ctrl+shift+a");
    expect(comboFromKeyboardEvent(fakeEvent({ key: " ", code: "Space" }))).toBe("space");
    expect(comboFromKeyboardEvent(fakeEvent({ key: "1", code: "Digit1", altKey: true }))).toBe("alt+1");
    expect(comboFromKeyboardEvent(fakeEvent({ key: "ArrowUp", code: "ArrowUp" }))).toBe("up");
    expect(comboFromKeyboardEvent(fakeEvent({ key: "8", code: "Numpad8" }))).toBe("8");
    expect(comboFromKeyboardEvent(fakeEvent({ key: "F5", code: "F5" }))).toBe("f5");
    expect(comboFromKeyboardEvent(fakeEvent({ key: "-", code: "Minus", ctrlKey: true }))).toBe("ctrl+-");
    expect(comboFromKeyboardEvent(fakeEvent({ key: "Escape", code: "Escape" }))).toBe("esc");
    expect(comboFromKeyboardEvent(fakeEvent({ key: "Delete", code: "Delete" }))).toBe("delete");
    expect(comboFromKeyboardEvent(fakeEvent({ key: "Home", code: "Home", metaKey: true }))).toBe(
      "meta+home",
    );
  });

  it("returns null for bare modifier keys", () => {
    expect(comboFromKeyboardEvent(fakeEvent({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toBeNull();
    expect(comboFromKeyboardEvent(fakeEvent({ key: "Shift", code: "ShiftRight", shiftKey: true }))).toBeNull();
    expect(comboFromKeyboardEvent(fakeEvent({ key: "Alt", code: "AltLeft", altKey: true }))).toBeNull();
    expect(comboFromKeyboardEvent(fakeEvent({ key: "Meta", code: "MetaLeft", metaKey: true }))).toBeNull();
    expect(comboFromKeyboardEvent(fakeEvent({ key: "CapsLock", code: "CapsLock" }))).toBeNull();
  });
});

describe("toAccelerator", () => {
  it("maps canonical combos to plugin accelerators", () => {
    expect(toAccelerator("ctrl+shift+a")).toBe("Control+Shift+KeyA");
    expect(toAccelerator("meta+shift+a")).toBe("Super+Shift+KeyA");
    expect(toAccelerator("ctrl+alt+space")).toBe("Control+Alt+Space");
    expect(toAccelerator("alt+f5")).toBe("Alt+F5");
    expect(toAccelerator("ctrl+1")).toBe("Control+Digit1");
    expect(toAccelerator("ctrl+-")).toBe("Control+Minus");
    expect(toAccelerator("shift+pagedown")).toBe("Shift+PageDown");
    expect(toAccelerator("alt+add")).toBe("Alt+NumpadAdd");
    expect(toAccelerator("ctrl+alt+up")).toBe("Control+Alt+ArrowUp");
    expect(toAccelerator("meta+n")).toBe("Super+KeyN");
  });

  it("round-trips common accelerators back through canonicalCombo", () => {
    for (const canon of ["ctrl+shift+a", "meta+space", "ctrl+1", "alt+f5", "ctrl+alt+up", "shift+pagedown"]) {
      expect(canonicalCombo(toAccelerator(canon))).toBe(canon);
    }
  });
});

describe("humanize", () => {
  it("renders display form", () => {
    expect(humanize("ctrl+shift+a")).toBe("Ctrl + Shift + A");
    expect(humanize("meta+space")).toBe("Super + Space");
    expect(humanize("alt+up")).toBe("Alt + Up");
    expect(humanize("ctrl+pagedown")).toBe("Ctrl + Page Down");
    expect(humanize("f5")).toBe("F5");
    expect(humanize("esc")).toBe("Esc");
    expect(humanize("1")).toBe("1");
    expect(humanize("")).toBe("");
  });

  it("round-trips through canonicalCombo", () => {
    for (const canon of ["ctrl+shift+space", "meta+n", "alt+f5", "ctrl+alt+up"]) {
      expect(canonicalCombo(humanize(canon))).toBe(canon);
    }
  });
});

describe("platform-aware display", () => {
  it("renders mac glyphs", () => {
    expect(humanize("meta+shift+space", "macos")).toBe("⌘ + ⇧ + Space");
    expect(humanize("ctrl+shift+a", "macos")).toBe("⌃ + ⇧ + A");
  });

  it("renders windows labels", () => {
    expect(humanize("meta+shift+space", "windows")).toBe("Win + Shift + Space");
    expect(humanize("ctrl+shift+a", "windows")).toBe("Ctrl + Shift + A");
  });

  it("round-trips mac glyphs through canonicalCombo", () => {
    for (const canon of ["ctrl+shift+space", "meta+n", "ctrl+alt+up"]) {
      expect(canonicalCombo(humanize(canon, "macos"))).toBe(canon);
    }
  });

  it("maps meta to the platform accelerator", () => {
    expect(toAccelerator("meta+shift+space", "macos")).toBe("Meta+Shift+Space");
    expect(toAccelerator("meta+shift+space", "linux")).toBe("Super+Shift+Space");
    expect(toAccelerator("meta+shift+space", "windows")).toBe("Super+Shift+Space");
  });
});
