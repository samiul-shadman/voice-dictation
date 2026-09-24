import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getRecordingStyle,
  getTranscriptionStyle,
  recordingStyles,
  transcriptionStyles,
} from "./registry";

const stripSsrComments = (html: string): string => html.replace(/<!--\s*-->/g, "");

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

  it("renders every recording style to non-empty markup", () => {
    for (const style of recordingStyles) {
      const html = renderToStaticMarkup(style.render({ elapsed: 42.5, level: 0.6 }));
      expect(typeof html).toBe("string");
      expect(html.length).toBeGreaterThan(0);
    }
  });

  it("renders every transcription style to non-empty markup", () => {
    for (const style of transcriptionStyles) {
      const html = renderToStaticMarkup(style.render({ percent: 37.5 }));
      expect(typeof html).toBe("string");
      expect(html.length).toBeGreaterThan(0);
    }
  });

  it("clamps out-of-range percent to valid markup without NaN or Infinity", () => {
    for (const style of transcriptionStyles) {
      const low = stripSsrComments(
        renderToStaticMarkup(style.render({ percent: -20 })),
      );
      expect(low.length).toBeGreaterThan(0);
      expect(low).not.toMatch(/NaN|Infinity/);
      expect(low).toContain("0%");

      const high = stripSsrComments(
        renderToStaticMarkup(style.render({ percent: 250 })),
      );
      expect(high.length).toBeGreaterThan(0);
      expect(high).not.toMatch(/NaN|Infinity/);
      expect(high).toContain("100%");
    }
  });
});
