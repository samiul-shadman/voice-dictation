import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Keyboard, Mic, TriangleAlert } from "lucide-react";
import { Button, PageHeader, SectionCard, SegmentedControl, toast } from "../components/ui";
import RecordingButton from "../components/feature/RecordingButton";
import { humanDuration, humanSize } from "../lib/format";
import { useLevel } from "../lib/stores/levels";
import {
  defaultRecordingsDir,
  toggleRecording,
  useRecording,
} from "../lib/stores/recorder";
import type { RecordingMeta } from "../lib/stores/recorder";
import { useAudioPrefs, useSettings, useShortcutConfig } from "../lib/stores/settings";
import type { AudioFormat } from "../lib/stores/settings";
import { useEnvInfo } from "../lib/stores/env";

function setupHint(env: { platform: string; micAvailable: boolean; accessibilityPermission: boolean | null } | null): string | null {
  if (!env) return null;
  if (!env.micAvailable) {
    if (env.platform === "macos") {
      return "No microphone is available — allow microphone access in System Settings → Privacy & Security → Microphone.";
    }
    if (env.platform === "windows") {
      return "No microphone is available — check that a microphone is connected and enabled in Sound settings.";
    }
    return "No microphone is available — check that a microphone is connected and PulseAudio or PipeWire is running.";
  }
  return null;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "/";
}

function friendly(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

async function anyModelDownloaded(): Promise<boolean> {
  try {
    const models = await invoke<unknown[]>("list_models");
    return models.some((m) => {
      if (typeof m !== "object" || m === null) return false;
      const entry = m as Record<string, unknown>;
      return entry.downloaded === true || entry.isDownloaded === true || entry.is_downloaded === true;
    });
  } catch {
    return false;
  }
}

export function RecordPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const level = useLevel();
  const recorder = useRecording();
  const env = useEnvInfo();
  const shortcuts = useShortcutConfig();
  const settings = useSettings();
  const audioPrefs = useAudioPrefs();
  const [modelsReady, setModelsReady] = useState<boolean | null>(null);

  useEffect(() => {
    void anyModelDownloaded().then(setModelsReady);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const frame = requestAnimationFrame(() => {
      root.style.setProperty("--voice-level", level.toFixed(3));
    });
    return () => cancelAnimationFrame(frame);
  }, [level]);

  const handleStopped = useCallback((meta: RecordingMeta) => {
    toast(
      "success",
      `Saved ${meta.name} · ${humanDuration(meta.durationSecs)} · ${humanSize(meta.size)}`,
      {
        action: {
          label: "Reveal folder",
          onClick: () => {
            const dir = dirname(meta.path);
            void revealItemInDir(meta.path).catch(() => openPath(dir));
          },
        },
      },
    );
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          tag === "BUTTON" ||
          tag === "A" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      e.preventDefault();
      void (async () => {
        try {
          const meta = await toggleRecording();
          if (meta) handleStopped(meta);
        } catch (err) {
          toast("error", friendly(err));
        }
      })();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleStopped]);

  const setFormat = async (format: AudioFormat): Promise<void> => {
    try {
      await invoke("set_audio_format", { format });
    } catch (e) {
      toast("error", `Could not save the format — ${friendly(e)}`);
    }
  };

  const changeDir = async (): Promise<void> => {
    try {
      const dir = await open({ directory: true, defaultPath: audioPrefs?.audioDir });
      if (!dir) return;
      await invoke("set_audio_dir", { dir });
      toast("success", "Recordings folder updated");
    } catch (e) {
      toast("error", `Could not change the folder — ${friendly(e)}`);
    }
  };

  const resetDir = async (): Promise<void> => {
    try {
      const dir = await defaultRecordingsDir();
      await invoke("set_audio_dir", { dir });
      toast("success", "Using the default recordings folder");
    } catch (e) {
      toast("error", `Could not reset the folder — ${friendly(e)}`);
    }
  };

  const hint = setupHint(env);
  const showSetupCard = hint !== null;

  const shortcutMissing = shortcuts ? !shortcuts.voiceNote.combo : false;
  const showGettingStarted = shortcutMissing || modelsReady === false;

  return (
    <div ref={rootRef} className="mx-auto max-w-[680px]">
      <PageHeader
        title="Record"
        description="Hold the hotkey, speak, release — the transcript lands in the focused app."
      />
      <div className="flex flex-col gap-5">
        {showGettingStarted && (
          <SectionCard className="border-border">
            <div className="flex flex-col gap-2">
              <p className="text-[13px] font-medium text-text">Finish setup</p>
              {shortcutMissing && (
                <Link
                  to="/shortcuts"
                  className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-[13px] text-text-2 transition-colors duration-150 hover:border-border-strong hover:text-text"
                >
                  <Keyboard size={16} strokeWidth={1.75} className="text-accent" />
                  <span>Set a voice-note hotkey</span>
                  <span className="ml-auto text-text-3">Shortcuts →</span>
                </Link>
              )}
              {modelsReady === false && (
                <Link
                  to="/models"
                  className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-[13px] text-text-2 transition-colors duration-150 hover:border-border-strong hover:text-text"
                >
                  <Mic size={16} strokeWidth={1.75} className="text-accent" />
                  <span>Download a Parakeet model</span>
                  <span className="ml-auto text-text-3">Models →</span>
                </Link>
              )}
            </div>
          </SectionCard>
        )}

        {showSetupCard && (
          <SectionCard className="border-warn/40 bg-warn-soft">
            <div className="flex items-start gap-2.5">
              <TriangleAlert size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warn" />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium text-text">Audio setup incomplete</p>
                <p className="mt-1 text-[13px] text-text-2">{hint}</p>
              </div>
            </div>
          </SectionCard>
        )}

        <div className="flex justify-center py-4">
          <RecordingButton onStopped={handleStopped} />
        </div>

        <SectionCard title="Output">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-text">Format</p>
              <p className="mt-0.5 text-xs text-text-3">MP3 (192 kbps) or WAV (PCM 16-bit)</p>
            </div>
            <SegmentedControl
              options={
                [
                  { value: "mp3", label: "MP3" },
                  { value: "wav", label: "WAV" },
                ] as const
              }
              value={(audioPrefs?.audioFormat ?? "mp3") as AudioFormat}
              onChange={(next) => void setFormat(next)}
              ariaLabel="Recording format"
            />
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-text">Destination folder</p>
              <p
                className="mt-0.5 truncate font-mono text-xs text-text-3"
                title={audioPrefs?.audioDir}
              >
                {audioPrefs?.audioDir ?? "…"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" onClick={() => void changeDir()}>
                Change…
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void resetDir()}>
                Reset to default
              </Button>
            </div>
          </div>
        </SectionCard>

        <p className="text-center text-xs text-text-3">
          {recorder.recording
            ? "Recording — press Space or use Stop & save to finish."
            : settings
              ? `Files are saved to the folder above as ${settings.audioFormat.toUpperCase()}.`
              : "Loading settings…"}
        </p>
      </div>
    </div>
  );
}
