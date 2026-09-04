import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HARD_TIMEOUT_MS,
  MIN_HOLD_MS,
  activeHoldKind,
  beginHold,
  endHold,
  setHoldActions,
} from "./hold";
import type { HoldActions } from "./hold";

function makeActions(): HoldActions {
  return {
    start: vi.fn(),
    cancel: vi.fn(),
    finish: vi.fn(),
  };
}

let voiceActions: HoldActions;
let recordActions: HoldActions;

describe("hold state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    voiceActions = makeActions();
    recordActions = makeActions();
    setHoldActions("voice-note", voiceActions);
    setHoldActions("record", recordActions);
  });

  afterEach(() => {
    endHold("voice-note");
    endHold("record");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("cancels taps shorter than 300 ms", () => {
    beginHold("voice-note");
    expect(voiceActions.start).toHaveBeenCalledTimes(1);
    expect(activeHoldKind()).toBe("voice-note");
    vi.advanceTimersByTime(MIN_HOLD_MS - 1);
    endHold("voice-note");
    expect(voiceActions.cancel).toHaveBeenCalledTimes(1);
    expect(voiceActions.finish).not.toHaveBeenCalled();
    expect(activeHoldKind()).toBeNull();
  });

  it("finishes holds of 300 ms or longer", () => {
    beginHold("record");
    vi.advanceTimersByTime(MIN_HOLD_MS);
    endHold("record");
    expect(recordActions.finish).toHaveBeenCalledTimes(1);
    expect(recordActions.cancel).not.toHaveBeenCalled();
  });

  it("force-finishes when the keyup is lost after 120 s", () => {
    beginHold("voice-note");
    vi.advanceTimersByTime(HARD_TIMEOUT_MS);
    expect(voiceActions.finish).toHaveBeenCalledTimes(1);
    expect(voiceActions.cancel).not.toHaveBeenCalled();
    expect(activeHoldKind()).toBeNull();
  });

  it("finishes on window blur", () => {
    beginHold("voice-note");
    vi.advanceTimersByTime(1000);
    window.dispatchEvent(new Event("blur"));
    expect(voiceActions.finish).toHaveBeenCalledTimes(1);
    expect(voiceActions.cancel).not.toHaveBeenCalled();
    expect(activeHoldKind()).toBeNull();
  });

  it("ignores a second hold while one is active and mismatched ends", () => {
    beginHold("voice-note");
    beginHold("record");
    expect(recordActions.start).not.toHaveBeenCalled();
    endHold("record");
    expect(voiceActions.cancel).not.toHaveBeenCalled();
    expect(voiceActions.finish).not.toHaveBeenCalled();
    expect(activeHoldKind()).toBe("voice-note");
    endHold("voice-note");
    expect(voiceActions.cancel).toHaveBeenCalledTimes(1);
    expect(activeHoldKind()).toBeNull();
  });

  it("does not re-fail-safe after a normal end", () => {
    beginHold("voice-note");
    vi.advanceTimersByTime(400);
    endHold("voice-note");
    expect(voiceActions.finish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HARD_TIMEOUT_MS);
    expect(voiceActions.finish).toHaveBeenCalledTimes(1);
    expect(voiceActions.cancel).not.toHaveBeenCalled();
    expect(activeHoldKind()).toBeNull();
  });
});
