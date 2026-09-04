import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Mic, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  PageHeader,
  Progress,
  Spinner,
  Tooltip,
  toast,
} from "../components/ui";
import AudioPlayer from "../components/feature/AudioPlayer";
import TranscriptPanel from "../components/feature/TranscriptPanel";
import { fmtClock, humanRelativeTime, humanSize } from "../lib/format";
import { forgetAllRecordingUrls, forgetRecordingUrl, pausePath } from "../lib/audioPlayback";
import {
  deleteRecording,
  listRecordings,
  useRecording,
} from "../lib/stores/recorder";
import type { RecordingMeta } from "../lib/stores/recorder";
import { useAudioPrefs } from "../lib/stores/settings";
import { onTranscribeComplete, onTranscribeError, transcribeFile, useTranscriber } from "../lib/stores/transcriber";

function friendly(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

function TranscribeCell({ meta }: { meta: RecordingMeta }) {
  const transcriber = useTranscriber();
  const recorder = useRecording();
  const active = transcriber.busy && transcriber.activePath === meta.path;
  const disabled = transcriber.busy || recorder.recording;

  if (active) {
    return <Progress value={transcriber.percent} showPercent className="w-28 shrink-0" />;
  }

  const start = async (): Promise<void> => {
    try {
      await transcribeFile(meta.path, false);
    } catch (e) {
      toast("error", friendly(e));
    }
  };

  return (
    <Button
      variant="secondary"
      size="sm"
      className="shrink-0"
      disabled={disabled}
      onClick={() => void start()}
      title={disabled ? "Wait for the current activity to finish" : undefined}
    >
      Transcribe
    </Button>
  );
}

export function LibraryPage() {
  const audioPrefs = useAudioPrefs();
  const audioDir = audioPrefs?.audioDir;
  const recorder = useRecording();
  const [recordings, setRecordings] = useState<RecordingMeta[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RecordingMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
  const wasRecording = useRef(false);
  const prevDir = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listRecordings();
      setRecordings(list);
      setLoadError(null);
    } catch (e) {
      setRecordings((prev) => prev ?? []);
      setLoadError(friendly(e));
    }
  }, []);

  useEffect(() => {
    if (audioDir == null) return;
    if (prevDir.current !== null && prevDir.current !== audioDir) {
      forgetAllRecordingUrls();
    }
    prevDir.current = audioDir;
    void refresh();
  }, [audioDir, refresh]);

  useEffect(() => {
    if (wasRecording.current && !recorder.recording) void refresh();
    wasRecording.current = recorder.recording;
  }, [recorder.recording, refresh]);

  useEffect(
    () =>
      onTranscribeComplete(() => {
        void refresh();
      }),
    [refresh],
  );

  useEffect(
    () =>
      onTranscribeError((payload) => {
        toast("error", `Transcription failed — ${payload.message}`);
      }),
    [],
  );

  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget;
    if (!target) return;
    setDeleting(true);
    try {
      pausePath(target.path);
      await deleteRecording(target.path);
      forgetRecordingUrl(target.path);
      setDeleteTarget(null);
      setExpanded((current) => (current === target.path ? null : current));
      await refresh();
    } catch (e) {
      toast("error", `Could not delete ${target.name} — ${friendly(e)}`);
    } finally {
      setDeleting(false);
    }
  };

  const totalSize = recordings ? recordings.reduce((sum, m) => sum + m.size, 0) : 0;
  const count = recordings?.length ?? 0;

  return (
    <>
      <PageHeader
        title="Library"
        description="Every recording, with transcript, playback and safe delete."
      />
      <div className="mb-4 flex items-center gap-3 text-[13px] text-text-2">
        <span>
          {count} {count === 1 ? "recording" : "recordings"}
        </span>
        <span aria-hidden className="text-text-3">
          ·
        </span>
        <span className="font-mono tabular-nums">{humanSize(totalSize)}</span>
        {audioDir && (
          <span
            className="ml-auto min-w-0 truncate font-mono text-xs text-text-3"
            title={audioDir}
          >
            {audioDir}
          </span>
        )}
      </div>

      {recordings === null ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-text-3">
          <Spinner size={16} />
          <span>Loading recordings…</span>
        </div>
      ) : loadError && recordings.length === 0 ? (
        <EmptyState
          icon={<Mic size={24} strokeWidth={1.75} />}
          title="Could not load recordings"
          hint={loadError}
          action={
            <Button variant="secondary" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        />
      ) : recordings.length === 0 ? (
        <EmptyState
          icon={<Mic size={24} strokeWidth={1.75} />}
          title="No recordings yet"
          hint="Hold your voice-note hotkey anywhere — or press Record on the Record page."
          action={
            <Link to="/record">
              <Button variant="primary">Go to Record</Button>
            </Link>
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {recordings.map((meta) => {
            const hasTranscript = meta.hasTranscript;
            const isExpanded = expanded === meta.path;
            const rowBody = (
              <>
                <span
                  className={`min-w-0 truncate text-[13px] font-medium ${
                    hasTranscript ? "text-text" : "text-text-2"
                  }`}
                >
                  {meta.name}
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-text-3">
                  <Badge>{meta.format.toUpperCase()}</Badge>
                  <span className="font-mono tabular-nums">{fmtClock(meta.durationSecs ?? NaN)}</span>
                  <span>{humanSize(meta.size)}</span>
                  <span>{humanRelativeTime(meta.modified)}</span>
                </span>
              </>
            );
            return (
              <li key={meta.path}>
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <AudioPlayer path={meta.path} meta={meta} format={meta.format} />
                  {hasTranscript ? (
                    <button
                      type="button"
                      onClick={() => setExpanded(isExpanded ? null : meta.path)}
                      aria-expanded={isExpanded}
                      className="min-w-0 flex-1 text-left"
                    >
                      {rowBody}
                    </button>
                  ) : (
                    <div className="min-w-0 flex-1">{rowBody}</div>
                  )}
                  {hasTranscript ? (
                    <Badge kind="success" className="shrink-0">
                      Transcript
                    </Badge>
                  ) : (
                    <TranscribeCell meta={meta} />
                  )}
                  <Tooltip label="Delete recording" side="left">
                    <IconButton
                      label={`Delete ${meta.name}`}
                      className="shrink-0 hover:text-err"
                      onClick={() => setDeleteTarget(meta)}
                    >
                      <Trash2 size={16} strokeWidth={1.75} />
                    </IconButton>
                  </Tooltip>
                </div>
                {isExpanded && hasTranscript && (
                  <div className="px-3 pb-3">
                    <TranscriptPanel path={meta.path} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        title="Delete recording?"
        description={`Delete ${deleteTarget?.name ?? "this recording"} and its transcript? This cannot be undone.`}
        destructive
        actions={
          <>
            <Button variant="ghost" disabled={deleting} onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleting} onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </>
        }
      />
    </>
  );
}
