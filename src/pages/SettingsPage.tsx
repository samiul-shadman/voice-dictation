import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { CircleAlert, Copy, FolderOpen, RefreshCw } from "lucide-react";
import {
  Badge,
  Button,
  IconButton,
  PageHeader,
  RadioCardGroup,
  SectionCard,
  SegmentedControl,
  Tooltip,
  toast,
} from "../components/ui";
import type { BadgeKind } from "../components/ui/Badge";
import type { RadioCardOption } from "../components/ui/RadioCardGroup";
import { useAudioPrefs, usePasteMode, useSettings } from "../lib/stores/settings";
import type { PasteMode } from "../lib/stores/settings";
import { useEnvInfo } from "../lib/stores/env";
import type { EnvInfo, SessionType } from "../lib/stores/env";

type PkgManager = "apt" | "dnf" | "pacman";

const PKG_MANAGER_OPTIONS = [
  { value: "apt", label: "apt" },
  { value: "dnf", label: "dnf" },
  { value: "pacman", label: "pacman" },
] as const;

const FFMPEG_INSTALL: Record<PkgManager, string> = {
  apt: "sudo apt install ffmpeg pulseaudio",
  dnf: "sudo dnf install ffmpeg pulseaudio",
  pacman: "sudo pacman -S ffmpeg pulseaudio",
};

const WTYPE_INSTALL: Record<PkgManager, string> = {
  apt: "sudo apt install wtype",
  dnf: "sudo dnf install wtype",
  pacman: "sudo pacman -S wtype",
};

const PASTE_MODE_OPTIONS: readonly RadioCardOption<PasteMode>[] = [
  {
    value: "auto",
    label: "Auto",
    hint: "Terminal focused → Ctrl+Shift+V, otherwise Ctrl+V (X11 detection only)",
  },
  { value: "ctrl_v", label: "Ctrl+V", hint: "Always send Ctrl+V" },
  {
    value: "ctrl_shift_v",
    label: "Ctrl+Shift+V",
    hint: "Always send Ctrl+Shift+V (terminals)",
  },
  {
    value: "shift_insert",
    label: "Shift+Insert",
    hint: "Send Shift+Insert (no Wayland fallback)",
  },
  { value: "clipboard_only", label: "Clipboard only", hint: "Copy only — no keystrokes" },
];

interface EnvRowData {
  label: string;
  text: string;
  kind: BadgeKind;
  command?: string;
}

interface DirectoryBadge {
  text: string;
  kind: BadgeKind;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "");
}

function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return normalizePath(a) === normalizePath(b);
}

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("success", `${label} copied to clipboard`);
  } catch {
    toast("error", "Could not copy to clipboard");
  }
}

function sessionBadge(sessionType: SessionType): DirectoryBadge {
  switch (sessionType) {
    case "x11":
      return { text: "X11", kind: "success" };
    case "wayland-wlroots":
      return { text: "Wayland (wlroots)", kind: "neutral" };
    case "wayland-gnome":
      return { text: "Wayland (GNOME)", kind: "neutral" };
    default:
      return { text: "Other", kind: "warn" };
  }
}

function EnvRow({ row }: { row: EnvRowData }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className="min-w-0 truncate text-[13px] text-text-2">{row.label}</span>
      <div className="flex shrink-0 items-center gap-2">
        {row.command && (
          <>
            <code className="font-mono text-xs text-text-3">{row.command}</code>
            <Tooltip label="Copy install command">
              <IconButton
                label="Copy install command"
                onClick={() => void copyText(row.command ?? "", "Install command")}
              >
                <Copy size={14} strokeWidth={1.75} />
              </IconButton>
            </Tooltip>
          </>
        )}
        <Badge kind={row.kind}>{row.text}</Badge>
      </div>
    </div>
  );
}

function PasteSessionBanner({
  env,
  wtypeCommand,
}: {
  env: EnvInfo | null;
  wtypeCommand: string;
}) {
  if (!env) return null;
  const base =
    "flex items-start gap-2 rounded-lg border p-3 text-[13px] leading-relaxed";
  const amber = "border-warn/40 bg-warn-soft text-text";
  const neutral = "border-border bg-surface-2 text-text-2";
  if (env.sessionType === "x11") {
    return (
      <div className={`${base} ${neutral}`}>
        <span>X11 session — all paste modes available.</span>
      </div>
    );
  }
  if (env.sessionType === "wayland-wlroots") {
    return (
      <div className={`${base} ${amber}`}>
        <CircleAlert size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warn" />
        <span>
          Wayland: paste uses wtype — install it for best results. Terminal
          auto-detection is unavailable on Wayland; pick Ctrl+Shift+V if you dictate
          into terminals.
          {!env.wtype && (
            <>
              {" "}
              Install it with{" "}
              <code className="font-mono text-xs text-warn">{wtypeCommand}</code>.
            </>
          )}
        </span>
      </div>
    );
  }
  if (env.sessionType === "wayland-gnome") {
    return (
      <div className={`${base} ${amber}`}>
        <CircleAlert size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warn" />
        <span>
          GNOME Wayland restricts synthetic input — paste is clipboard-only (press
          Ctrl+V manually).
        </span>
      </div>
    );
  }
  return (
    <div className={`${base} ${neutral}`}>
      <span>Session type not recognized — paste may be limited to the clipboard.</span>
    </div>
  );
}

interface DirectoryRowProps {
  label: string;
  path: string | null;
  badge: DirectoryBadge | null;
  hint?: string;
  canReset: boolean;
  onBrowse: () => void;
  onReset: () => void;
  onOpen: () => void;
}

function DirectoryRow({
  label,
  path,
  badge,
  hint,
  canReset,
  onBrowse,
  onReset,
  onOpen,
}: DirectoryRowProps) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-text">{label}</span>
            {badge && <Badge kind={badge.kind}>{badge.text}</Badge>}
          </div>
          <p
            className="mt-1 truncate font-mono text-xs text-text-2"
            title={path ?? undefined}
          >
            {path ?? "…"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={onBrowse}>
            Browse…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<RefreshCw size={14} strokeWidth={1.75} />}
            onClick={onReset}
            disabled={!canReset}
          >
            Reset
          </Button>
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<FolderOpen size={14} strokeWidth={1.75} />}
            onClick={onOpen}
            disabled={!path}
          >
            Open folder
          </Button>
        </div>
      </div>
      {hint && <p className="mt-1.5 text-xs text-text-3">{hint}</p>}
    </div>
  );
}

export function SettingsPage() {
  const env = useEnvInfo();
  const audioPrefs = useAudioPrefs();
  const settings = useSettings();
  const storePasteMode = usePasteMode();

  const [pkgManager, setPkgManager] = useState<PkgManager>("apt");
  const [settingsWarning, setSettingsWarning] = useState<string | null>(null);
  const [pendingPasteMode, setPendingPasteMode] = useState<PasteMode | null>(null);
  const [defaultRecordingsDir, setDefaultRecordingsDir] = useState<string | null>(null);
  const [modelsDir, setModelsDir] = useState<string | null>(null);
  const [defaultModelsDir, setDefaultModelsDir] = useState<string | null>(null);

  const audioDir = audioPrefs?.audioDir ?? null;
  const modelsDirSetting = settings ? settings.modelsDir : undefined;
  const activePasteMode = pendingPasteMode ?? storePasteMode ?? "auto";

  useEffect(() => {
    let cancelled = false;
    void invoke<string | null>("get_settings_warning")
      .then((warning) => {
        if (!cancelled) setSettingsWarning(warning ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void invoke<string>("default_recordings_dir")
      .then((dir) => {
        if (!cancelled) setDefaultRecordingsDir(dir);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void invoke<string>("get_models_dir")
      .then((dir) => {
        if (!cancelled) setModelsDir(dir);
      })
      .catch(() => {
        if (!cancelled) setModelsDir(null);
      });
    return () => {
      cancelled = true;
    };
  }, [modelsDirSetting]);

  useEffect(() => {
    let cancelled = false;
    void invoke<string>("default_models_dir")
      .then((dir) => {
        if (!cancelled) setDefaultModelsDir(dir);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setPendingPasteMode(null);
  }, [storePasteMode]);

  async function handlePasteModeChange(mode: PasteMode): Promise<void> {
    if (mode === activePasteMode) return;
    setPendingPasteMode(mode);
    try {
      await invoke("set_paste_mode", { mode });
    } catch (error) {
      setPendingPasteMode(null);
      toast("error", `Could not set paste mode: ${errorMessage(error)}`);
    }
  }

  async function pickDirectory(): Promise<string | null> {
    const selected = await openDirectoryDialog({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  }

  async function browseAudioDir(): Promise<void> {
    const dir = await pickDirectory();
    if (!dir) return;
    try {
      await invoke("set_audio_dir", { dir });
      toast("success", "Recordings folder updated");
    } catch (error) {
      toast("error", `Could not set recordings folder: ${errorMessage(error)}`);
    }
  }

  async function resetAudioDir(): Promise<void> {
    if (!defaultRecordingsDir) return;
    try {
      await invoke("set_audio_dir", { dir: defaultRecordingsDir });
      toast("success", "Recordings folder reset to default");
    } catch (error) {
      toast("error", `Could not reset recordings folder: ${errorMessage(error)}`);
    }
  }

  async function openAudioDir(): Promise<void> {
    if (!audioDir) return;
    try {
      await openPath(audioDir);
    } catch (error) {
      toast("error", `Could not open folder: ${errorMessage(error)}`);
    }
  }

  async function browseModelsDir(): Promise<void> {
    const dir = await pickDirectory();
    if (!dir) return;
    try {
      await invoke("set_models_dir", { dir });
      toast("success", "Models folder updated");
    } catch (error) {
      toast("error", `Could not set models folder: ${errorMessage(error)}`);
    }
  }

  async function resetModelsDir(): Promise<void> {
    try {
      await invoke("set_models_dir", { dir: null });
      toast("success", "Models folder reset to default");
    } catch (error) {
      toast("error", `Could not reset models folder: ${errorMessage(error)}`);
    }
  }

  async function openModelsDir(): Promise<void> {
    if (!modelsDir) return;
    try {
      await openPath(modelsDir);
    } catch (error) {
      toast("error", `Could not open folder: ${errorMessage(error)}`);
    }
  }

  const ffmpegInstall = FFMPEG_INSTALL[pkgManager];
  const wtypeInstall = WTYPE_INSTALL[pkgManager];
  const envRows: EnvRowData[] = env
    ? [
        {
          label: "ffmpeg",
          kind: env.ffmpeg ? "success" : "warn",
          text: env.ffmpeg ? "installed" : "not found",
          command: env.ffmpeg ? undefined : ffmpegInstall,
        },
        {
          label: "ffprobe",
          kind: env.ffprobe ? "success" : "warn",
          text: env.ffprobe ? "installed" : "not found",
          command: env.ffprobe ? undefined : ffmpegInstall,
        },
        {
          label: "MP3 encoder (libmp3lame)",
          kind: env.libmp3lame ? "success" : "warn",
          text: env.libmp3lame ? "ready" : "missing",
          command: env.libmp3lame ? undefined : ffmpegInstall,
        },
        {
          label: "PulseAudio input",
          kind: env.pulseInput ? "success" : "warn",
          text: env.pulseInput ? "working" : "no input",
          command: env.pulseInput ? undefined : ffmpegInstall,
        },
        { label: "Session type", ...sessionBadge(env.sessionType) },
        {
          label: "wtype (Wayland keystrokes)",
          kind: env.wtype ? "success" : "warn",
          text: env.wtype ? "installed" : "not found",
          command: env.wtype ? undefined : wtypeInstall,
        },
      ]
    : [];

  const audioDirIsDefault = samePath(audioDir, defaultRecordingsDir);
  const modelsDirIsDefault = samePath(modelsDir, defaultModelsDir);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Audio location and format, paste mode, and environment status."
      />
      <div className="flex flex-col gap-6">
        {settingsWarning && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft p-3"
          >
            <CircleAlert
              size={16}
              strokeWidth={1.75}
              className="mt-0.5 shrink-0 text-warn"
            />
            <p className="text-[13px] text-text">{settingsWarning}</p>
          </div>
        )}

        <SectionCard
          title="Environment"
          description="Recording dependencies and desktop session, detected at startup."
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs text-text-3">Install commands for</span>
            <SegmentedControl
              options={PKG_MANAGER_OPTIONS}
              value={pkgManager}
              onChange={setPkgManager}
              ariaLabel="Package manager"
              className="w-[210px]"
            />
          </div>
          {env ? (
            <div className="flex flex-col divide-y divide-border">
              {envRows.map((row) => (
                <EnvRow key={row.label} row={row} />
              ))}
            </div>
          ) : (
            <p className="py-2 text-[13px] text-text-3">Detecting environment…</p>
          )}
        </SectionCard>

        <SectionCard
          title="Auto-paste"
          description="How finished transcripts land in the app you are typing in."
        >
          <div className="flex flex-col gap-3">
            <PasteSessionBanner env={env} wtypeCommand={wtypeInstall} />
            <RadioCardGroup
              options={PASTE_MODE_OPTIONS}
              value={activePasteMode}
              onChange={(mode) => void handlePasteModeChange(mode)}
              ariaLabel="Paste mode"
            />
          </div>
        </SectionCard>

        <SectionCard
          title="Storage"
          description="Where recordings and models live on disk."
        >
          <div className="flex flex-col gap-5">
            <DirectoryRow
              label="Recordings directory"
              path={audioDir}
              badge={
                audioDir
                  ? audioDirIsDefault
                    ? { text: "Default", kind: "success" }
                    : { text: "Custom", kind: "neutral" }
                  : null
              }
              canReset={Boolean(defaultRecordingsDir) && !audioDirIsDefault}
              onBrowse={() => void browseAudioDir()}
              onReset={() => void resetAudioDir()}
              onOpen={() => void openAudioDir()}
            />
            <DirectoryRow
              label="Models directory"
              path={modelsDir}
              badge={
                modelsDir
                  ? modelsDirIsDefault
                    ? { text: "Default", kind: "success" }
                    : { text: "Custom", kind: "neutral" }
                  : null
              }
              hint="Locks while a model is downloading."
              canReset={!modelsDirIsDefault}
              onBrowse={() => void browseModelsDir()}
              onReset={() => void resetModelsDir()}
              onOpen={() => void openModelsDir()}
            />
            <p className="text-xs text-text-3">
              The audio format (MP3 / WAV) is chosen on the{" "}
              <Link
                to="/record"
                className="font-medium text-accent transition-colors duration-150 hover:text-accent-strong"
              >
                Record
              </Link>{" "}
              page.
            </p>
          </div>
        </SectionCard>

        <p className="text-xs text-text-3">
          Voice Dictation — local, keyboard-first dictation for Linux
        </p>
      </div>
    </>
  );
}
