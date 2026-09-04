import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface/50 px-6 py-12 text-center">
      <span className="text-text-3">{icon}</span>
      <p className="mt-3 text-sm font-medium text-text">{title}</p>
      {hint && <p className="mt-1 max-w-[420px] text-[13px] text-text-2">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
