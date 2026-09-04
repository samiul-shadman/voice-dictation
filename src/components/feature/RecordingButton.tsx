import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Button, toast } from "../ui";
import {
  cancelRecording,
  toggleRecording,
  useRecording,
} from "../../lib/stores/recorder";
import type { RecordingMeta } from "../../lib/stores/recorder";
import { fmtClock } from "../../lib/format";

export interface RecordingButtonProps {
  onStopped?: (meta: RecordingMeta) => void;
}

export default function RecordingButton({ onStopped }: RecordingButtonProps) {
  const recorder = useRecording();
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const wasRecording = useRef(false);

  useEffect(() => {
    if (recorder.recording && !wasRecording.current) {
      setStartedAt(Date.now());
      setElapsed(0);
    }
    if (!recorder.recording && wasRecording.current) {
      setStartedAt(null);
    }
    wasRecording.current = recorder.recording;
  }, [recorder.recording]);

  useEffect(() => {
    if (!recorder.recording || startedAt === null) return;
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(Math.max(0, (Date.now() - startedAt) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [recorder.recording, startedAt]);

  const handleToggle = async (): Promise<void> => {
    if (busy || recorder.stopping) return;
    setBusy(true);
    try {
      const meta = await toggleRecording();
      if (meta) onStopped?.(meta);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async (): Promise<void> => {
    if (busy || recorder.stopping) return;
    setBusy(true);
    try {
      await cancelRecording();
    } finally {
      setBusy(false);
    }
  };

  if (!recorder.recording) {
    return (
      <div className="flex flex-col items-center gap-4">
        <button
          type="button"
          onClick={() => void handleToggle()}
          disabled={busy}
          aria-label="Start recording"
          className="inline-flex h-[72px] w-[72px] select-none flex-col items-center justify-center gap-0.5 rounded-full bg-accent font-medium text-white shadow-raised transition-colors duration-150 hover:bg-accent-strong active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60"
        >
          <Mic size={24} strokeWidth={1.75} />
          <span className="text-[11px] leading-none">Record</span>
        </button>
        <p className="text-[13px] text-text-3">
          Press Record — or hit Space while this page is focused.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-5">
      <div
        className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-rec-soft text-rec"
        style={{
          // ring + glow scale with --voice-level (written by the page);
          // all level-reactive sizing is calc() on the CSS var — no per-frame JS
          boxShadow:
            "0 0 0 calc(2px + var(--voice-level) * 10px) var(--rec-soft), 0 0 calc(14px + var(--voice-level) * 30px) calc(2px + var(--voice-level) * 6px) rgba(244, 63, 94, 0.28)",
        }}
      >
        <span className="font-mono text-[20px] tabular-nums leading-none">
          {fmtClock(elapsed)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          leftIcon={<Square size={14} strokeWidth={1.75} />}
          loading={recorder.stopping || busy}
          onClick={() => void handleToggle()}
        >
          Stop &amp; save
        </Button>
        <Button
          variant="ghost"
          className="text-err hover:bg-err-soft hover:text-err"
          disabled={recorder.stopping || busy}
          onClick={() => void handleDiscard()}
        >
          Discard
        </Button>
      </div>
    </div>
  );
}
