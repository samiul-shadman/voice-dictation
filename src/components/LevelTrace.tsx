import { useEffect, useState } from "react";
import type { JSX } from "react";
import { levelToUnit } from "../lib/animations/levelResponse";

const BAR_COUNT = 20;
const TRACE_HEIGHT_PX = 44;
const MIN_BAR_PX = 3;
const LEVEL_SPAN_PX = TRACE_HEIGHT_PX - MIN_BAR_PX;

const css = `
.level-trace {
  display: flex;
  flex-direction: row;
  align-items: flex-end;
  gap: 3px;
  height: ${TRACE_HEIGHT_PX}px;
}
.level-trace-bar {
  width: 4px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--rec, #c4a46a);
}
`;

export interface LevelTraceProps {
  level: number;
}

function barHeightPx(level: number): string {
  const px = MIN_BAR_PX + levelToUnit(level) * LEVEL_SPAN_PX;
  return `${px.toFixed(2)}px`;
}

export function LevelTrace(props: LevelTraceProps): JSX.Element {
  const { level } = props;
  const [levels, setLevels] = useState<number[]>([]);

  useEffect(() => {
    setLevels((prev) => [...prev, level].slice(-BAR_COUNT));
  }, [level]);

  return (
    <div className="level-trace" aria-hidden="true">
      <style>{css}</style>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span
          key={i}
          className="level-trace-bar"
          style={{ height: barHeightPx(levels[i] ?? 0) }}
        />
      ))}
    </div>
  );
}
