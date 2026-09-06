import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

export type SessionType = "x11" | "wayland-wlroots" | "wayland-gnome" | "native" | "other";

export interface EnvInfo {
  platform: string;
  micAvailable: boolean;
  accessibilityPermission: boolean | null;
  sessionType: SessionType;
  wtype: boolean | null;
}

export function isMac(info: EnvInfo | null): boolean {
  return info?.platform === "macos";
}

export function isLinux(info: EnvInfo | null): boolean {
  return info?.platform === "linux";
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
