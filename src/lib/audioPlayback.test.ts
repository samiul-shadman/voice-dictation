// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLAYBACK_SPEEDS,
  claimExclusivePlayback,
  clampTime,
  forgetAllRecordingUrls,
  forgetRecordingUrl,
  getCachedRecordingBytes,
  loadRecordingUrl,
  nextSpeed,
  pausePath,
  unregisterPlayback,
} from "./audioPlayback";
import type { AudioElementLike } from "./audioPlayback";

const { readRecordingBytesMock } = vi.hoisted(() => ({
  readRecordingBytesMock: vi.fn(),
}));

vi.mock("./audio", () => ({
  readRecordingBytes: readRecordingBytesMock,
}));

let urlCounter = 0;
const createObjectURLMock = vi.fn(() => `blob:mock-${++urlCounter}`);
const revokeObjectURLMock = vi.fn();

URL.createObjectURL = createObjectURLMock as unknown as typeof URL.createObjectURL;
URL.revokeObjectURL = revokeObjectURLMock as unknown as typeof URL.revokeObjectURL;

beforeEach(() => {
  forgetAllRecordingUrls();
  urlCounter = 0;
  createObjectURLMock.mockClear();
  revokeObjectURLMock.mockClear();
  readRecordingBytesMock.mockReset();
  readRecordingBytesMock.mockImplementation(
    async (path: string) => new ArrayBuffer(path.length + 1),
  );
});

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

describe("clampTime", () => {
  it("clamps a seek target into the duration", () => {
    expect(clampTime(90, 60)).toBe(60);
  });

  it("keeps in-range seek targets unchanged", () => {
    expect(clampTime(12.5, 60)).toBe(12.5);
  });

  it("returns zero for negative, NaN or infinite input", () => {
    expect(clampTime(-1, 60)).toBe(0);
    expect(clampTime(Number.NaN, 60)).toBe(0);
    expect(clampTime(Number.POSITIVE_INFINITY, 60)).toBe(0);
  });

  it("returns zero when the duration is unknown or invalid", () => {
    expect(clampTime(5, 0)).toBe(0);
    expect(clampTime(5, Number.NaN)).toBe(0);
  });
});

describe("nextSpeed", () => {
  it("cycles through the playback speeds and wraps around", () => {
    expect(nextSpeed(1)).toBe(1.25);
    expect(nextSpeed(1.25)).toBe(1.5);
    expect(nextSpeed(1.5)).toBe(2);
    expect(nextSpeed(2)).toBe(1);
  });

  it("falls back to the first speed for unknown values", () => {
    expect(nextSpeed(3)).toBe(PLAYBACK_SPEEDS[0]);
  });
});

describe("recording url cache (LRU)", () => {
  async function loadPaths(paths: string[]): Promise<string[]> {
    const urls: string[] = [];
    for (const path of paths) urls.push(await loadRecordingUrl(path));
    return urls;
  }

  it("bounds the cache to 8 entries and revokes the evicted object URLs", async () => {
    const paths = Array.from({ length: 10 }, (_, i) => `/rec-${i}.wav`);
    const urls = await loadPaths(paths);

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(urls[0]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(urls[1]);

    expect(getCachedRecordingBytes(paths[0])).toBeNull();
    expect(getCachedRecordingBytes(paths[1])).toBeNull();
    expect(getCachedRecordingBytes(paths[2])).not.toBeNull();
    expect(getCachedRecordingBytes(paths[9])).not.toBeNull();
  });

  it("evicts the least-recently-used entry after a cache hit promotes it", async () => {
    const paths = ["A", "B", "C", "D", "E", "F", "G", "H"].map((n) => `/rec-${n}.wav`);
    const urls = await loadPaths(paths);

    await loadRecordingUrl(paths[0]);

    expect(URL.createObjectURL).toHaveBeenCalledTimes(8);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    await loadRecordingUrl("/rec-I.wav");

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(urls[1]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(urls[0]);

    expect(getCachedRecordingBytes(paths[0])).not.toBeNull();
    expect(getCachedRecordingBytes(paths[1])).toBeNull();
    expect(getCachedRecordingBytes("/rec-I.wav")).not.toBeNull();
  });

  it("forgetRecordingUrl revokes and removes only the target entry", async () => {
    const [urlA, urlB] = await loadPaths(["/a.mp3", "/b.mp3"]);

    forgetRecordingUrl("/a.mp3");

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(urlA);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(urlB);

    expect(getCachedRecordingBytes("/a.mp3")).toBeNull();
    expect(getCachedRecordingBytes("/b.mp3")).not.toBeNull();

    forgetRecordingUrl("/a.mp3");
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
