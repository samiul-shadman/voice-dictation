export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const text = i === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[i]}`;
}

export function fmtClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "--:--";
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function humanDuration(seconds: number | undefined | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  return fmtClock(Math.round(seconds));
}

export function humanRelativeTime(unixMs: number): string {
  if (!Number.isFinite(unixMs)) return "--";
  const diffMs = Date.now() - unixMs;
  const future = diffMs < 0;
  const seconds = Math.round(Math.abs(diffMs) / 1000);
  let span: string;
  if (seconds < 10) {
    return future ? "in a moment" : "just now";
  } else if (seconds < 60) {
    span = `${seconds} sec`;
  } else if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    span = `${m} min`;
  } else if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    span = `${h} hr`;
  } else if (seconds < 2592000) {
    const d = Math.floor(seconds / 86400);
    span = `${d} day${d > 1 ? "s" : ""}`;
  } else if (seconds < 31536000) {
    const mo = Math.floor(seconds / 2592000);
    span = `${mo} mo`;
  } else {
    const y = Math.floor(seconds / 31536000);
    span = `${y} yr`;
  }
  return future ? `in ${span}` : `${span} ago`;
}
