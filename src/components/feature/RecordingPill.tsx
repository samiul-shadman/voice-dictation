import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getRecordingStyle, getTranscriptionStyle } from "../../lib/animations/registry";
import { getLevel, useLevel } from "../../lib/stores/levels";
import { useRecording } from "../../lib/stores/recorder";
import { useIndicatorStyles } from "../../lib/stores/settings";
import { useTranscriber } from "../../lib/stores/transcriber";

interface RecordingPillProps {
  recordingStyleId?: string;
  transcriptionStyleId?: string;
}

export default function RecordingPill({ recordingStyleId, transcriptionStyleId }: RecordingPillProps) {
  const recorder = useRecording();
  const transcriber = useTranscriber();
  const level = useLevel();
  const styles = useIndicatorStyles();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const prevRecordingRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const phase: "recording" | "transcribing" | "idle" = transcriber.busy
    ? "transcribing"
    : recorder.recording
      ? "recording"
      : "idle";

  useEffect(() => {
    if (recorder.recording && !prevRecordingRef.current) {
      startedAtRef.current = Date.now();
      setElapsed(0);
    }
    if (!recorder.recording && prevRecordingRef.current) {
      startedAtRef.current = null;
      setElapsed(0);
    }
    prevRecordingRef.current = recorder.recording;
  }, [recorder.recording]);

  useEffect(() => {
    if (!recorder.recording) return;
    const tick = () => {
      const startedAt = startedAtRef.current;
      if (startedAt != null) setElapsed(Math.max(0, (Date.now() - startedAt) / 1000));
    };
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [recorder.recording]);

  useEffect(() => {
    if (phase === "idle") return;
    let raf = 0;
    let lastWrite = 0;
    const loop = (time: number) => {
      if (time - lastWrite >= 50) {
        lastWrite = time;
        rootRef.current?.style.setProperty("--voice-level", String(getLevel()));
      }
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, [phase]);

  if (phase === "idle") return null;

  const recordingId = recordingStyleId ?? styles?.recordingStyle ?? "classic";
  const transcriptionId = transcriptionStyleId ?? styles?.transcriptionStyle ?? "classic";

  return (
    <div
      ref={rootRef}
      className="glass-pill pop-in flex items-center px-4 py-2.5"
      style={{ "--voice-level": level } as CSSProperties}
    >
      {phase === "recording"
        ? getRecordingStyle(recordingId).render({ elapsed, level })
        : getTranscriptionStyle(transcriptionId).render({ percent: transcriber.percent })}
    </div>
  );
}
