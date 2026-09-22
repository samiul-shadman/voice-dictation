import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, RotateCcw } from "lucide-react";
import { Button, Spinner, toast } from "../ui";
import { humanDuration, humanRelativeTime } from "../../lib/format";
import { useRecording } from "../../lib/stores/recorder";
import { onTranscribeComplete, transcribeFile, useTranscriber } from "../../lib/stores/transcriber";

export interface TranscriptPanelProps {
  path: string;
}

interface TranscriptRecord {
  audioPath: string;
  text: string;
  modelId: string;
  durationMs: number;
  createdAt: number;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(textarea);
    return ok;
  }
}

function readableError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export default function TranscriptPanel({ path }: TranscriptPanelProps) {
  const recorder = useRecording();
  const transcriber = useTranscriber();
  const [record, setRecord] = useState<TranscriptRecord | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (target: string) => {
    setStatus("loading");
    try {
      const next = await invoke<TranscriptRecord | null>("get_transcript", { path: target });
      setRecord(next);
      setStatus("ready");
    } catch (e) {
      setError(readableError(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load(path);
  }, [path, load]);

  useEffect(
    () =>
      onTranscribeComplete((payload) => {
        if (payload.path === path) void load(path);
      }),
    [path, load],
  );

  const active = transcriber.busy && transcriber.activePath === path;
  const busy = transcriber.busy || recorder.recording;

  const handleCopy = async (): Promise<void> => {
    if (!record?.text) return;
    const ok = await copyTextToClipboard(record.text);
    if (ok) toast("success", "Transcript copied to clipboard");
    else toast("error", "Could not copy the transcript");
  };

  const handleRetranscribe = async (): Promise<void> => {
    try {
      await transcribeFile(path, false);
    } catch (e) {
      console.error("[transcript] re-transcription failed", e);
    }
  };

  return (
    <div className="rounded-md border border-border bg-surface-2 px-4 py-3">
      {status === "loading" ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-text-3">
          <Spinner size={16} />
          <span>Loading transcript…</span>
        </div>
      ) : status === "error" ? (
        <p className="py-2 text-[13px] text-err">
          Could not load the transcript{error ? ` — ${error}` : "."}
        </p>
      ) : !record ? (
        <p className="py-2 text-[13px] text-text-3">No transcript yet</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-xs text-text-3">
              <span className="font-mono">{record.modelId}</span>
              {" · "}
              {humanDuration(record.durationMs / 1000)}
              {" · "}
              {humanRelativeTime(record.createdAt)}
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Copy size={14} strokeWidth={1.75} />}
                onClick={() => void handleCopy()}
              >
                Copy
              </Button>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<RotateCcw size={14} strokeWidth={1.75} />}
                disabled={busy}
                onClick={() => void handleRetranscribe()}
                title={active ? "Transcribing…" : undefined}
              >
                {active ? `Transcribing ${transcriber.percent}%` : "Re-transcribe"}
              </Button>
            </div>
          </div>
          <p className="mt-3 max-h-[240px] overflow-y-auto whitespace-pre-wrap font-mono text-[14px] leading-relaxed text-text-2">
            {record.text}
          </p>
        </>
      )}
    </div>
  );
}
