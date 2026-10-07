// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Select } from "./Select";

afterEach(() => {
  cleanup();
});

const OPTIONS = [
  { value: "", label: "System default" },
  { value: "alsa:pulse", label: "Webcam — alsa:pulse" },
  { value: "alsa:hw:CARD=PCH,DEV=0", label: "Built-in — alsa:hw:CARD=PCH,DEV=0" },
] as const;

function control(): HTMLSelectElement {
  return screen.getByLabelText("Microphone") as HTMLSelectElement;
}

describe("Select", () => {
  it("renders every option and marks the current value as selected", () => {
    render(<Select options={OPTIONS} value="alsa:pulse" onChange={vi.fn()} ariaLabel="Microphone" />);

    const select = control();
    expect(select.options).toHaveLength(3);
    expect(select.value).toBe("alsa:pulse");
    expect(select.getAttribute("aria-label")).toBe("Microphone");
  });

  it("reports the chosen option value on change", () => {
    const onChange = vi.fn();
    render(
      <Select options={OPTIONS} value="" onChange={onChange} ariaLabel="Microphone" />,
    );

    fireEvent.change(control(), { target: { value: "alsa:hw:CARD=PCH,DEV=0" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("alsa:hw:CARD=PCH,DEV=0");
  });

  it("stays disabled and inert while a write is in flight", () => {
    const onChange = vi.fn();
    render(
      <Select options={OPTIONS} value="" onChange={onChange} ariaLabel="Microphone" disabled />,
    );

    expect(control().disabled).toBe(true);
    fireEvent.change(control(), { target: { value: "alsa:pulse" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("falls back to the placeholder when the value is null", () => {
    render(
      <Select
        options={OPTIONS}
        value={null}
        onChange={vi.fn()}
        ariaLabel="Microphone"
        placeholder="Choose a microphone"
      />,
    );

    expect(control().value).toBe("");
    expect(screen.getByRole("option", { name: "Choose a microphone" })).toBeTruthy();
  });

  it("surfaces a stored value that is missing from the list instead of faking a selection", () => {
    render(
      <Select
        options={OPTIONS}
        value="alsa:hw:CARD=Unplugged,DEV=0"
        onChange={vi.fn()}
        ariaLabel="Microphone"
      />,
    );

    const select = control();
    expect(select.value).toBe("");
    expect(select.className).toContain("border-warn/60");
    expect(screen.queryByRole("option", { name: /Unplugged/ })).toBeNull();
  });

  it("keeps a stored value visible while the list is still loading", () => {
    render(
      <Select
        options={[]}
        value="alsa:pulse"
        onChange={vi.fn()}
        ariaLabel="Microphone"
        placeholder="Loading…"
      />,
    );

    expect(control().value).toBe("");
    expect(screen.getByRole("option", { name: "Loading…" })).toBeTruthy();
  });

  it("positions the chevron with a translate utility, never an inline transform", () => {
    const { container } = render(
      <Select options={OPTIONS} value="" onChange={vi.fn()} ariaLabel="Microphone" />,
    );

    const chevron = container.querySelector("svg") as SVGElement;
    expect(chevron.style.transform).toBe("");
    expect(chevron.style.translate).toBe("");
    expect(chevron.getAttribute("class")).toContain("-translate-y-1/2");
  });
});