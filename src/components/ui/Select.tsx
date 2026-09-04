import { forwardRef } from "react";
import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className = "", children, ...rest },
  ref,
) {
  return (
    <div className={`relative inline-flex items-center ${className}`}>
      <select
        ref={ref}
        className="h-9 w-full cursor-pointer appearance-none rounded-md border border-border bg-surface-2 pl-3 pr-8 text-[13px] text-text transition-colors duration-150 hover:border-border-strong disabled:pointer-events-none disabled:opacity-50"
        {...rest}
      >
        {children}
      </select>
      <ChevronDown size={16} strokeWidth={1.75} className="pointer-events-none absolute right-2.5 text-text-3" />
    </div>
  );
});
