// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Dialog } from "./Dialog";

afterEach(() => {
  cleanup();
});

function CloseHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Restore focus">
        <button type="button">Inside</button>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("renders an accessible dialog with title and content when open", () => {
    render(
      <Dialog open onClose={() => {}} title="Delete note" description="This cannot be undone">
        <p>Body content</p>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByText("Delete note")).toBeTruthy();
    expect(screen.getByText("This cannot be undone")).toBeTruthy();
    expect(screen.getByText("Body content")).toBeTruthy();
  });

  it("renders nothing while closed", () => {
    render(
      <Dialog open={false} onClose={() => {}} title="Hidden">
        <p>Never shown</p>
      </Dialog>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Hidden")).toBeNull();
  });

  it("calls onClose once when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Press escape" />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps focus when onClose identity changes while open", () => {
    const { rerender } = render(
      <Dialog open onClose={() => {}} title="Focus">
        <button type="button">First</button>
        <button type="button">Second</button>
      </Dialog>,
    );

    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });
    expect(document.activeElement).toBe(first);

    second.focus();
    expect(document.activeElement).toBe(second);

    rerender(
      <Dialog open onClose={() => {}} title="Focus">
        <button type="button">First</button>
        <button type="button">Second</button>
      </Dialog>,
    );

    expect(document.activeElement).toBe(second);
  });

  it("restores focus to the previously focused element on close", () => {
    render(<CloseHarness />);

    const trigger = screen.getByRole("button", { name: "Open dialog" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
