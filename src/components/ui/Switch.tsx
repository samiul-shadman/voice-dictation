export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-pill border transition-colors duration-[160ms] disabled:pointer-events-none disabled:opacity-50 ${
        checked ? "border-transparent bg-accent" : "border-border bg-surface-2"
      }`}
    >
      <span
        aria-hidden
        className="absolute left-[2px] top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-text shadow-rest transition-transform duration-[160ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]"
        style={{ transform: `translate(${checked ? 18 : 0}px, -50%)` }}
      />
    </button>
  );
}
