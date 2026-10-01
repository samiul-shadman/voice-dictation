// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ensureInit } from "../../lib/stores/transcriber";
import TranscriptPanel from "./TranscriptPanel";

const PATH = "/tmp/voice-dictation/recordings/note.mp3";

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
  invoke: vi.fn(async (command: string) => {
    if (command === "get_transcript") {
      return {
        audioPath: "/tmp/voice-dictation/recordings/note.mp3",
        text: "hello there",
        modelId: "parakeet-tdt-0.6b-v2",
        durationMs: 4000,
        createdAt: Date.now(),
      };
    }
    if (command === "recording_state") return { recording: false, stopping: false };
    return undefined;
  }),
}));

function emit(event: string, payload: unknown): void {
  const handler = mockState.handlers.get(event);
  if (!handler) throw new Error(`no listener registered for ${event}`);
  act(() => {
    handler({ payload });
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(async () => {
  ensureInit();
  await flush();
  await act(async () => {
    render(<TranscriptPanel path={PATH} />);
    await flush();
  });
});

afterEach(() => {
  emit("transcribe-complete", { path: PATH, text: "hello there" });
  cleanup();
});

describe("TranscriptPanel progress label", () => {
  it("shows Loading model… while the model is being loaded", () => {
    emit("transcribe-progress", { path: PATH, percent: 0, phase: "loading" });

    expect(screen.getByRole("button", { name: "Loading model…" })).toBeTruthy();
    expect(screen.queryByText(/Transcribing \d+%/)).toBeNull();
  });

  it("shows the percentage once transcription begins", () => {
    emit("transcribe-progress", { path: PATH, percent: 0, phase: "loading" });
    emit("transcribe-progress", { path: PATH, percent: 42, phase: "transcribing" });

    expect(screen.getByRole("button", { name: "Transcribing 42%" })).toBeTruthy();
    expect(screen.queryByText("Loading model…")).toBeNull();
  });

  it("treats a phase-less progress event as transcribing", () => {
    emit("transcribe-progress", { path: PATH, percent: 7 });

    expect(screen.getByRole("button", { name: "Transcribing 7%" })).toBeTruthy();
  });

  it("offers Re-transcribe when no transcription is running", () => {
    expect(screen.getByRole("button", { name: "Re-transcribe" })).toBeTruthy();
  });
});