import { useEffect, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import RecordingPill from "../components/feature/RecordingPill";
import { useIndicatorStyles } from "../lib/stores/settings";

const COMPACT_CSS = `
:root[data-window="recording-indicator"] .glass-pill {
  padding: 9px 14px;
}
`;

interface LiveStyleIds {
  recording: string | null;
  transcription: string | null;
}

export function RecordingIndicatorPage() {
  const styles = useIndicatorStyles();
  const [live, setLive] = useState<LiveStyleIds>({ recording: null, transcription: null });

  useEffect(() => {
    void (async () => {
      try {
        await emitTo("main", "overlay-ready", { label: "recording-indicator" });
      } catch {
        // best-effort handshake; main may not be listening yet
      }
    })();
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const fn = await listen<{ kind: string; id: string }>("indicator-style-changed", (e) => {
          setLive((prev) => ({
            recording: e.payload.kind === "recording" ? e.payload.id : prev.recording,
            transcription: e.payload.kind === "transcription" ? e.payload.id : prev.transcription,
          }));
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch (e) {
        console.error("[recording-indicator] indicator-style-changed listener failed", e);
      }
    })();
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  return (
    <div className="flex h-screen items-center justify-center p-3">
      <style>{COMPACT_CSS}</style>
      <RecordingPill
        recordingStyleId={live.recording ?? styles?.recordingStyle}
        transcriptionStyleId={live.transcription ?? styles?.transcriptionStyle}
      />
    </div>
  );
}
