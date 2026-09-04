import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface DownloadInfo {
  id: string;
  downloaded: number;
  total: number;
  percent: number;
  state: "active" | "done" | "error" | "cancelled";
  error?: string;
}

interface ProgressPayload {
  id: string;
  downloaded: number;
  total: number;
  percent: number;
}

interface IdPayload {
  id: string;
}

interface ErrorPayload {
  id: string;
  message: string;
}

let state: Record<string, DownloadInfo> = {};
let initialized = false;
const listeners = new Set<() => void>();

function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

function setState(next: Record<string, DownloadInfo>): void {
  state = next;
  for (const fn of listeners) fn();
}

function upsert(id: string, patch: Partial<DownloadInfo> & Pick<DownloadInfo, "state">): void {
  const prev = state[id];
  const next: DownloadInfo = {
    id,
    downloaded: patch.downloaded ?? prev?.downloaded ?? 0,
    total: patch.total ?? prev?.total ?? 0,
    percent: patch.percent ?? prev?.percent ?? 0,
    state: patch.state,
    error: "error" in patch ? patch.error : prev?.error,
  };
  setState({ ...state, [id]: next });
}

export function subscribeDownloads(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getDownloads(): Record<string, DownloadInfo> {
  return state;
}

export function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  void (async () => {
    try {
      await listen<ProgressPayload>("model-download-progress", (e) => {
        const p = e.payload;
        upsert(p.id, {
          state: "active",
          downloaded: p.downloaded,
          total: p.total,
          percent: p.percent,
        });
      });
      await listen<IdPayload>("model-download-done", (e) => {
        upsert(e.payload.id, { state: "done", percent: 100, error: undefined });
      });
      await listen<ErrorPayload>("model-download-error", (e) => {
        upsert(e.payload.id, { state: "error", error: e.payload.message });
      });
      await listen<IdPayload>("model-download-cancelled", (e) => {
        upsert(e.payload.id, { state: "cancelled", error: undefined });
      });
    } catch {}
  })();
}

export function useDownloads(): Record<string, DownloadInfo> {
  ensureInit();
  return useSyncExternalStore(subscribeDownloads, () => state, () => state);
}

export async function downloadModel(id: string): Promise<void> {
  upsert(id, { state: "active", downloaded: 0, total: 0, percent: 0, error: undefined });
  try {
    await invoke("download_model", { id });
  } catch (e) {
    upsert(id, { state: "error", error: errorMessage(e) });
  }
}

export async function cancelDownload(id: string): Promise<void> {
  try {
    await invoke("cancel_download", { id });
  } catch {}
}
