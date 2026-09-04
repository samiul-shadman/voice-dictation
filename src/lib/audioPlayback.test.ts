import { describe, expect, it, vi } from "vitest";
import {
  claimExclusivePlayback,
  pausePath,
  unregisterPlayback,
} from "./audioPlayback";
import type { AudioElementLike } from "./audioPlayback";

function fakeElement(paused: boolean) {
  return { pause: vi.fn(), paused } satisfies AudioElementLike;
}

describe("exclusive playback registry", () => {
  it("pauses every other registered playing element on claim", () => {
    const first = fakeElement(false);
    const second = fakeElement(false);

    claimExclusivePlayback(first, "/a.mp3");
    claimExclusivePlayback(second, "/b.mp3");

    expect(first.pause).toHaveBeenCalledTimes(1);
    expect(second.pause).not.toHaveBeenCalled();
  });

  it("ignores already-paused elements when claiming", () => {
    const pausedEl = fakeElement(true);
    const fresh = fakeElement(false);

    claimExclusivePlayback(pausedEl, "/a.mp3");
    claimExclusivePlayback(fresh, "/b.mp3");

    expect(pausedEl.pause).not.toHaveBeenCalled();
  });

  it("unregister removes an element so later claims ignore it", () => {
    const first = fakeElement(false);
    const second = fakeElement(false);

    claimExclusivePlayback(first, "/a.mp3");
    unregisterPlayback(first);
    claimExclusivePlayback(second, "/b.mp3");

    expect(first.pause).not.toHaveBeenCalled();
    expect(second.pause).not.toHaveBeenCalled();
  });

  it("pausePath pauses only the element registered for that path", () => {
    const a = fakeElement(false);
    const b = fakeElement(false);

    claimExclusivePlayback(a, "/a.mp3");
    claimExclusivePlayback(b, "/b.mp3");

    expect(pausePath("/b.mp3")).toBe(true);
    expect(b.pause).toHaveBeenCalledTimes(1);
    expect(pausePath("/missing.mp3")).toBe(false);
  });
});
