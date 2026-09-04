export interface ProgressProps {
  value: number;
  showPercent?: boolean;
  className?: string;
}

export function Progress({ value, showPercent = false, className = "" }: ProgressProps) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-pill bg-surface-2"
      >
        <div
          className="h-full rounded-pill bg-accent transition-[width] duration-[240ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]"
          style={{ width: `${pct}%` }}
        />
      </div>
      {showPercent && (
        <span className="shrink-0 font-mono text-xs tabular-nums text-text-2">{Math.round(pct)}%</span>
      )}
    </div>
  );
}
