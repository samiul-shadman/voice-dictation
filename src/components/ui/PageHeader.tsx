export interface PageHeaderProps {
  title: string;
  description?: string;
}

export function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <header className="mb-6">
      <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-text">{title}</h1>
      {description && <p className="mt-1 text-sm text-text-2">{description}</p>}
    </header>
  );
}
