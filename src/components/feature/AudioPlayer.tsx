import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Spinner } from "../ui";
import {
  base64DataUrl,
  claimExclusivePlayback,
  getCachedRecordingBytes,
  loadRecordingUrl,
  unregisterPlayback,
} from "../../lib/audioPlayback";
import type { RecordingMeta } from "../../lib/stores/recorder";

export interface AudioPlayerProps {
  path: string;
  meta?: RecordingMeta;
  format?: "mp3" | "wav";
}

type PlayerStatus = "idle" | "loading" | "playing" | "error";

function mimeForFormat(format: "mp3" | "wav" | undefined, path: string): string {
  if (format === "wav" || (!format && path.toLowerCase().endsWith(".wav"))) return "audio/wav";
  return "audio/mpeg";
}

export default function AudioPlayer({ path, meta, format }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const loadedUrl = useRef<string | null>(null);
  const fallbackTried = useRef(false);
  const disposed = useRef(false);
  const [status, setStatus] = useState<PlayerStatus>("idle");

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      const el = audioRef.current;
      if (el) {
        el.pause();
        unregisterPlayback(el);
      }
    };
  }, [path]);

  const handlePlay = async (): Promise<void> => {
    const el = audioRef.current;
    if (!el || status === "loading") return;
    setStatus("loading");
    try {
      const url = await loadRecordingUrl(path);
      if (disposed.current) return;
      if (loadedUrl.current !== url) {
        loadedUrl.current = url;
        fallbackTried.current = false;
        el.src = url;
      }
      claimExclusivePlayback(el, path);
      await el.play();
      if (disposed.current) {
        el.pause();
        return;
      }
      setStatus("playing");
    } catch {
      if (!disposed.current) setStatus("error");
    }
  };

  const handleStop = (): void => {
    const el = audioRef.current;
    if (el) el.pause();
  };

  const handlePause = (): void => {
    const el = audioRef.current;
    if (el) unregisterPlayback(el);
    if (!disposed.current) setStatus("idle");
  };

  const handleError = (): void => {
    const el = audioRef.current;
    if (!el || disposed.current) return;
    if (fallbackTried.current) {
      setStatus("error");
      return;
    }
    const bytes = getCachedRecordingBytes(path);
    if (!bytes) {
      setStatus("error");
      return;
    }
    fallbackTried.current = true;
    const url = base64DataUrl(bytes, mimeForFormat(format, path));
    loadedUrl.current = url;
    el.src = url;
    void el
      .play()
      .then(() => {
        if (!disposed.current) setStatus("playing");
      })
      .catch(() => {
        if (!disposed.current) setStatus("error");
      });
  };

  const label = `${status === "playing" ? "Pause" : "Play"} ${meta?.name ?? "recording"}`;

  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={status === "error" ? "Could not load audio — click to retry" : label}
        disabled={status === "loading"}
        onClick={() => void (status === "playing" ? handleStop() : handlePlay())}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 text-text-2 transition-colors duration-150 hover:border-border-strong hover:text-text disabled:pointer-events-none disabled:opacity-50"
      >
        {status === "loading" ? (
          <Spinner size={16} />
        ) : status === "playing" ? (
          <Pause size={16} strokeWidth={1.75} />
        ) : (
          <Play size={16} strokeWidth={1.75} />
        )}
      </button>
      <audio
        ref={audioRef}
        className="hidden"
        onPause={handlePause}
        onEnded={handlePause}
        onError={handleError}
      />
    </>
  );
}
