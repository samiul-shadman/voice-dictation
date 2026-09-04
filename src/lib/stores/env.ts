import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

export type SessionType = "x11" | "wayland-wlroots" | "wayland-gnome" | "other";

export interface EnvInfo {
  ffmpeg: boolean;
  ffprobe: boolean;
  libmp3lame: boolean;
  pulseInput: boolean;
  sessionType: SessionType;
  wtype: boolean;
}

let state: EnvInfo | null = null;
let initialized = false;
const listeners = new Set<() => void>();

function setState(next: EnvInfo | null): void {
  state = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function loadEnvInfo(): Promise<void> {
  try {
    const info = await invoke<EnvInfo>("detect_environment");
    setState(info);
  } catch {
    setState(null);
  }
}

export function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  void loadEnvInfo();
}

export function getEnvState(): EnvInfo | null {
  return state;
}

export function useEnvInfo(): EnvInfo | null {
  ensureInit();
  return useSyncExternalStore(subscribe, () => state, () => null);
}
