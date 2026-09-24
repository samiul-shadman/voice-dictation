// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import KeyInput from "./KeyInput";

afterEach(() => {
  cleanup();
});

function beginCapture(label: string): HTMLElement {
  const trigger = screen.getByRole("button", { name: label });
  fireEvent.click(trigger);
  return trigger;
}

describe("KeyInput", () => {
  it("commits the canonical combo captured from the keyboard", () => {
    const onChange = vi.fn();
    render(<KeyInput value={null} onChange={onChange} action="voiceNote" />);

    beginCapture("Voice note hotkey");
    fireEvent.keyDown(document.body, {
      key: " ",
      code: "Space",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("ctrl+shift+space");
  });

  it("normalizes the captured combo regardless of modifier order", () => {
    const onChange = vi.fn();
    render(<KeyInput value={null} onChange={onChange} action="record" />);

    beginCapture("Record hotkey");
    fireEvent.keyDown(document.body, {
      key: "a",
      code: "KeyA",
      shiftKey: true,
      ctrlKey: true,
    });

    expect(onChange).toHaveBeenCalledWith("ctrl+shift+a");
  });

  it("cancels capture on Escape without committing a binding", () => {
    const onChange = vi.fn();
    render(<KeyInput value={null} onChange={onChange} action="voiceNote" />);

    beginCapture("Voice note hotkey");
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops listening after unmount", () => {
    const onChange = vi.fn();
    const { unmount } = render(<KeyInput value={null} onChange={onChange} action="voiceNote" />);

    beginCapture("Voice note hotkey");
    unmount();

    expect(() =>
      fireEvent.keyDown(document.body, {
        key: " ",
        code: "Space",
        ctrlKey: true,
        shiftKey: true,
      }),
    ).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});
