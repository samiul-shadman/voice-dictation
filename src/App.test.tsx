// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";

const mockState = vi.hoisted(() => ({ startupNotice: null as string | null }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_startup_notice") return mockState.startupNotice;
    return undefined;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

interface Loaded {
  OutcomeToasts: (props: Record<string, never>) => ReactElement | null;
  ToastViewport: () => ReactElement | null;
}

// `resetModules` gives App its own copy of the toast store, so the viewport has to
// come from that same instance or it would watch a different module's state.
async function loadApp(): Promise<Loaded> {
  vi.resetModules();
  const app = await import("./App");
  const ui = await import("./components/ui");
  await flush();
  return { OutcomeToasts: app.OutcomeToasts as never, ToastViewport: ui.ToastViewport };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function renderToasts({ OutcomeToasts, ToastViewport }: Loaded): void {
  render(
    <MemoryRouter>
      <OutcomeToasts {...({} as Record<string, never>)} />
      <ToastViewport />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockState.startupNotice = null;
  vi.clearAllMocks();
});

afterEach(() => {
  for (const button of screen.queryAllByRole("button", { name: "Dismiss notification" })) {
    fireEvent.click(button);
  }
  cleanup();
  vi.useRealTimers();
});

describe("startup notice", () => {
  it("shows nothing when this launch inherited no crash marker", async () => {
    const loaded = await loadApp();
    renderToasts(loaded);
    await flush();
    expect(screen.queryByText(/preloading was disabled/)).toBeNull();
  });

  it("raises an actionable toast when a prewarm crashed last launch", async () => {
    mockState.startupNotice =
      "The model failed to load last time, so preloading was disabled. Transcriptions may fail.";
    const loaded = await loadApp();
    renderToasts(loaded);
    await flush();
    expect(screen.getByText(/preloading was disabled/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-download" })).toBeTruthy();
  });

  it("keeps the notice up past the default auto-dismiss window", async () => {
    vi.useFakeTimers();
    mockState.startupNotice = "The model failed to load last time, so preloading was disabled.";
    const loaded = await loadApp();
    renderToasts(loaded);
    await flush();
    expect(screen.getByText(/preloading was disabled/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    // An error toast with an action gets no timer, so the user cannot miss the fact
    // that the model still needs re-downloading.
    expect(screen.getByText(/preloading was disabled/)).toBeTruthy();
  });

  it("dismisses on request", async () => {
    mockState.startupNotice = "The model failed to load last time, so preloading was disabled.";
    const loaded = await loadApp();
    renderToasts(loaded);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText(/preloading was disabled/)).toBeNull();
  });
});
