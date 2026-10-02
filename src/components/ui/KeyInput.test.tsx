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

  it("clears the binding and leaves capture mode on Backspace", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <KeyInput value="ctrl+shift+space" onChange={onChange} action="voiceNote" />,
    );

    beginCapture("Voice note hotkey");
    const field = screen.getByRole("button", { name: "Voice note hotkey" });
    expect(field.textContent).toContain("Press keys");

    fireEvent.keyDown(document.body, { key: "Backspace", code: "Backspace" });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
    expect(field.textContent).not.toContain("Press keys");

    rerender(<KeyInput value={null} onChange={onChange} action="voiceNote" />);
    expect(field.textContent).toContain("Click to record a hotkey");
  });

  it("stops listening after a clear so a later combo is not captured", () => {
    const onChange = vi.fn();
    render(<KeyInput value="ctrl+shift+space" onChange={onChange} action="voiceNote" />);

    beginCapture("Voice note hotkey");
    fireEvent.keyDown(document.body, { key: "Backspace", code: "Backspace" });
    fireEvent.keyDown(document.body, {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
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
