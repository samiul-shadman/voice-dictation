import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";

let state = 0;
let initialized = false;
const listeners = new Set<() => void>();

function setState(next: number): void {
  state = next;
  for (const fn of listeners) fn();
}

export function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  void (async () => {
    try {
      await listen<{ level: number }>("recording-level", (e) => {
        const raw = typeof e.payload?.level === "number" && Number.isFinite(e.payload.level) ? e.payload.level : 0;
        setState(Math.max(0, Math.min(1, raw)));
      });
    } catch {}
  })();
}

export function subscribeLevel(fn: () => void): () => void {
  ensureInit();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getLevel(): number {
  return state;
}

export function useLevel(): number {
  ensureInit();
  return useSyncExternalStore(subscribeLevel, () => state, () => state);
}
