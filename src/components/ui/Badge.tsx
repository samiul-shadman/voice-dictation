export type BadgeKind = "success" | "neutral" | "warn" | "error";

const KIND_CLASSES: Record<BadgeKind, string> = {
  success: "bg-ok-soft text-ok",
  neutral: "border border-border bg-surface-2 text-text-2",
  warn: "bg-warn-soft text-warn",
  error: "bg-err-soft text-err",
};

export function Badge({
  kind = "neutral",
  children,
  className = "",
}: {
  kind?: BadgeKind;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-medium ${KIND_CLASSES[kind]} ${className}`}
    >
      {children}
    </span>
  );
}
