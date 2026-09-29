import { describe, expect, it } from "vitest";
import { isMissingModelError } from "./models";

describe("isMissingModelError", () => {
  it("matches the backend no-model message", () => {
    expect(isMissingModelError("no model downloaded — pick one on the Models page")).toBe(true);
  });

  it("ignores unrelated transcription failures", () => {
    expect(isMissingModelError("a transcription is already in progress")).toBe(false);
    expect(isMissingModelError("could not decode the audio file")).toBe(false);
  });
});
