export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  busy?: boolean;
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  busy = false,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={() => {
        if (busy) return;
        onChange(!checked);
      }}
      className={`relative h-5 w-9 shrink-0 rounded-pill border transition-colors duration-[160ms] disabled:pointer-events-none disabled:opacity-50 ${
        checked ? "border-transparent bg-accent" : "border-border bg-surface-2"
      }`}
    >
      <span
        aria-hidden
        // v4 compiles -translate-y-1/2 to the `translate` property, so the horizontal
        // travel has to live in `translate-x-*` too — an inline style.transform would
        // stack a second -50% Y offset and push the knob out of the track. Travel is
        // 14px: 36 track - 16 knob - 2*2 inset - 2*1 border, measured inside the
        // padding box that positions the absolutely placed knob.
        className={`absolute left-[2px] top-1/2 h-4 w-4 -translate-y-1/2 rounded-full shadow-rest transition-transform duration-[160ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
          checked ? "translate-x-[14px] bg-text" : "translate-x-0 bg-text-3"
        }`}
      />
    </button>
  );
}
