import { ChevronDown } from "lucide-react";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  options: readonly SelectOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
}

export function Select<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = "",
  disabled = false,
  placeholder,
}: SelectProps<T>) {
  // A stored value that is no longer in the list must stay visible rather than
  // silently rendering as the first option, which would read as "this is what
  // is recording" when it is not.
  const known = value !== null && options.some((o) => o.value === value);
  const orphaned = value !== null && !known;
  const selectValue = known ? value : "";
  return (
    <div className={`relative ${className}`}>
      <select
        aria-label={ariaLabel}
        disabled={disabled}
        value={selectValue}
        onChange={(e) => {
          if (disabled) return;
          const next = options.find((o) => o.value === e.target.value);
          if (next) onChange(next.value);
        }}
        className={`h-9 w-full appearance-none rounded-md border bg-surface-2 pl-3 pr-9 text-[13px] text-text disabled:cursor-not-allowed disabled:opacity-50 ${
          orphaned ? "border-warn/60" : "border-border"
        }`}
      >
        {(orphaned || !value) && placeholder !== undefined && (
          <option value="" disabled={false}>
            {placeholder}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        size={14}
        strokeWidth={1.75}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-3"
      />
    </div>
  );
}