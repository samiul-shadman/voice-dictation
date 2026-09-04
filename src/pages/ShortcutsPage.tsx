import { useState } from "react";
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
import { canonicalCombo } from "../lib/shortcuts/canonical";
import type { ActionId, Trigger } from "../lib/shortcuts/canonical";
import { useShortcutStatus } from "../lib/shortcuts/engine";
import type { ShortcutStatusEntry } from "../lib/shortcuts/engine";
import { useGlobalShortcutsEnabled, useShortcutConfig } from "../lib/stores/settings";
import type { ShortcutConfig } from "../lib/stores/settings";

const ACTION_ORDER: ActionId[] = ["voiceNote", "record"];

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

async function persistShortcut(
  action: ActionId,
  patch: { combo?: string | null; trigger?: Trigger; enabled?: boolean },
): Promise<void> {
  try {
    await invoke("set_shortcut", {
      action,
      combo: patch.combo ?? null,
      trigger: patch.trigger ?? null,
      enabled: patch.enabled ?? null,
    });
  } catch (e) {
    toast("error", `Could not update shortcut: ${errorMessage(e)}`);
  }
}

interface ShortcutCardProps {
  action: ActionId;
  config: ShortcutConfig;
  status: ShortcutStatusEntry;
  masterOff: boolean;
  fieldError: string | null;
  onComboChange: (action: ActionId, combo: string | null) => void;
  onTriggerChange: (action: ActionId, trigger: Trigger) => void;
  onEnabledChange: (action: ActionId, enabled: boolean) => void;
}

function ShortcutCard({
  action,
  config,
  status,
  masterOff,
  fieldError,
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
      <div className={masterOff ? "pointer-events-none opacity-50" : undefined}>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="min-w-[220px] flex-1">
            <KeyInput
              action={action}
              value={config.combo}
              error={fieldError}
              disabled={masterOff}
              onChange={(combo) => onComboChange(action, combo)}
            />
          </div>
          <SegmentedControl
            options={TRIGGER_OPTIONS}
            value={config.trigger}
            onChange={(trigger) => onTriggerChange(action, trigger)}
            ariaLabel={`${meta.name} trigger`}
            className="w-[170px]"
          />
          <Switch
            label={`${meta.name} shortcut enabled`}
            checked={config.enabled}
            disabled={masterOff}
            onChange={(enabled) => onEnabledChange(action, enabled)}
          />
        </div>
        <p className="mt-2 text-xs text-text-3">{TRIGGER_HINTS[config.trigger]}</p>
      </div>
      <p className={`mt-1.5 text-xs ${line.className}`}>{line.text}</p>
    </SectionCard>
  );
}

export function ShortcutsPage() {
  const shortcuts = useShortcutConfig();
  const master = useGlobalShortcutsEnabled();
  const status = useShortcutStatus();
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ActionId, string>>>({});

  const masterOff = master !== true;

  const setFieldError = (action: ActionId, message: string | null): void => {
    setFieldErrors((prev) => {
      const next = { ...prev };
      if (message === null) delete next[action];
      else next[action] = message;
      return next;
    });
  };

  const handleComboChange = (action: ActionId, combo: string | null): void => {
    if (combo === null) {
      setFieldError(action, null);
      void persistShortcut(action, { combo: "" });
      return;
    }
    const other = ACTION_ORDER.find((candidate) => candidate !== action);
    const otherCombo =
      other && shortcuts ? shortcuts[other].combo : null;
    if (otherCombo && canonicalCombo(otherCombo) === combo) {
      setFieldError(action, `Already used by ${ACTION_META[other ?? action].name}`);
      return;
    }
    setFieldError(action, null);
    void persistShortcut(action, { combo });
  };

  const masterStatus = (() => {
    if (master === null) return { text: "Loading settings…", className: "text-text-3" };
    if (!master) return { text: "Disabled", className: "text-text-3" };
    if (status.firstError) return { text: status.firstError, className: "text-warn" };
    return {
      text: `${status.registeredCount} registered`,
      className: "text-ok",
    };
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
              checked={master === true}
              disabled={master === null}
              onChange={(enabled) => {
                void invoke("set_global_shortcuts_enabled", { enabled }).catch((e) => {
                  toast("error", `Could not update global shortcuts: ${errorMessage(e)}`);
                });
              }}
            />
          </div>
        </SectionCard>
        {shortcuts ? (
          ACTION_ORDER.map((action) => (
            <ShortcutCard
              key={action}
              action={action}
              config={shortcuts[action]}
              status={status.actions[action]}
              masterOff={masterOff}
              fieldError={fieldErrors[action] ?? null}
              onComboChange={handleComboChange}
              onTriggerChange={(target, trigger) => void persistShortcut(target, { trigger })}
              onEnabledChange={(target, enabled) => void persistShortcut(target, { enabled })}
            />
          ))
        ) : (
          <p className="text-[13px] text-text-3">Loading settings…</p>
        )}
      </div>
    </>
  );
}
