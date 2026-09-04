import { useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { Kbd } from "../components/ui";
import { humanize } from "../lib/shortcuts/canonical";
import type { ActionId, Trigger } from "../lib/shortcuts/canonical";
import { useRecording } from "../lib/stores/recorder";
import { useTranscriber } from "../lib/stores/transcriber";

interface ArmedPayload {
  combo: string;
  action: ActionId;
  trigger: Trigger;
}

const TOGGLE_FLASH_MS = 1200;
const POP_OUT_MS = 190;

const ACTION_LABELS: Record<ActionId, string> = {
  voiceNote: "Voice note",
  record: "Record",
};

const PILL_CSS = `
@keyframes indicator-pulse { 50% { opacity: 0.35; } }
.indicator-dot { animation: indicator-pulse 1.1s ease-in-out infinite; }
@keyframes indicator-pop-out {
  from { opacity: 1; transform: scale(1); }
  to { opacity: 0; transform: scale(0.96); }
}
.indicator-pop-out { animation: indicator-pop-out 180ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards; }
`;

export function IndicatorPage() {
  const recorder = useRecording();
  const transcriber = useTranscriber();
  const [shown, setShown] = useState<ArmedPayload | null>(null);
  const [leaving, setLeaving] = useState<ArmedPayload | null>(null);
  const shownRef = useRef<ArmedPayload | null>(null);
  const toggleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = (): void => {
    if (toggleTimer.current) {
      clearTimeout(toggleTimer.current);
      toggleTimer.current = null;
    }
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  const hideNow = (): void => {
    const current = shownRef.current;
    clearTimers();
    shownRef.current = null;
    setShown(null);
    if (current) {
      setLeaving(current);
      leaveTimer.current = setTimeout(() => {
        leaveTimer.current = null;
        setLeaving(null);
      }, POP_OUT_MS);
    }
  };

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      try {
        const offArmed = await listen<ArmedPayload>("shortcut-armed", (e) => {
          if (disposed) return;
          if (leaveTimer.current) {
            clearTimeout(leaveTimer.current);
            leaveTimer.current = null;
          }
          setLeaving(null);
          shownRef.current = e.payload;
          setShown(e.payload);
          if (e.payload.trigger === "toggle") {
            if (toggleTimer.current) clearTimeout(toggleTimer.current);
            toggleTimer.current = setTimeout(() => {
              toggleTimer.current = null;
              hideNow();
            }, TOGGLE_FLASH_MS);
          }
        });
        if (disposed) {
          offArmed();
          return;
        }
        unlisteners.push(offArmed);
        const offDisarmed = await listen<{ combo: string }>("shortcut-disarmed", () => {
          if (disposed) return;
          if (shownRef.current?.trigger === "hold") hideNow();
        });
        if (disposed) {
          offDisarmed();
          return;
        }
        unlisteners.push(offDisarmed);
        await emitTo("main", "overlay-ready", { label: "indicator" });
      } catch {}
    })();
    return () => {
      disposed = true;
      for (const off of unlisteners) off();
      clearTimers();
    };
  }, []);

  const busy = recorder.recording || transcriber.busy;
  const pill = busy ? null : (shown ?? leaving);

  return (
    <div className="flex h-screen items-center justify-center p-3">
      <style>{PILL_CSS}</style>
      {pill && (
        <div
          key={`${pill.combo}|${pill.action}|${leaving ? "out" : "in"}`}
          className={`glass-pill flex max-w-full items-center gap-2.5 px-4 py-2 ${
            leaving ? "indicator-pop-out" : "pop-in"
          }`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {humanize(pill.combo)
              .split(" + ")
              .filter((chip) => chip.length > 0)
              .map((chip, i) => (
                <span key={`${chip}-${i}`} className="flex items-center gap-1.5">
                  {i > 0 && <span className="text-[11px] text-text-3">+</span>}
                  <Kbd>{chip}</Kbd>
                </span>
              ))}
          </span>
          <span className="whitespace-nowrap text-[13px] font-medium text-text-2">
            {ACTION_LABELS[pill.action]}
          </span>
          <span aria-hidden className="indicator-dot h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        </div>
      )}
    </div>
  );
}
