import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TranscribeCompletePayload {
  path: string;
  text: string;
  modelId: string;
  durationMs: number;
  autoPaste: boolean;
  pasteError?: string;
}

export interface TranscriberState {
  busy: boolean;
  activePath: string | null;
  percent: number;
}

let state: TranscriberState = { busy: false, activePath: null, percent: 0 };
let initialized = false;
const listeners = new Set<() => void>();
const completeListeners = new Set<(payload: TranscribeCompletePayload) => void>();
const errorListeners = new Set<(payload: { path: string; message: string }) => void>();

function setState(next: Partial<TranscriberState>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

function clearActive(): void {
  setState({ busy: false, activePath: null, percent: 0 });
}

export function subscribeTranscriber(fn: () => void): () => void {
  ensureInit();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  void (async () => {
    try {
      await listen<{ path: string; percent: number }>("transcribe-progress", (e) => {
        const { path, percent } = e.payload;
        if (!state.busy) {
          // adoption rule: overlays consume this store without transcribeFile;
          // the backend guarantees the first progress event is 0%
          setState({ busy: true, activePath: path, percent });
        } else if (state.activePath === path) {
          setState({ percent });
        }
      });
      await listen<TranscribeCompletePayload>("transcribe-complete", (e) => {
        const payload = e.payload;
        if (!state.busy || state.activePath === payload.path) {
          clearActive();
          for (const fn of completeListeners) fn(payload);
        }
      });
      await listen<{ path: string; message: string }>("transcribe-error", (e) => {
        const payload = e.payload;
        if (!state.busy || state.activePath === payload.path) {
          clearActive();
          for (const fn of errorListeners) fn(payload);
        }
      });
    } catch {}
  })();
}

export function getTranscriberState(): TranscriberState {
  return state;
}

export function useTranscriber(): TranscriberState {
  ensureInit();
  return useSyncExternalStore(subscribeTranscriber, () => state, () => state);
}

export async function transcribeFile(path: string, autoPaste: boolean): Promise<void> {
  if (state.busy) {
    throw new Error("A transcription is already running — wait for it to finish.");
  }
  setState({ busy: true, activePath: path, percent: 0 });
  try {
    await invoke("transcribe_file", { path, autoPaste });
  } catch (e) {
    clearActive();
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export function onTranscribeComplete(fn: (payload: TranscribeCompletePayload) => void): () => void {
  completeListeners.add(fn);
  return () => {
    completeListeners.delete(fn);
  };
}

export function onTranscribeError(fn: (payload: { path: string; message: string }) => void): () => void {
  errorListeners.add(fn);
  return () => {
    errorListeners.delete(fn);
  };
}
