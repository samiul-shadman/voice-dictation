export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-spin rounded-full border-2 border-accent border-t-transparent align-[-0.125em] [animation-duration:800ms] ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
