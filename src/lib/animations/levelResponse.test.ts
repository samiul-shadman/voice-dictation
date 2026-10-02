import { describe, expect, it } from "vitest";
import { levelToUnit } from "./levelResponse";

describe("levelToUnit", () => {
  it("flattens anything at or below the noise floor", () => {
    expect(levelToUnit(0)).toBe(0);
    expect(levelToUnit(0.1)).toBe(0);
    expect(levelToUnit(0.25)).toBe(0);
  });

  it("reaches 1 only at a full-scale level", () => {
    expect(levelToUnit(1)).toBe(1);
  });

  it("clamps out-of-range input", () => {
    expect(levelToUnit(-1)).toBe(0);
    expect(levelToUnit(5)).toBe(1);
  });

  it("treats non-finite input as silence", () => {
    expect(levelToUnit(Number.NaN)).toBe(0);
    expect(levelToUnit(Number.POSITIVE_INFINITY)).toBe(0);
    expect(levelToUnit(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("is monotonically non-decreasing across the range", () => {
    let previous = -1;
    for (let raw = 0; raw <= 1.0001; raw += 0.01) {
      const unit = levelToUnit(raw);
      expect(unit).toBeGreaterThanOrEqual(previous);
      previous = unit;
    }
  });

  it("lands quiet, normal and loud speech in separate bands", () => {
    const quiet = levelToUnit(0.33);
    const normal = levelToUnit(0.58);
    const loud = levelToUnit(0.83);
    expect(quiet).toBeLessThan(0.1);
    expect(normal).toBeGreaterThan(0.25);
    expect(normal).toBeLessThan(0.45);
    expect(loud).toBeGreaterThan(0.6);
    expect(levelToUnit(0.95)).toBeGreaterThan(0.85);
  });
});
