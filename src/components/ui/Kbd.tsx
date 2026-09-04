import type { ReactNode } from "react";

export function Kbd({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={`inline-flex h-[22px] items-center rounded-[6px] border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text ${className}`}
    >
      {children}
    </kbd>
  );
}
