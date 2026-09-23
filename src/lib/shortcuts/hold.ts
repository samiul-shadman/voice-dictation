import * as recorder from "../stores/recorder";
import { endVoiceNoteHold, startVoiceNoteHold } from "../voiceNote";

export type HoldKind = "voice-note" | "record";

export interface HoldActions {
  start: () => void;
  cancel: () => void;
  finish: () => void;
}

export const MIN_HOLD_MS = 300;
// lost-keyup failsafe: force-finish if the release never arrives
export const HARD_TIMEOUT_MS = 300_000;

const DEFAULT_ACTIONS: Record<HoldKind, HoldActions> = {
  "voice-note": {
    start: () => void startVoiceNoteHold(),
    cancel: () => void recorder.cancelRecording(),
    finish: () => void endVoiceNoteHold(),
  },
  record: {
    start: () => void recorder.startRecording().catch(() => {}),
    cancel: () => void recorder.cancelRecording(),
    finish: () => void recorder.stopRecording().then(() => {}),
  },
};

const actionsByKind: Record<HoldKind, HoldActions> = {
  "voice-note": DEFAULT_ACTIONS["voice-note"],
  record: DEFAULT_ACTIONS.record,
};

export function setHoldActions(kind: HoldKind, actions: HoldActions): void {
  actionsByKind[kind] = actions;
}

interface ActiveHold {
  kind: HoldKind;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

let active: ActiveHold | null = null;
const endListeners = new Set<(kind: HoldKind) => void>();
let blurAttached = false;

export function activeHoldKind(): HoldKind | null {
  return active?.kind ?? null;
}

export function onHoldEnd(fn: (kind: HoldKind) => void): () => void {
  endListeners.add(fn);
  return () => {
    endListeners.delete(fn);
  };
}

function notifyEnd(kind: HoldKind): void {
  for (const fn of endListeners) fn(kind);
}

function detachBlur(): void {
  if (!blurAttached || typeof window === "undefined") return;
  window.removeEventListener("blur", onWindowBlur);
  blurAttached = false;
}

function onWindowBlur(): void {
  if (!active) return;
  const hold = active;
  active = null;
  clearTimeout(hold.timer);
  detachBlur();
  notifyEnd(hold.kind);
  actionsByKind[hold.kind].finish();
}

function onHardTimeout(): void {
  if (!active) return;
  const hold = active;
  active = null;
  detachBlur();
  notifyEnd(hold.kind);
  actionsByKind[hold.kind].finish();
}

export function beginHold(kind: HoldKind): void {
  if (active) return;
  const hold: ActiveHold = {
    kind,
    startedAt: Date.now(),
    timer: setTimeout(onHardTimeout, HARD_TIMEOUT_MS),
  };
  active = hold;
  if (!blurAttached && typeof window !== "undefined") {
    blurAttached = true;
    window.addEventListener("blur", onWindowBlur);
  }
  actionsByKind[kind].start();
}

export function endHold(kind: HoldKind): void {
  const hold = active;
  if (!hold || hold.kind !== kind) return;
  active = null;
  clearTimeout(hold.timer);
  detachBlur();
  notifyEnd(kind);
  if (Date.now() - hold.startedAt < MIN_HOLD_MS) actionsByKind[kind].cancel();
  else actionsByKind[kind].finish();
}
