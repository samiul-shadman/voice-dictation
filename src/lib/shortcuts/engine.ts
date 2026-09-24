import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isRegistered, register, unregister } from "@tauri-apps/plugin-global-shortcut";
import type { ShortcutEvent, ShortcutHandler } from "@tauri-apps/plugin-global-shortcut";
import { canonicalCombo, toAccelerator } from "./canonical";
import type { ActionId, Trigger } from "./canonical";
import { beginHold, endHold, onHoldEnd } from "./hold";
import type { HoldKind } from "./hold";
import { toggleVoiceNote } from "../voiceNote";
import * as recorder from "../stores/recorder";
import type { Settings } from "../stores/settings";

const ACTIONS: ActionId[] = ["voiceNote", "record"];
const RESYNC_DEBOUNCE_MS = 200;
const TOGGLE_ARMED_MS = 1200;

export interface ArmedState {
  combo: string;
  action: ActionId;
  trigger: Trigger;
}

export type ShortcutStatusKind = "registered" | "error" | "off" | "disabled" | "master-off";

export interface ShortcutStatusEntry {
  state: ShortcutStatusKind;
  detail?: string;
}

export interface ShortcutStatusState {
  actions: Record<ActionId, ShortcutStatusEntry>;
  registeredCount: number;
  firstError?: string;
}

interface DesiredEntry {
  canon: string;
  action: ActionId;
  trigger: Trigger;
}

interface LiveEntry {
  action: ActionId;
  canon: string;
}

const armedListeners = new Set<() => void>();
const statusListeners = new Set<() => void>();

let initialized = false;
let armed: ArmedState | null = null;
let live = new Map<string, LiveEntry>();
let actionConfig = new Map<ActionId, { canon: string; trigger: Trigger }>();
let chain: Promise<void> = Promise.resolve();
let resyncTimer: ReturnType<typeof setTimeout> | null = null;
let toggleTimer: ReturnType<typeof setTimeout> | null = null;
let statusSnapshot: ShortcutStatusState = {
  actions: { voiceNote: { state: "off" }, record: { state: "off" } },
  registeredCount: 0,
};

export function getArmed(): ArmedState | null {
  return armed;
}

export function onArmedChange(fn: () => void): () => void {
  armedListeners.add(fn);
  return () => {
    armedListeners.delete(fn);
  };
}

export function getShortcutStatus(): ShortcutStatusState {
  return statusSnapshot;
}

export function useShortcutStatus(): ShortcutStatusState {
  return useSyncExternalStore(subscribeStatus, getShortcutStatus, getShortcutStatus);
}

function subscribeStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}

function notifyArmed(): void {
  for (const fn of armedListeners) fn();
}

function sameArmed(a: ArmedState | null, b: ArmedState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.combo === b.combo && a.action === b.action && a.trigger === b.trigger;
}

function setArmed(next: ArmedState | null): void {
  const changed = !sameArmed(armed, next);
  armed = next;
  if (changed) notifyArmed();
}

function readableError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

function holdKindFor(action: ActionId): HoldKind {
  return action === "voiceNote" ? "voice-note" : "record";
}

function disarmShortcut(): void {
  clearToggleTimer();
  const prev = armed;
  setArmed(null);
  if (prev) {
    void emitTo("indicator", "shortcut-disarmed", { combo: prev.combo }).catch(() => {});
  }
}

function clearToggleTimer(): void {
  if (toggleTimer) {
    clearTimeout(toggleTimer);
    toggleTimer = null;
  }
}

function armShortcut(action: ActionId, trigger: Trigger, canon: string): void {
  if (!canon) return;
  clearToggleTimer();
  setArmed({ combo: canon, action, trigger });
  if (trigger === "toggle") {
    toggleTimer = setTimeout(() => {
      toggleTimer = null;
      setArmed(null);
    }, TOGGLE_ARMED_MS);
  }
}

function dispatchShortcut(action: ActionId, state: "Pressed" | "Released"): void {
  const cfg = actionConfig.get(action);
  const trigger: Trigger = cfg?.trigger ?? "hold";
  const canon = cfg?.canon ?? "";
  if (state === "Pressed") {
    if (trigger === "hold") {
      beginHold(holdKindFor(action));
    } else if (action === "voiceNote") {
      void toggleVoiceNote();
    } else {
      void recorder.startRecording().catch(() => {});
    }
    armShortcut(action, trigger, canon);
    void emitTo("indicator", "shortcut-armed", { combo: canon, action, trigger }).catch(() => {});
  } else {
    if (trigger === "hold") {
      endHold(holdKindFor(action));
    } else if (action === "record") {
      void recorder.stopRecording();
    }
    disarmShortcut();
  }
}

function makeHandler(action: ActionId): ShortcutHandler {
  return (event: ShortcutEvent) => {
    if (event.state === "Pressed" && (event as ShortcutEvent & { repeat?: boolean }).repeat) return;
    dispatchShortcut(action, event.state);
  };
}

async function runSync(): Promise<void> {
  let settings: Settings;
  try {
    settings = await invoke<Settings>("get_settings");
  } catch (e) {
    console.error("[shortcuts] get_settings failed", e);
    return;
  }

  const desired = new Map<string, { action: ActionId; trigger: Trigger }>();
  if (settings.globalShortcutsEnabled) {
    for (const action of ACTIONS) {
      const cfg = settings.shortcuts[action];
      if (!cfg.enabled || !cfg.combo) continue;
      const canon = canonicalCombo(cfg.combo);
      if (canon) desired.set(canon, { action, trigger: cfg.trigger });
    }
  }
  actionConfig = new Map(
    [...desired].map(([canon, entry]) => [entry.action, { canon, trigger: entry.trigger }] as const),
  );

  const desiredAccel = new Map<string, DesiredEntry>();
  const conflicts = new Set<ActionId>();
  for (const [canon, entry] of desired) {
    const accel = toAccelerator(canon);
    const existing = desiredAccel.get(accel);
    if (existing && existing.action !== entry.action) {
      conflicts.add(entry.action);
      continue;
    }
    desiredAccel.set(accel, { canon, action: entry.action, trigger: entry.trigger });
  }

  const stale: string[] = [];
  for (const [accel, entry] of live) {
    const want = desiredAccel.get(accel);
    if (!want || want.canon !== entry.canon || want.action !== entry.action) stale.push(accel);
  }
  for (const accel of stale) {
    try {
      if (await isRegistered(accel)) await unregister(accel);
    } catch (e) {
      console.error("[shortcuts] unregister failed", e);
    }
    live.delete(accel);
  }

  const errors = new Map<ActionId, string>();
  for (const action of conflicts) {
    errors.set(action, "combo conflicts with another action");
  }
  for (const [accel, want] of desiredAccel) {
    const existing = live.get(accel);
    if (existing && existing.action === want.action && existing.canon === want.canon) continue;
    try {
      await register(accel, makeHandler(want.action));
      live.set(accel, { action: want.action, canon: want.canon });
    } catch (e) {
      errors.set(want.action, readableError(e));
    }
  }

  const nextActions = {} as Record<ActionId, ShortcutStatusEntry>;
  for (const action of ACTIONS) {
    const cfg = settings.shortcuts[action];
    if (!settings.globalShortcutsEnabled) nextActions[action] = { state: "master-off" };
    else if (errors.has(action)) nextActions[action] = { state: "error", detail: errors.get(action) };
    else if (!cfg.enabled) nextActions[action] = { state: "disabled" };
    else if (!cfg.combo) nextActions[action] = { state: "off" };
    else nextActions[action] = { state: "registered" };
  }
  applyStatus(nextActions);
}

function applyStatus(actions: Record<ActionId, ShortcutStatusEntry>): void {
  const registeredCount = ACTIONS.filter((action) => actions[action].state === "registered").length;
  const firstError = ACTIONS.map((action) =>
    actions[action].state === "error" ? actions[action].detail : undefined,
  ).find((detail): detail is string => typeof detail === "string");
  statusSnapshot = firstError ? { actions, registeredCount, firstError } : { actions, registeredCount };
  for (const fn of statusListeners) fn();
}

export function syncGlobalShortcuts(): Promise<void> {
  const queued = chain.then(runSync, runSync);
  chain = queued.catch(() => {});
  return queued;
}

function scheduleResync(): void {
  if (resyncTimer) clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    void syncGlobalShortcuts();
  }, RESYNC_DEBOUNCE_MS);
}

export function initShortcutEngine(): void {
  if (initialized) return;
  let label = "main";
  try {
    label = getCurrentWindow().label;
  } catch {
    // no Tauri window context (tests/SSR); default label stands
  }
  if (label !== "main") return;
  initialized = true;
  void (async () => {
    try {
      await listen("settings-changed", scheduleResync);
    } catch (e) {
      console.error("[shortcuts] settings-changed listener failed", e);
    }
  })();
  onHoldEnd((kind) => {
    if (armed && armed.trigger === "hold" && holdKindFor(armed.action) === kind) disarmShortcut();
  });
  void syncGlobalShortcuts();
}

export function resetShortcutEngineForTests(): void {
  if (resyncTimer) {
    clearTimeout(resyncTimer);
    resyncTimer = null;
  }
  clearToggleTimer();
  initialized = false;
  armed = null;
  live = new Map();
  actionConfig = new Map();
  chain = Promise.resolve();
  statusSnapshot = {
    actions: { voiceNote: { state: "off" }, record: { state: "off" } },
    registeredCount: 0,
  };
}
