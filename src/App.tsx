import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { HashRouter, Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { Cpu, Keyboard, LibraryBig, Mic, Settings as SettingsIcon, Wand } from "lucide-react";
import { ToastViewport, toast } from "./components/ui";
import { OverlaySync } from "./lib/OverlaySync";
import { initShortcutEngine } from "./lib/shortcuts/engine";
import { useEnvInfo, isMac } from "./lib/stores/env";
import { useRecording } from "./lib/stores/recorder";
import { ensureInit, onTranscribeComplete, onTranscribeError } from "./lib/stores/transcriber";
import { AnimationsPage } from "./pages/AnimationsPage";
import { IndicatorPage } from "./pages/IndicatorPage";
import { LibraryPage } from "./pages/LibraryPage";
import { ModelsPage } from "./pages/ModelsPage";
import { RecordPage } from "./pages/RecordPage";
import { RecordingIndicatorPage } from "./pages/RecordingIndicatorPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ShortcutsPage } from "./pages/ShortcutsPage";

function NavItem({ to, icon, label }: { to: string; icon: ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors duration-150 ${
          isActive ? "bg-accent-soft text-text" : "text-text-2 hover:bg-surface-2 hover:text-text"
        }`
      }
    >
      {icon}
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-1.5 pb-2">
      <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium tracking-[0.08em] text-text-3">
        {label}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function EnvFooter() {
  const env = useEnvInfo();
  const navigate = useNavigate();
  const mac = isMac(env);
  const micOk = Boolean(env?.micAvailable);
  const pasteOk = !mac || env?.accessibilityPermission === true;
  const depsOk = env !== null && micOk && pasteOk;
  const missing = env
    ? [micOk ? null : "microphone", pasteOk ? null : "paste permission"]
        .filter((item): item is string => item !== null)
        .join(", ")
    : null;
  return (
    <button
      type="button"
      onClick={() => navigate("/settings")}
      title="Environment status"
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface-2"
    >
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${
          depsOk ? "bg-ok" : env ? "bg-warn" : "bg-text-3"
        }`}
      />
      <span className="truncate text-[11px] text-text-2">
        {depsOk ? "Environment ready" : env ? `Missing: ${missing}` : "Checking environment"}
      </span>
    </button>
  );
}

function Sidebar() {
  return (
    <aside className="flex h-screen w-[200px] shrink-0 flex-col border-r border-border bg-surface">
      <nav className="flex-1 overflow-y-auto pt-2" aria-label="Main navigation">
        <NavGroup label="VOICE">
          <NavItem to="/record" icon={<Mic size={16} strokeWidth={1.75} />} label="Record" />
          <NavItem to="/library" icon={<LibraryBig size={16} strokeWidth={1.75} />} label="Library" />
        </NavGroup>
        <NavGroup label="MODELS">
          <NavItem to="/models" icon={<Cpu size={16} strokeWidth={1.75} />} label="Models" />
        </NavGroup>
        <NavGroup label="CUSTOMIZE">
          <NavItem to="/shortcuts" icon={<Keyboard size={16} strokeWidth={1.75} />} label="Shortcuts" />
          <NavItem to="/animations" icon={<Wand size={16} strokeWidth={1.75} />} label="Animations" />
        </NavGroup>
      </nav>
      <div className="border-t border-border p-1.5">
        <div className="flex flex-col gap-0.5">
          <NavItem
            to="/settings"
            icon={<SettingsIcon size={16} strokeWidth={1.75} />}
            label="Settings"
          />
        </div>
      </div>
      <div className="border-t border-border p-1.5">
        <EnvFooter />
      </div>
    </aside>
  );
}

function OutcomeToasts() {
  const recorder = useRecording();
  const lastError = useRef<string | null>(null);

  useEffect(() => {
    ensureInit();
  }, []);

  useEffect(() => {
    if (!recorder.lastError) {
      lastError.current = null;
      return;
    }
    if (lastError.current === recorder.lastError) return;
    lastError.current = recorder.lastError;
    toast("error", recorder.lastError);
  }, [recorder.lastError]);

  useEffect(
    () =>
      onTranscribeComplete((payload) => {
        if (payload.pasteError) {
          toast("error", "Could not paste automatically — the transcript is on your clipboard.", {
            durationMs: 6000,
          });
        }
      }),
    [],
  );

  useEffect(
    () =>
      onTranscribeError((payload) => {
        toast("error", `Transcription failed — ${payload.message}`);
      }),
    [],
  );

  return null;
}

function MainShell() {
  useEffect(() => {
    initShortcutEngine();
  }, []);
  return (
    <HashRouter>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[860px] px-6 py-6">
            <Routes>
              <Route path="/" element={<RecordPage />} />
              <Route path="/record" element={<RecordPage />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/shortcuts" element={<ShortcutsPage />} />
              <Route path="/animations" element={<AnimationsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </main>
      </div>
      <ToastViewport />
      <OutcomeToasts />
      <OverlaySync />
    </HashRouter>
  );
}

export default function App() {
  const label = document.documentElement.dataset.window ?? "main";
  if (label === "indicator") {
    return (
      <HashRouter>
        <Routes>
          <Route path="*" element={<IndicatorPage />} />
        </Routes>
      </HashRouter>
    );
  }
  if (label === "recording-indicator") {
    return (
      <HashRouter>
        <Routes>
          <Route path="*" element={<RecordingIndicatorPage />} />
        </Routes>
      </HashRouter>
    );
  }
  return <MainShell />;
}
