import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriberState } from "./transcriber";

interface ProgressPayload {
  path: string;
  percent: number;
  phase?: string;
}

const mockState = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mockState.handlers.set(name, handler);
    return () => {};
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

async function loadStore(): Promise<typeof import("./transcriber")> {
  vi.resetModules();
  mockState.handlers.clear();
  const store = await import("./transcriber");
  store.ensureInit();
  await flush();
  return store;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function emit(event: string, payload: unknown): void {
  const handler = mockState.handlers.get(event);
  if (!handler) throw new Error(`no listener registered for ${event}`);
  handler({ payload });
}

function emitProgress(payload: ProgressPayload): void {
  emit("transcribe-progress", payload);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("transcriber progress phase", () => {
  it("starts idle in the transcribing phase", async () => {
    const store = await loadStore();
    expect(store.getTranscriberState()).toEqual({
      busy: false,
      activePath: null,
      percent: 0,
      phase: "transcribing",
    });
  });

  it("stores the loading phase reported by the backend", async () => {
    const store = await loadStore();

    emitProgress({ path: "/a.mp3", percent: 0, phase: "loading" });

    expect(store.getTranscriberState()).toEqual({
      busy: true,
      activePath: "/a.mp3",
      percent: 0,
      phase: "loading",
    });
  });

  it("defaults to transcribing when the event carries no phase", async () => {
    const store = await loadStore();

    emitProgress({ path: "/a.mp3", percent: 12 });

    expect(store.getTranscriberState()).toEqual({
      busy: true,
      activePath: "/a.mp3",
      percent: 12,
      phase: "transcribing",
    });
  });

  it("falls back to transcribing for an unknown phase value", async () => {
    const store = await loadStore();

    emitProgress({ path: "/a.mp3", percent: 0, phase: "warming-up" });

    expect(store.getTranscriberState().phase).toBe("transcribing");
  });

  it("moves from loading to transcribing once inference starts", async () => {
    const store = await loadStore();

    emitProgress({ path: "/a.mp3", percent: 0, phase: "loading" });
    emitProgress({ path: "/a.mp3", percent: 40, phase: "transcribing" });

    expect(store.getTranscriberState()).toEqual({
      busy: true,
      activePath: "/a.mp3",
      percent: 40,
      phase: "transcribing",
    });
  });

  it("drops a phase-less event from another path while busy", async () => {
    const store = await loadStore();

    emitProgress({ path: "/a.mp3", percent: 0, phase: "loading" });
    emitProgress({ path: "/b.mp3", percent: 90, phase: "transcribing" });

    expect(store.getTranscriberState()).toEqual({
      busy: true,
      activePath: "/a.mp3",
      percent: 0,
      phase: "loading",
    });
  });

  it("resets the phase when the transcription completes", async () => {
    const store = await loadStore();

    emitProgress({ path: "/a.mp3", percent: 0, phase: "loading" });
    emit("transcribe-complete", { path: "/a.mp3", text: "hello" });

    const state: TranscriberState = store.getTranscriberState();
    expect(state).toEqual({ busy: false, activePath: null, percent: 0, phase: "transcribing" });
  });

  it("resets the phase when the transcription fails", async () => {
    const store = await loadStore();

    emitProgress({ path: "/a.mp3", percent: 0, phase: "loading" });
    emit("transcribe-error", { path: "/a.mp3", message: "boom" });

    expect(store.getTranscriberState().phase).toBe("transcribing");
  });
});