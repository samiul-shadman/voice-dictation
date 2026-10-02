import { useEffect, useRef, useState } from "react";
import { canonicalCombo, humanize } from "../../lib/shortcuts/canonical";
import { startCapture } from "../../lib/shortcuts/capture";
import { Kbd } from "./Kbd";

export interface KeyInputProps {
  value: string | null;
  onChange: (combo: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  action: "voiceNote" | "record";
}

function ComboChips({ combo }: { combo: string }) {
  const parts = combo.split("+").filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      {parts.map((part, i) => (
        <span key={`${part}-${i}`} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-[11px] text-text-3">+</span>}
          <Kbd>{humanize(part)}</Kbd>
        </span>
      ))}
    </span>
  );
}

export default function KeyInput({
  value,
  onChange,
  placeholder = "Click to record a hotkey",
  disabled = false,
  action,
}: KeyInputProps) {
  const [capturing, setCapturing] = useState(false);
  const [preview, setPreview] = useState("");
  const stopRef = useRef<(() => void) | null>(null);
  const combo = value ? canonicalCombo(value) : null;
  const label = action === "voiceNote" ? "Voice note" : "Record";

  const endCapture = (): void => {
    stopRef.current?.();
    stopRef.current = null;
    setCapturing(false);
    setPreview("");
  };

  const beginCapture = (): void => {
    if (disabled || capturing) return;
    setCapturing(true);
    setPreview("");
    stopRef.current = startCapture({
      onPreview: setPreview,
      onCommit: (raw) => {
        endCapture();
        onChange(canonicalCombo(raw));
      },
      onCancel: endCapture,
      onClear: () => {
        endCapture();
        onChange(null);
      },
    });
  };

  useEffect(
    () => () => {
      stopRef.current?.();
      stopRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (disabled) endCapture();
  }, [disabled]);

  const shown = capturing ? preview : combo;

  return (
    <button
      type="button"
      aria-label={`${label} hotkey`}
      disabled={disabled}
      onClick={beginCapture}
      onBlur={() => {
        if (capturing) endCapture();
      }}
      title={shown ? humanize(shown) : undefined}
      className={`flex h-9 w-full items-center gap-1.5 overflow-hidden rounded-md border px-2.5 text-left transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 ${
        capturing
          ? "border-accent bg-accent-soft"
          : combo
            ? "border-border bg-surface hover:border-border-strong"
            : "border-dashed border-border bg-surface hover:border-border-strong"
      }`}
    >
      <span aria-live="polite" className="flex min-w-0 items-center">
        {capturing ? (
          preview ? (
            <ComboChips combo={preview} />
          ) : (
            <span className="truncate text-[13px] text-text-3">Press keys…</span>
          )
        ) : combo ? (
          <ComboChips combo={combo} />
        ) : (
          <span className="truncate text-[13px] text-text-3">{placeholder}</span>
        )}
      </span>
    </button>
  );
}