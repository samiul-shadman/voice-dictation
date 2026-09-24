import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Badge, Button, PageHeader, SegmentedControl, toast } from "../components/ui";
import { recordingStyles, transcriptionStyles } from "../lib/animations/registry";
import type { RecordingStyleEntry, TranscriptionStyleEntry } from "../lib/animations/registry";
import { useIndicatorStyles } from "../lib/stores/settings";

type Tab = "recording" | "transcription";

const TAB_STORAGE_KEY = "animations.tab";
const PREVIEW_LEVEL = { "--voice-level": 0.6 } as CSSProperties;

const TAB_OPTIONS = [
  { value: "recording", label: "Recording" },
  { value: "transcription", label: "Transcription" },
] as const;

function readStoredTab(): Tab {
  try {
    return localStorage.getItem(TAB_STORAGE_KEY) === "transcription" ? "transcription" : "recording";
  } catch {
    return "recording";
  }
}

function storeTab(tab: Tab): void {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // localStorage unavailable (private mode); tab preference is non-essential
  }
}

function renderPreview(
  tab: Tab,
  entry: RecordingStyleEntry | TranscriptionStyleEntry,
  mockElapsed: number,
  mockPercent: number,
): ReactNode {
  if (tab === "recording") {
    return (entry as RecordingStyleEntry).render({ elapsed: mockElapsed, level: 0.6 });
  }
  return (entry as TranscriptionStyleEntry).render({ percent: mockPercent });
}

export function AnimationsPage() {
  const indicatorStyles = useIndicatorStyles();
  const [tab, setTab] = useState<Tab>(readStoredTab);
  const [mockElapsed, setMockElapsed] = useState(0);
  const [mockPercent, setMockPercent] = useState(12);

  useEffect(() => {
    const clock = window.setInterval(() => setMockElapsed((e) => e + 0.5), 500);
    const percents = [100, 4, 12];
    let idx = 0;
    const progress = window.setInterval(() => {
      setMockPercent(percents[idx]);
      idx = (idx + 1) % percents.length;
    }, 450);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(progress);
    };
  }, []);

  const handleTab = (next: Tab): void => {
    setTab(next);
    storeTab(next);
  };

  const applyStyle = async (kind: Tab, entry: { id: string; name: string }): Promise<void> => {
    try {
      await invoke("set_indicator_style", { kind, id: entry.id });
      await emit("indicator-style-changed", { kind, id: entry.id });
      toast("success", `${entry.name} set for ${kind === "recording" ? "recording" : "transcription"}.`);
    } catch (e) {
      toast("error", `Could not set ${kind} style: ${String(e)}`);
    }
  };

  const entries: Array<RecordingStyleEntry | TranscriptionStyleEntry> =
    tab === "recording" ? recordingStyles : transcriptionStyles;

  return (
    <>
      <PageHeader
        title="Animations"
        description="Pick the look of the indicator pills while recording and transcribing."
      />
      <SegmentedControl
        options={TAB_OPTIONS}
        value={tab}
        onChange={handleTab}
        ariaLabel="Style kind"
        className="mb-5 self-start"
      />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
        {entries.map((entry) => {
          const inUse =
            tab === "recording"
              ? indicatorStyles?.recordingStyle === entry.id
              : indicatorStyles?.transcriptionStyle === entry.id;
          return (
            <section
              key={entry.id}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
            >
              <div
                aria-hidden
                className="flex h-16 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-2 px-3"
                style={tab === "recording" ? PREVIEW_LEVEL : undefined}
              >
                {renderPreview(tab, entry, mockElapsed, mockPercent)}
              </div>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[14px] font-medium text-text">{entry.name}</h2>
                {inUse && <Badge kind="success">In use</Badge>}
              </div>
              <p className="text-[13px] leading-snug text-text-2">{entry.desc}</p>
              <Button
                variant={inUse ? "secondary" : "primary"}
                size="sm"
                disabled={inUse}
                className="mt-auto w-full"
                onClick={() => void applyStyle(tab, entry)}
              >
                {inUse
                  ? "In use"
                  : tab === "recording"
                    ? "Use for recording"
                    : "Use for transcription"}
              </Button>
            </section>
          );
        })}
      </div>
    </>
  );
}
