import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./Spinner";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 rounded-md px-2.5 text-[13px]",
  md: "h-9 gap-2 rounded-md px-3.5 text-[13px]",
  lg: "h-11 gap-2 rounded-lg px-5 text-sm",
};

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "border border-transparent bg-accent font-medium text-white hover:bg-accent-strong disabled:opacity-50",
  secondary:
    "border border-border bg-surface-2 text-text hover:border-border-strong hover:bg-[#1B202A] disabled:opacity-50",
  ghost:
    "border border-transparent bg-transparent text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-50",
  danger:
    "border border-transparent bg-err-soft text-err hover:bg-[rgba(248,113,113,0.22)] disabled:opacity-50",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, leftIcon, className = "", children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      className={`inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-colors duration-150 disabled:pointer-events-none ${SIZE_CLASSES[size]} ${VARIANT_CLASSES[variant]} ${className}`}
      {...rest}
    >
      {loading ? <Spinner size={size === "sm" ? 14 : 16} /> : leftIcon}
      {children}
    </button>
  );
});
