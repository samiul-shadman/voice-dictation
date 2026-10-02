import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AudioLines, Wand } from "lucide-react";
import {
  Badge,
  PageHeader,
  SectionCard,
  SegmentedControl,
  Switch,
  toast,
} from "../components/ui";
import KeyInput from "../components/ui/KeyInput";
import type { SegmentedOption } from "../components/ui/SegmentedControl";
import type { ActionId, Trigger } from "../lib/shortcuts/canonical";
import { useShortcutStatus } from "../lib/shortcuts/engine";
import type { ShortcutStatusEntry } from "../lib/shortcuts/engine";
import { conflictMessage, resolveShortcutView } from "../lib/shortcuts/viewState";
import type { ShortcutPatch } from "../lib/shortcuts/viewState";
import { useGlobalShortcutsEnabled, useShortcutConfig } from "../lib/stores/settings";

const ACTION_ORDER: readonly ActionId[] = ["voiceNote", "record"];

const ACTION_META: Record<ActionId, { name: string; description: string; icon: ReactNode }> = {
  voiceNote: {
    name: "Voice note",
    description: "Record, transcribe locally and auto-paste the text where you are typing.",
    icon: <Wand size={16} strokeWidth={1.75} />,
  },
  record: {
    name: "Record",
    description: "Record and save to the library without transcription.",
    icon: <AudioLines size={16} strokeWidth={1.75} />,
  },
};

const TRIGGER_OPTIONS: readonly SegmentedOption<Trigger>[] = [
  { value: "hold", label: "Hold" },
  { value: "toggle", label: "Toggle" },
];

const TRIGGER_HINTS: Record<Trigger, string> = {
  hold: "Press and hold to run. Release to finish. Taps under 300 ms are ignored.",
  toggle: "Press once to start. Press again to stop.",
};

type PendingPatches = Partial<Record<ActionId, ShortcutPatch>>;

function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

function statusLine(entry: ShortcutStatusEntry): { text: string; className: string } {
  switch (entry.state) {
    case "registered":
      return { text: "Registered", className: "text-ok" };
    case "error":
      return { text: `Not registered — ${entry.detail ?? "unknown error"}`, className: "text-warn" };
    case "off":
      return { text: "Off", className: "text-text-3" };
    case "disabled":
      return { text: "Disabled", className: "text-text-3" };
    case "master-off":
      return { text: "Disabled by master switch", className: "text-text-3" };
  }
}

interface ShortcutCardProps {
  action: ActionId;
  combo: string | null;
  trigger: Trigger;
  enabled: boolean;
  status: ShortcutStatusEntry;
  ready: boolean;
  masterOff: boolean;
  conflict: string | null;
  busy: boolean;
  onComboChange: (action: ActionId, combo: string | null) => void;
  onTriggerChange: (action: ActionId, trigger: Trigger) => void;
  onEnabledChange: (action: ActionId, enabled: boolean) => void;
}

function ShortcutCard({
  action,
  combo,
  trigger,
  enabled,
  status,
  ready,
  masterOff,
  conflict,
  busy,
  onComboChange,
  onTriggerChange,
  onEnabledChange,
}: ShortcutCardProps) {
  const meta = ACTION_META[action];
  const line = statusLine(status);
  return (
    <SectionCard>
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-medium text-text">{meta.name}</h2>
            {action === "voiceNote" && <Badge kind="neutral">Primary</Badge>}
          </div>
          <p className="mt-0.5 text-[13px] text-text-2">{meta.description}</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_132px_auto] items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] text-text-3">Hotkey</span>
        <span className="text-[11px] text-text-3">Trigger</span>
        <span className="text-[11px] text-text-3">Enabled</span>
        <div className="min-w-0">
          <KeyInput
            action={action}
            value={combo}
            disabled={masterOff}
            onChange={(next) => onComboChange(action, next)}
          />
        </div>
        <SegmentedControl
          options={TRIGGER_OPTIONS}
          value={trigger}
          onChange={(next) => onTriggerChange(action, next)}
          ariaLabel={`${meta.name} trigger`}
          disabled={masterOff}
        />
        <Switch
          label={`${meta.name} shortcut enabled`}
          checked={enabled}
          disabled={masterOff}
          busy={busy}
          onChange={(next) => onEnabledChange(action, next)}
        />
      </div>
      <p aria-live="polite" className="mt-2 min-h-4 text-xs">
        {conflict ? (
          <span className="text-err">{conflict}</span>
        ) : (
          <span className="text-text-3">{TRIGGER_HINTS[trigger]}</span>
        )}
      </p>
      <p className={`mt-1.5 text-xs ${line.className}`}>
        {ready ? line.text : "Checking registration…"}
      </p>
    </SectionCard>
  );
}

export function ShortcutsPage() {
  const shortcuts = useShortcutConfig();
  const master = useGlobalShortcutsEnabled();
  const status = useShortcutStatus();
  const [pending, setPending] = useState<PendingPatches>({});
  const [pendingMaster, setPendingMaster] = useState<boolean | null>(null);
  // The combo the user just pressed that we refused to persist. The message is
  // derived from it every render, so it disappears on its own once the other
  // action gives the combo up.
  const [rejected, setRejected] = useState<Partial<Record<ActionId, string>>>({});

  const masterOff = master !== true && pendingMaster === null;
  const masterOn = pendingMaster ?? master === true;

  const setPendingFor = (action: ActionId, patch: ShortcutPatch | null): void => {
    setPending((prev) => {
      const next = { ...prev };
      if (patch) next[action] = { ...next[action], ...patch };
      else delete next[action];
      return next;
    });
  };

  // Drops only the fields this patch owned, so a failed write does not also discard
  // an optimistic value for another field that is still in flight.
  const clearPendingFor = (action: ActionId, patch: ShortcutPatch): void => {
    setPending((prev) => {
      const merged = prev[action];
      if (!merged) return prev;
      const next = { ...prev };
      const kept = { ...merged };
      for (const field of Object.keys(patch) as (keyof ShortcutPatch)[]) delete kept[field];
      if (Object.keys(kept).length) next[action] = kept;
      else delete next[action];
      return next;
    });
  };

  // set_shortcut is a whole-file rewrite in Rust, so two overlapping invokes for the
  // same action can land in either order and persist the older value last. Chaining
  // keeps every action's writes strictly sequential while leaving the two actions
  // independent.
  const writes = useRef<Partial<Record<ActionId, Promise<void>>>>({});

  useEffect(() => {
    if (!shortcuts) return;
    setPending((prev) => {
      const entries = Object.entries(prev) as [ActionId, ShortcutPatch][];
      if (!entries.length) return prev;
      const next = { ...prev };
      let changed = false;
      for (const [action, patch] of entries) {
        const stored = shortcuts[action];
        const settled =
          (patch.combo === undefined || stored.combo === patch.combo) &&
          (patch.trigger === undefined || stored.trigger === patch.trigger) &&
          (patch.enabled === undefined || stored.enabled === patch.enabled);
        if (!settled) continue;
        delete next[action];
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [shortcuts]);

  useEffect(() => {
    if (master !== null && pendingMaster === master) setPendingMaster(null);
  }, [master, pendingMaster]);

  async function persistShortcut(action: ActionId, patch: ShortcutPatch): Promise<void> {
    setPendingFor(action, patch);
    const send = (): Promise<void> =>
      invoke("set_shortcut", {
        action,
        combo: patch.combo ?? null,
        trigger: patch.trigger ?? null,
        enabled: patch.enabled ?? null,
      }).then(() => undefined);
    const previous = writes.current[action] ?? Promise.resolve();
    const current = previous.then(send, send);
    writes.current[action] = current.catch(() => undefined);
    try {
      await current;
    } catch (e) {
      clearPendingFor(action, patch);
      toast("error", `Could not update shortcut: ${errorMessage(e)}`);
    }
  }

  const handleComboChange = (action: ActionId, combo: string | null): void => {
    if (!shortcuts) return;
    const forget = (): void =>
      setRejected((prev) => {
        const next = { ...prev };
        delete next[action];
        return next;
      });
    if (combo === null) {
      forget();
      void persistShortcut(action, { combo: null });
      return;
    }
    const clash = conflictMessage(action, combo, shortcuts, masterOn);
    if (clash) {
      setRejected((prev) => ({ ...prev, [action]: combo }));
      return;
    }
    forget();
    void persistShortcut(action, { combo });
  };

  const handleMasterChange = (enabled: boolean): void => {
    setPendingMaster(enabled);
    void invoke("set_global_shortcuts_enabled", { enabled })
      .catch((e) => {
        setPendingMaster(null);
        toast("error", `Could not update global shortcuts: ${errorMessage(e)}`);
      });
  };

  const masterStatus = (() => {
    if (master === null && pendingMaster === null) {
      return { text: "Loading settings…", className: "text-text-3" };
    }
    if (!masterOn) return { text: "Disabled", className: "text-text-3" };
    if (!status.ready) return { text: "Checking registration…", className: "text-text-3" };
    if (status.firstError) {
      return { text: `Not registered — ${status.firstError}`, className: "text-warn" };
    }
    return { text: `${status.registeredCount} registered`, className: "text-ok" };
  })();

  return (
    <>
      <PageHeader
        title="Shortcuts"
        description="OS-wide hotkeys that work in any app. Two actions, independently configured."
      />
      <div className="flex flex-col gap-6">
        <SectionCard>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[15px] font-medium text-text">Global shortcuts</p>
              <p className={`mt-1 text-xs ${masterStatus.className}`}>{masterStatus.text}</p>
            </div>
            <Switch
              label="Global shortcuts"
              checked={masterOn}
              disabled={master === null && pendingMaster === null}
              busy={pendingMaster !== null}
              onChange={handleMasterChange}
            />
          </div>
        </SectionCard>
        {shortcuts ? (
          ACTION_ORDER.map((action) => {
            const view = resolveShortcutView(shortcuts[action], pending[action]);
            const rejectedCombo = rejected[action];
            const conflict =
              rejectedCombo !== undefined
                ? conflictMessage(action, rejectedCombo, shortcuts, masterOn)
                : null;
            return (
              <ShortcutCard
                key={action}
                action={action}
                combo={view.combo}
                trigger={view.trigger}
                enabled={view.enabled}
                status={status.actions[action]}
                ready={status.ready}
                masterOff={masterOff}
                conflict={conflict}
                busy={pending[action] !== undefined}
                onComboChange={handleComboChange}
                onTriggerChange={(target, next) => void persistShortcut(target, { trigger: next })}
                onEnabledChange={(target, next) => void persistShortcut(target, { enabled: next })}
              />
            );
          })
        ) : (
          <p className="text-[13px] text-text-3">Loading settings…</p>
        )}
      </div>
    </>
  );
}