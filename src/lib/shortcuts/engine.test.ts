import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitTo } from "@tauri-apps/api/event";
import { cancelRecording, startRecording, stopRecording } from "../stores/recorder";
import { endVoiceNoteHold, startVoiceNoteHold, toggleVoiceNote } from "../voiceNote";
import type { Settings } from "../stores/settings";
import {
  getArmed,
  getShortcutStatus,
  initShortcutEngine,
  resetShortcutEngineForTests,
  syncGlobalShortcuts,
} from "./engine";

interface FakeShortcutEvent {
  state: "Pressed" | "Released";
  shortcut: string;
  id?: number;
  repeat?: boolean;
}

const mockState = vi.hoisted(() => {
  return {
    label: "main",
    failing: new Set<string>(),
    handlers: new Map<string, (event: FakeShortcutEvent) => void>(),
    settings: null as unknown,
  };
});

vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: vi.fn(async (shortcuts: string | string[], handler: (event: FakeShortcutEvent) => void) => {
    for (const shortcut of Array.isArray(shortcuts) ? shortcuts : [shortcuts]) {
      if (mockState.failing.has(shortcut)) {
        throw new Error(`failed to register: ${shortcut} is already registered by another application`);
      }
      mockState.handlers.set(shortcut, handler);
    }
  }),
  unregister: vi.fn(async (shortcuts: string | string[]) => {
    for (const shortcut of Array.isArray(shortcuts) ? shortcuts : [shortcuts]) {
      mockState.handlers.delete(shortcut);
    }
  }),
  isRegistered: vi.fn(async (shortcut: string) => mockState.handlers.has(shortcut)),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: mockState.label }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "get_settings") return mockState.settings;
    throw new Error(`unexpected command: ${command}`);
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("../voiceNote", () => ({
  startVoiceNoteHold: vi.fn(async () => {}),
  endVoiceNoteHold: vi.fn(async () => {}),
  toggleVoiceNote: vi.fn(async () => {}),
}));

vi.mock("../stores/recorder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stores/recorder")>();
  return {
    ...actual,
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => null),
    cancelRecording: vi.fn(async () => {}),
  };
});

function settingsWith(opts?: {
  master?: boolean;
  voiceNote?: Partial<{ combo: string | null; trigger: "hold" | "toggle"; enabled: boolean }>;
  record?: Partial<{ combo: string | null; trigger: "hold" | "toggle"; enabled: boolean }>;
}): Settings {
  return {
    globalShortcutsEnabled: opts?.master ?? true,
    shortcuts: {
      voiceNote: {
        combo: "ctrl+shift+space",
        trigger: "hold",
        enabled: true,
        ...opts?.voiceNote,
      },
      record: {
        combo: "ctrl+alt+r",
        trigger: "toggle",
        enabled: true,
        ...opts?.record,
      },
    },
    audioDir: "/tmp/voice-dictation/recordings",
    audioFormat: "mp3",
    pasteMode: "auto",
    defaultModel: "",
    modelsDir: null,
    indicatorMode: "floating",
    indicatorRecordingStyle: "classic",
    indicatorTranscriptionStyle: "classic",
  };
}

function fire(accelerator: string, event: Omit<FakeShortcutEvent, "shortcut">): void {
  const handler = mockState.handlers.get(accelerator);
  if (!handler) throw new Error(`no handler registered for ${accelerator}`);
  handler({ shortcut: accelerator, ...event });
}

describe("shortcut engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.handlers.clear();
    mockState.failing.clear();
    mockState.label = "main";
    mockState.settings = settingsWith();
    resetShortcutEngineForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers enabled actions and reports status", async () => {
    initShortcutEngine();
    await syncGlobalShortcuts();
    expect(mockState.handlers.has("Control+Shift+Space")).toBe(true);
    expect(mockState.handlers.has("Control+Alt+KeyR")).toBe(true);
    const status = getShortcutStatus();
    expect(status.registeredCount).toBe(2);
    expect(status.actions.voiceNote.state).toBe("registered");
    expect(status.actions.record.state).toBe("registered");
    expect(status.firstError).toBeUndefined();
  });

  it("does nothing outside the main window", async () => {
    mockState.label = "indicator";
    initShortcutEngine();
    await Promise.resolve();
    expect(mockState.handlers.size).toBe(0);
    expect(getShortcutStatus().registeredCount).toBe(0);
  });

  it("unregisters everything when the master switch is off", async () => {
    initShortcutEngine();
    await syncGlobalShortcuts();
    mockState.settings = settingsWith({ master: false });
    await syncGlobalShortcuts();
    expect(mockState.handlers.size).toBe(0);
    const status = getShortcutStatus();
    expect(status.actions.voiceNote.state).toBe("master-off");
    expect(status.actions.record.state).toBe("master-off");
    expect(status.registeredCount).toBe(0);
  });

  it("surfaces grabbed-hotkey errors per action", async () => {
    mockState.failing.add("Control+Alt+KeyR");
    initShortcutEngine();
    await syncGlobalShortcuts();
    expect(mockState.handlers.has("Control+Shift+Space")).toBe(true);
    expect(mockState.handlers.has("Control+Alt+KeyR")).toBe(false);
    const status = getShortcutStatus();
    expect(status.actions.voiceNote.state).toBe("registered");
    expect(status.actions.record.state).toBe("error");
    expect(status.actions.record.detail).toMatch(/already registered/);
    expect(status.firstError).toMatch(/already registered/);
    expect(status.registeredCount).toBe(1);
  });

  it("reports disabled actions and unregisters them", async () => {
    initShortcutEngine();
    await syncGlobalShortcuts();
    mockState.settings = settingsWith({ record: { enabled: false } });
    await syncGlobalShortcuts();
    expect(mockState.handlers.has("Control+Alt+KeyR")).toBe(false);
    const status = getShortcutStatus();
    expect(status.actions.record.state).toBe("disabled");
    expect(status.registeredCount).toBe(1);
  });

  it("re-syncs when a combo changes", async () => {
    initShortcutEngine();
    await syncGlobalShortcuts();
    expect(mockState.handlers.has("Control+Alt+KeyR")).toBe(true);
    mockState.settings = settingsWith({ record: { combo: "ctrl+shift+f9" } });
    await syncGlobalShortcuts();
    expect(mockState.handlers.has("Control+Alt+KeyR")).toBe(false);
    expect(mockState.handlers.has("Control+Shift+F9")).toBe(true);
    expect(getShortcutStatus().actions.record.state).toBe("registered");
  });

  it("dispatches voice-note hold press/release through the hold machine", async () => {
    initShortcutEngine();
    await syncGlobalShortcuts();
    fire("Control+Shift+Space", { state: "Pressed" });
    expect(startVoiceNoteHold).toHaveBeenCalledTimes(1);
    expect(getArmed()).toEqual({ combo: "ctrl+shift+space", action: "voiceNote", trigger: "hold" });
    expect(emitTo).toHaveBeenCalledWith("indicator", "shortcut-armed", {
      combo: "ctrl+shift+space",
      action: "voiceNote",
      trigger: "hold",
    });

    fire("Control+Shift+Space", { state: "Pressed", repeat: true });
    expect(startVoiceNoteHold).toHaveBeenCalledTimes(1);

    fire("Control+Shift+Space", { state: "Released" });
    expect(endVoiceNoteHold).not.toHaveBeenCalled();
    expect(cancelRecording).toHaveBeenCalledTimes(1);
    expect(getArmed()).toBeNull();
    expect(emitTo).toHaveBeenCalledWith("indicator", "shortcut-disarmed", { combo: "ctrl+shift+space" });
  });

  it("finishes the hold when the tap passes the threshold", async () => {
    vi.useFakeTimers();
    initShortcutEngine();
    await syncGlobalShortcuts();
    fire("Control+Shift+Space", { state: "Pressed" });
    vi.advanceTimersByTime(350);
    fire("Control+Shift+Space", { state: "Released" });
    expect(cancelRecording).not.toHaveBeenCalled();
    expect(endVoiceNoteHold).toHaveBeenCalledTimes(1);
    expect(getArmed()).toBeNull();
  });

  it("dispatches record toggle press/release", async () => {
    initShortcutEngine();
    await syncGlobalShortcuts();
    fire("Control+Alt+KeyR", { state: "Pressed" });
    expect(startRecording).toHaveBeenCalledTimes(1);
    expect(toggleVoiceNote).not.toHaveBeenCalled();
    expect(getArmed()).toEqual({ combo: "ctrl+alt+r", action: "record", trigger: "toggle" });
    fire("Control+Alt+KeyR", { state: "Released" });
    expect(stopRecording).toHaveBeenCalledTimes(1);
    expect(getArmed()).toBeNull();
    expect(emitTo).toHaveBeenCalledWith("indicator", "shortcut-disarmed", { combo: "ctrl+alt+r" });
  });

  it("dispatches voice-note toggle on press only", async () => {
    mockState.settings = settingsWith({ voiceNote: { trigger: "toggle" } });
    initShortcutEngine();
    await syncGlobalShortcuts();
    fire("Control+Shift+Space", { state: "Pressed" });
    expect(toggleVoiceNote).toHaveBeenCalledTimes(1);
    expect(getArmed()).toEqual({ combo: "ctrl+shift+space", action: "voiceNote", trigger: "toggle" });
    fire("Control+Shift+Space", { state: "Released" });
    expect(toggleVoiceNote).toHaveBeenCalledTimes(1);
    expect(startVoiceNoteHold).not.toHaveBeenCalled();
    expect(endVoiceNoteHold).not.toHaveBeenCalled();
    expect(getArmed()).toBeNull();
  });

  it("auto-clears toggle armed state after 1.2 s", async () => {
    vi.useFakeTimers();
    initShortcutEngine();
    await syncGlobalShortcuts();
    fire("Control+Alt+KeyR", { state: "Pressed" });
    expect(getArmed()).not.toBeNull();
    vi.advanceTimersByTime(1200);
    expect(getArmed()).toBeNull();
    const disarmEvents = vi.mocked(emitTo).mock.calls.filter(
      (call) => call[1] === "shortcut-disarmed",
    );
    expect(disarmEvents).toHaveLength(0);
  });
});
