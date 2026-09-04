import type { ReactNode } from "react";

export interface SectionCardProps {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

export function SectionCard({ title, description, children, className = "" }: SectionCardProps) {
  const hasHeader = Boolean(title || description);
  return (
    <section className={`rounded-lg border border-border bg-surface p-5 ${className}`}>
      {title && <h2 className="text-[15px] font-medium text-text">{title}</h2>}
      {description && <p className="mt-1 text-[13px] text-text-2">{description}</p>}
      <div className={hasHeader ? "mt-4" : undefined}>{children}</div>
    </section>
  );
}
