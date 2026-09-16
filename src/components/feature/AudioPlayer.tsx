import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import { Spinner } from "../ui";
import { fmtClock } from "../../lib/format";
import {
  base64DataUrl,
  claimExclusivePlayback,
  clampTime,
  getCachedRecordingBytes,
  loadRecordingUrl,
  nextSpeed,
  unregisterPlayback,
} from "../../lib/audioPlayback";
import type { RecordingMeta } from "../../lib/stores/recorder";

export interface AudioPlayerProps {
  path: string;
  meta?: RecordingMeta;
  format?: "mp3" | "wav";
  children?: ReactNode;
}

type PlayerStatus = "idle" | "loading" | "playing" | "error";

function mimeForFormat(format: "mp3" | "wav" | undefined, path: string): string {
  if (format === "wav" || (!format && path.toLowerCase().endsWith(".wav"))) return "audio/wav";
  return "audio/mpeg";
}

interface SeekBarProps {
  value: number;
  max: number;
  disabled: boolean;
  label: string;
  onSeek: (seconds: number) => void;
}

function SeekBar({ value, max, disabled, label, onSeek }: SeekBarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragValue, setDragValue] = useState(0);

  const shown = dragging ? dragValue : value;
  const pct = max > 0 ? Math.max(0, Math.min(100, (shown / max) * 100)) : 0;

  const valueFromClientX = (clientX: number): number => {
    const track = trackRef.current;
    if (!track || max <= 0) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(1, ratio)) * max;
  };

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    setDragValue(valueFromClientX(e.clientX));
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    setDragValue(valueFromClientX(e.clientX));
  };

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    const next = valueFromClientX(e.clientX);
    setDragging(false);
    onSeek(next);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const step = max > 0 ? Math.max(1, max / 20) : 5;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = value + step;
    else if (e.key === "ArrowLeft") next = value - step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    onSeek(next);
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(shown)}
      aria-disabled={disabled}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onKeyDown={handleKeyDown}
      className={`group relative flex h-4 min-w-0 flex-1 items-center ${
        disabled ? "cursor-default" : "cursor-pointer"
      }`}
    >
      <div className="h-1.5 w-full overflow-hidden rounded-pill bg-border-strong">
        <div
          className="h-full rounded-pill bg-accent transition-[width] duration-100 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
      {!disabled && (
        <span
          aria-hidden
          className={`pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full border border-bg bg-accent-strong shadow-rest transition-opacity duration-150 ${
            dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
          }`}
          style={{ left: `${pct}%` }}
        />
      )}
    </div>
  );
}

export default function AudioPlayer({ path, meta, format, children }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const loadedUrl = useRef<string | null>(null);
  const fallbackTried = useRef(false);
  const pendingSeek = useRef<number | null>(null);
  const disposed = useRef(false);
  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(meta?.durationSecs ?? 0);
  const [rate, setRate] = useState(1);

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

  const ensureUrl = async (): Promise<void> => {
    const el = audioRef.current;
    if (!el) return;
    const url = await loadRecordingUrl(path);
    if (loadedUrl.current !== url) {
      loadedUrl.current = url;
      fallbackTried.current = false;
      el.src = url;
    }
  };

  const handlePlay = async (): Promise<void> => {
    const el = audioRef.current;
    if (!el || status === "loading") return;
    setStatus("loading");
    try {
      await ensureUrl();
      if (disposed.current) return;
      el.playbackRate = rate;
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

  const handleEnded = (): void => {
    const el = audioRef.current;
    if (el) el.currentTime = 0;
    if (!disposed.current) setCurrent(0);
    handlePause();
  };

  const handleLoadedMetadata = (): void => {
    const el = audioRef.current;
    if (!el) return;
    if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration);
    el.playbackRate = rate;
    if (pendingSeek.current !== null) {
      el.currentTime = clampTime(pendingSeek.current, el.duration);
      pendingSeek.current = null;
    }
  };

  const handleTimeUpdate = (): void => {
    const el = audioRef.current;
    if (!el || disposed.current) return;
    setCurrent(el.currentTime);
  };

  const handleSeek = (seconds: number): void => {
    const el = audioRef.current;
    const target = clampTime(seconds, duration);
    setCurrent(target);
    if (el && loadedUrl.current && el.readyState >= 1) {
      el.currentTime = target;
      return;
    }
    pendingSeek.current = target;
    void ensureUrl();
  };

  const handleCycleSpeed = (): void => {
    const next = nextSpeed(rate);
    setRate(next);
    const el = audioRef.current;
    if (el) el.playbackRate = next;
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
  const seekable = duration > 0;

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
      <div className="min-w-0 flex-1">
        {children}
        {status === "error" ? (
          <p className="mt-1.5 text-xs text-err">Couldn’t load audio — press play to retry.</p>
        ) : (
          <div className="mt-1.5 flex items-center gap-2">
            <SeekBar
              value={current}
              max={duration}
              disabled={!seekable}
              label={`Seek ${meta?.name ?? "recording"}`}
              onSeek={handleSeek}
            />
            <span className="shrink-0 font-mono text-xs tabular-nums text-text-3">
              {fmtClock(current)} / {fmtClock(duration)}
            </span>
            <button
              type="button"
              onClick={handleCycleSpeed}
              aria-label={`Playback speed ${rate}x`}
              title="Playback speed"
              className="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-xs tabular-nums text-text-3 transition-colors duration-150 hover:bg-surface-2 hover:text-text"
            >
              {rate}×
            </button>
          </div>
        )}
      </div>
      <audio
        ref={audioRef}
        className="hidden"
        onLoadedMetadata={handleLoadedMetadata}
        onDurationChange={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onPause={handlePause}
        onEnded={handleEnded}
        onError={handleError}
      />
    </>
  );
}
