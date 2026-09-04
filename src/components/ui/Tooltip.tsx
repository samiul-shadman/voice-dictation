import type { ReactNode } from "react";

type TooltipSide = "top" | "bottom" | "left" | "right";

const SIDE_CLASSES: Record<TooltipSide, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
  left: "right-full top-1/2 -translate-y-1/2 mr-2",
  right: "left-full top-1/2 -translate-y-1/2 ml-2",
};

export interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: TooltipSide;
}

export function Tooltip({ label, children, side = "bottom" }: TooltipProps) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-40 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] text-text opacity-0 shadow-raised transition-opacity delay-0 duration-150 group-hover/tt:delay-[120ms] group-hover/tt:opacity-100 ${SIDE_CLASSES[side]}`}
      >
        {label}
      </span>
    </span>
  );
}
