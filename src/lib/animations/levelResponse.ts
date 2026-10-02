// Rust maps dBFS to (db + 60) / 60, so room noise lands near 0.25 and ordinary
// speech near 0.6-0.75; a straight level->pixel mapping renders speech at ~70%
// height. Gate the noise floor away, then expand contrast above it.
const FLOOR = 0.25;
const EXPONENT = 1.35;

export function levelToUnit(level: number): number {
  const raw = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  if (raw <= FLOOR) return 0;
  return Math.pow((raw - FLOOR) / (1 - FLOOR), EXPONENT);
}
