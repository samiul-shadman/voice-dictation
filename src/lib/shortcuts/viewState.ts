import { canonicalCombo } from "./canonical";
import type { ActionId, Trigger } from "./canonical";

export interface ShortcutViewConfig {
  combo: string | null;
  trigger: Trigger;
  enabled: boolean;
}

export type ShortcutConfigs = Record<ActionId, ShortcutViewConfig>;

export interface ShortcutPatch {
  combo?: string | null;
  trigger?: Trigger;
  enabled?: boolean;
}

const ACTION_ORDER: readonly ActionId[] = ["voiceNote", "record"];

const ACTION_NAMES: Record<ActionId, string> = {
  voiceNote: "Voice note",
  record: "Record",
};

export function conflictMessage(
  action: ActionId,
  combo: string,
  configs: ShortcutConfigs,
  masterEnabled: boolean,
): string | null {
  // Mirrors the filter in engine.ts runSync: a combo only occupies a slot in the OS
  // registry when the master switch is on and the owning action is enabled. Blocking
  // here for a disabled action would refuse a combo the engine would accept.
  if (!combo) return null;
  const canon = canonicalCombo(combo);
  if (!canon) return null;
  if (!masterEnabled) return null;
  const other = ACTION_ORDER.find((candidate) => candidate !== action);
  if (!other) return null;
  const otherConfig = configs[other];
  if (!otherConfig.enabled) return null;
  const otherCanon = otherConfig.combo ? canonicalCombo(otherConfig.combo) : "";
  if (otherCanon !== canon) return null;
  return `Already used by ${ACTION_NAMES[other]}`;
}

export function resolveShortcutView(
  config: ShortcutViewConfig,
  patch: ShortcutPatch | undefined,
): ShortcutViewConfig {
  if (!patch) return config;
  return {
    combo: patch.combo !== undefined ? patch.combo : config.combo,
    trigger: patch.trigger ?? config.trigger,
    enabled: patch.enabled ?? config.enabled,
  };
}