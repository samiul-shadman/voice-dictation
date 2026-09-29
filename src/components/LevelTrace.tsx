import { useEffect, useState } from "react";
import type { JSX } from "react";

const BAR_COUNT = 20;
const MIN_BAR_PX = 4;
const LEVEL_SCALE_PX = 28;

const css = `
.level-trace {
  display: flex;
  flex-direction: row;
  align-items: flex-end;
  gap: 3px;
  height: 32px;
}
.level-trace-bar {
  width: 4px;
  flex: 0 0 auto;
  background: var(--rec, #c4a46a);
}
`;

export interface LevelTraceProps {
  level: number;
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
          style={{ height: `${Math.max(MIN_BAR_PX, (levels[i] ?? 0) * LEVEL_SCALE_PX)}px` }}
        />
      ))}
    </div>
  );
}
