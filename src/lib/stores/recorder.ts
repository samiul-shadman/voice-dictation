import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AudioFormat, Settings } from "./settings";

export interface RecordingMeta {
  path: string;
  name: string;
  format: "mp3" | "wav";
  size: number;
  durationSecs: number | null;
  modified: number;
  hasTranscript: boolean;
}

export interface RecorderState {
  recording: boolean;
  stopping: boolean;
  lastError: string | null;
}

let state: RecorderState = { recording: false, stopping: false, lastError: null };
let initialized = false;
const listeners = new Set<() => void>();

function setState(next: Partial<RecorderState>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

function readableError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function subscribeRecorder(fn: () => void): () => void {
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
      await listen<{ recording: boolean; stopping: boolean }>("recording-state", (e) => {
        setState({ recording: e.payload.recording, stopping: e.payload.stopping });
      });
    } catch (e) {
      console.error("[recorder] recording-state listener failed", e);
    }
    try {
      const remote = await invoke<{ recording: boolean; stopping: boolean }>("recording_state");
      setState({ recording: remote.recording, stopping: remote.stopping });
    } catch (e) {
      console.error("[recorder] recording_state seed failed", e);
    }
  })();
}

export function getRecorderState(): RecorderState {
  return state;
}

export function useRecording(): RecorderState {
  ensureInit();
  return useSyncExternalStore(subscribeRecorder, () => state, () => state);
}

export async function startRecording(format?: AudioFormat): Promise<void> {
  let resolved: string | null = format ?? null;
  if (format === undefined) {
    try {
      const settings = await invoke<Settings>("get_settings");
      resolved = settings.audioFormat;
    } catch {
      resolved = null;
    }
  }
  try {
    await invoke("start_recording", { format: resolved });
    setState({ recording: true, stopping: false, lastError: null });
  } catch (e) {
    const message = readableError(e);
    setState({ recording: false, stopping: false, lastError: message });
    throw new Error(message);
  }
}

export async function stopRecording(): Promise<RecordingMeta | null> {
  setState({ stopping: true });
  try {
    const meta = await invoke<RecordingMeta | null>("stop_recording");
    setState({ recording: false, stopping: false, lastError: null });
    return meta;
  } catch (e) {
    setState({ recording: false, stopping: false, lastError: readableError(e) });
    return null;
  }
}

export async function cancelRecording(): Promise<void> {
  try {
    await invoke("cancel_recording");
  } catch (e) {
    setState({ lastError: readableError(e) });
  }
  setState({ recording: false, stopping: false });
}

export async function toggleRecording(): Promise<RecordingMeta | null> {
  let remote: { recording: boolean; stopping: boolean };
  try {
    remote = await invoke<{ recording: boolean; stopping: boolean }>("recording_state");
  } catch {
    remote = { recording: state.recording, stopping: state.stopping };
  }
  if (remote.stopping) return null;
  if (remote.recording) return await stopRecording();
  await startRecording();
  return null;
}

export async function listRecordings(): Promise<RecordingMeta[]> {
  return await invoke<RecordingMeta[]>("list_recordings");
}

export async function deleteRecording(path: string): Promise<void> {
  await invoke("delete_recording", { path });
}

export async function deleteAllRecordings(): Promise<number> {
  return await invoke<number>("delete_all_recordings");
}

export async function defaultRecordingsDir(): Promise<string> {
  return await invoke<string>("default_recordings_dir");
}
