export interface RadioCardOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface RadioCardGroupProps<T extends string> {
  options: readonly RadioCardOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}

export function RadioCardGroup<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = "",
}: RadioCardGroupProps<T>) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`flex flex-col gap-2 ${className}`}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={`w-full rounded-lg border p-3 text-left transition-colors duration-150 ${
              active
                ? "border-accent bg-accent-soft"
                : "border-border bg-surface hover:border-border-strong"
            }`}
          >
            <span className={`block text-[13px] font-medium ${active ? "text-text" : "text-text-2"}`}>
              {option.label}
            </span>
            {option.hint && <span className="mt-1 block text-xs text-text-3">{option.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
