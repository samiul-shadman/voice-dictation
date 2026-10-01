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

export type TranscribePhase = "loading" | "transcribing";

export interface TranscriberState {
  busy: boolean;
  activePath: string | null;
  percent: number;
  phase: TranscribePhase;
}

let state: TranscriberState = {
  busy: false,
  activePath: null,
  percent: 0,
  phase: "transcribing",
};
let initialized = false;
const listeners = new Set<() => void>();
const completeListeners = new Set<(payload: TranscribeCompletePayload) => void>();
const errorListeners = new Set<(payload: { path: string; message: string }) => void>();

function setState(next: Partial<TranscriberState>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

function clearActive(): void {
  setState({ busy: false, activePath: null, percent: 0, phase: "transcribing" });
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
      await listen<{ path: string; percent: number; phase?: string }>("transcribe-progress", (e) => {
        const { path, percent } = e.payload;
        // phase is optional on the wire (OverlaySync synthesises phase-less events) — absent means transcribing
        const phase: TranscribePhase = e.payload.phase === "loading" ? "loading" : "transcribing";
        if (!state.busy) {
          // adoption rule: overlays consume this store without transcribeFile;
          // the backend guarantees the first progress event is 0%
          setState({ busy: true, activePath: path, percent, phase });
        } else if (state.activePath === path) {
          setState({ percent, phase });
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
    } catch (e) {
      console.error("[transcriber] transcribe listener init failed", e);
    }
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
    // Synchronous command failures (no model, busy, confined path) never reach the
    // backend's transcribe-error event, so surface them through the same listeners.
    const message = e instanceof Error ? e.message : String(e);
    for (const fn of errorListeners) fn({ path, message });
    throw e instanceof Error ? e : new Error(message);
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
