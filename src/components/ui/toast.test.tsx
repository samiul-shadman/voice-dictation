// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToastViewport, toast } from "./toast";

afterEach(() => {
  for (const button of screen.queryAllByRole("button", { name: "Dismiss notification" })) {
    fireEvent.click(button);
  }
  cleanup();
  vi.useRealTimers();
});

describe("ToastViewport", () => {
  it("renders a toast message pushed through toast()", () => {
    render(<ToastViewport />);

    act(() => {
      toast("error", "boom");
    });

    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("removes a toast when its dismiss control is clicked", () => {
    render(<ToastViewport />);

    act(() => {
      toast("success", "saved");
    });
    expect(screen.getByText("saved")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));

    expect(screen.queryByText("saved")).toBeNull();
  });

  it("auto-dismisses a toast after its default duration", () => {
    vi.useFakeTimers();
    render(<ToastViewport />);

    act(() => {
      toast("info", "ephemeral");
    });
    expect(screen.getByText("ephemeral")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(screen.queryByText("ephemeral")).toBeNull();
  });

  it("honors a custom duration", () => {
    vi.useFakeTimers();
    render(<ToastViewport />);

    act(() => {
      toast("info", "brief", { durationMs: 1000 });
    });

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.getByText("brief")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("brief")).toBeNull();
  });
});
