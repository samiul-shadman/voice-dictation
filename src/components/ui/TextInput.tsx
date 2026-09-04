import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";

export type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { className = "", ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={`h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-text transition-colors duration-150 placeholder:text-text-3 hover:border-border-strong focus:border-accent disabled:pointer-events-none disabled:opacity-50 ${className}`}
      {...rest}
    />
  );
});
