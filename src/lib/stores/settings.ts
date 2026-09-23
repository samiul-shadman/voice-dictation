import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type PasteMode = "auto" | "ctrl_v" | "ctrl_shift_v" | "shift_insert" | "clipboard_only";
export type AudioFormat = "mp3" | "wav";
export type Trigger = "hold" | "toggle";
export type IndicatorMode = "floating" | "panel" | "both";

export interface ShortcutConfig {
  combo: string | null;
  trigger: Trigger;
  enabled: boolean;
}

export interface Settings {
  globalShortcutsEnabled: boolean;
  shortcuts: {
    voiceNote: ShortcutConfig;
    record: ShortcutConfig;
  };
  audioDir: string;
  audioFormat: AudioFormat;
  pasteMode: PasteMode;
  defaultModel: string;
  modelsDir: string | null;
  indicatorMode: IndicatorMode;
  indicatorRecordingStyle: string;
  indicatorTranscriptionStyle: string;
}

export interface SettingsState {
  loaded: boolean;
  settings: Settings | null;
}

let state: SettingsState = { loaded: false, settings: null };
let initialized = false;
const listeners = new Set<() => void>();

function setState(next: SettingsState): void {
  state = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function reloadSettings(): Promise<void> {
  try {
    const settings = await invoke<Settings>("get_settings");
    setState({ loaded: true, settings });
  } catch {
    setState({ loaded: true, settings: null });
  }
}

export function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  void (async () => {
    await reloadSettings();
    try {
      await listen<unknown>("settings-changed", () => {
        void reloadSettings();
      });
    } catch {}
  })();
}

export function getSettingsState(): SettingsState {
  return state;
}

function useSettingsStore(): Settings | null {
  ensureInit();
  return useSyncExternalStore(subscribe, () => state.settings, () => null);
}

export function useSettings(): Settings | null {
  return useSettingsStore();
}

export function useShortcutConfig(): Settings["shortcuts"] | null {
  const settings = useSettingsStore();
  return settings ? settings.shortcuts : null;
}

export function useAudioPrefs(): { audioDir: string; audioFormat: AudioFormat } | null {
  const settings = useSettingsStore();
  return settings ? { audioDir: settings.audioDir, audioFormat: settings.audioFormat } : null;
}

export function usePasteMode(): PasteMode | null {
  const settings = useSettingsStore();
  return settings ? settings.pasteMode : null;
}

export function useIndicatorStyles(): {
  recordingStyle: string;
  transcriptionStyle: string;
} | null {
  const settings = useSettingsStore();
  return settings
    ? {
        recordingStyle: settings.indicatorRecordingStyle,
        transcriptionStyle: settings.indicatorTranscriptionStyle,
      }
    : null;
}

export function useGlobalShortcutsEnabled(): boolean | null {
  const settings = useSettingsStore();
  return settings ? settings.globalShortcutsEnabled : null;
}

export function useIndicatorMode(): IndicatorMode | null {
  const settings = useSettingsStore();
  return settings ? settings.indicatorMode : null;
}

export function subscribeSettings(fn: () => void): () => void {
  ensureInit();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
