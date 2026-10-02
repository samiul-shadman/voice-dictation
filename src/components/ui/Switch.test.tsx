// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Switch } from "./Switch";

afterEach(() => {
  cleanup();
});

function control(): HTMLElement {
  return screen.getByRole("switch", { name: "Global shortcuts" });
}

describe("Switch", () => {
  it("reports its state and asks for the inverse on click", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Switch label="Global shortcuts" checked={false} onChange={onChange} />,
    );

    expect(control().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(control());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<Switch label="Global shortcuts" checked onChange={onChange} />);
    expect(control().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(control());
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("ignores clicks while a write is in flight so the value cannot flip twice", () => {
    const onChange = vi.fn();
    render(<Switch label="Global shortcuts" checked={false} busy onChange={onChange} />);

    expect(control().getAttribute("aria-busy")).toBe("true");
    fireEvent.click(control());

    expect(onChange).not.toHaveBeenCalled();
  });

  it("accepts clicks again once the write settles", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Switch label="Global shortcuts" checked={false} busy onChange={onChange} />,
    );

    rerender(<Switch label="Global shortcuts" checked busy={false} onChange={onChange} />);
    expect(control().hasAttribute("aria-busy")).toBe(false);
    fireEvent.click(control());

    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("stays disabled without announcing busy when it is inert", () => {
    const onChange = vi.fn();
    render(<Switch label="Global shortcuts" checked={false} disabled onChange={onChange} />);

    expect((control() as HTMLButtonElement).disabled).toBe(true);
    expect(control().hasAttribute("aria-busy")).toBe(false);
    fireEvent.click(control());

    expect(onChange).not.toHaveBeenCalled();
  });

  it("positions the knob with translate utilities, never an inline transform", () => {
    render(<Switch label="Global shortcuts" checked onChange={vi.fn()} />);

    const knob = control().firstElementChild as HTMLElement;
    expect(knob.style.transform).toBe("");
    expect(knob.style.translate).toBe("");
    expect(knob.className).toContain("-translate-y-1/2");
    expect(knob.className).toContain("translate-x-[14px]");
  });
});