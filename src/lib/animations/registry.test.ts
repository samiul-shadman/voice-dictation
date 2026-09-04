import { describe, expect, it } from "vitest";
import {
  getRecordingStyle,
  getTranscriptionStyle,
  recordingStyles,
  transcriptionStyles,
} from "./registry";

describe("animations registry", () => {
  it("falls back to classic for unknown ids", () => {
    expect(getRecordingStyle("does-not-exist").id).toBe("classic");
    expect(getRecordingStyle("").id).toBe("classic");
    expect(getTranscriptionStyle("does-not-exist").id).toBe("classic");
  });

  it("lists 10 unique recording styles", () => {
    expect(recordingStyles).toHaveLength(10);
    expect(new Set(recordingStyles.map((s) => s.id)).size).toBe(10);
  });

  it("lists 10 unique transcription styles", () => {
    expect(transcriptionStyles).toHaveLength(10);
    expect(new Set(transcriptionStyles.map((s) => s.id)).size).toBe(10);
  });

  it("renders every recording style without throwing", () => {
    for (const style of recordingStyles) {
      expect(style.render({ elapsed: 42.5, level: 0.6 })).toBeTruthy();
    }
  });

  it("renders every transcription style without throwing", () => {
    for (const style of transcriptionStyles) {
      expect(style.render({ percent: 37.5 })).toBeTruthy();
    }
  });

  it("handles out-of-range percent without throwing", () => {
    for (const style of transcriptionStyles) {
      expect(style.render({ percent: -20 })).toBeTruthy();
      expect(style.render({ percent: 250 })).toBeTruthy();
    }
  });
});
