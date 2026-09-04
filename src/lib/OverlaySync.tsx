import { useEffect } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getArmed, onArmedChange } from "./shortcuts/engine";
import type { ArmedState } from "./shortcuts/engine";
import { getLevel } from "./stores/levels";
import { getRecorderState, subscribeRecorder } from "./stores/recorder";
import { getTranscriberState, subscribeTranscriber } from "./stores/transcriber";
import { ensureIndicatorWindow, hideIndicatorWindow } from "./windows/indicator";
import {
  ensureRecordingIndicatorWindow,
  hideRecordingIndicatorWindow,
} from "./windows/recordingIndicator";

const TOGGLE_AUTO_HIDE_MS = 1200;

export function OverlaySync() {
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const pushToIndicator = async (label: string): Promise<void> => {
      const armed = getArmed();
      if (armed) {
        await emitTo(label, "shortcut-armed", {
          combo: armed.combo,
          action: armed.action,
          trigger: armed.trigger,
        });
      } else {
        await emitTo(label, "shortcut-disarmed", { combo: "" });
      }
    };

    const pushToRecordingIndicator = async (label: string): Promise<void> => {
      const recorder = getRecorderState();
      await emitTo(label, "recording-state", {
        recording: recorder.recording,
        stopping: recorder.stopping,
      });
      await emitTo(label, "recording-level", { level: getLevel() });
      const transcriber = getTranscriberState();
      if (transcriber.busy && transcriber.activePath) {
        await emitTo(label, "transcribe-progress", {
          path: transcriber.activePath,
          percent: transcriber.percent,
        });
      }
    };

    const handleOverlayReady = async (label: string): Promise<void> => {
      if (label === "indicator") await pushToIndicator(label);
      else if (label === "recording-indicator") await pushToRecordingIndicator(label);
    };

    let toggleHideTimer: ReturnType<typeof setTimeout> | null = null;
    let prevArmed: ArmedState | null = null;

    const syncVisibility = (): void => {
      const armed = getArmed();
      if (armed) {
        if (toggleHideTimer) {
          clearTimeout(toggleHideTimer);
          toggleHideTimer = null;
        }
        void ensureIndicatorWindow();
        if (armed.trigger === "toggle") {
          toggleHideTimer = setTimeout(() => {
            toggleHideTimer = null;
            void hideIndicatorWindow();
          }, TOGGLE_AUTO_HIDE_MS);
        }
      } else if (prevArmed && prevArmed.trigger === "hold") {
        void hideIndicatorWindow();
      }
      prevArmed = armed;

      const recorder = getRecorderState();
      const transcriber = getTranscriberState();
      const busy = recorder.recording || transcriber.busy;
      if (busy) {
        void ensureRecordingIndicatorWindow();
        void hideIndicatorWindow();
      } else {
        void hideRecordingIndicatorWindow();
      }
    };

    unlisteners.push(subscribeRecorder(syncVisibility));
    unlisteners.push(subscribeTranscriber(syncVisibility));
    unlisteners.push(onArmedChange(syncVisibility));

    void (async () => {
      try {
        const unlisten = await listen<{ label: string }>("overlay-ready", (e) => {
          void handleOverlayReady(e.payload.label);
        });
        if (disposed) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      } catch (e) {
        console.warn("[overlaysync] overlay-ready listener failed", e);
      }
      try {
        const windows = await WebviewWindow.getAll();
        if (disposed) return;
        for (const win of windows) {
          if (win.label === "indicator" || win.label === "recording-indicator") {
            void handleOverlayReady(win.label);
          }
        }
      } catch {}
    })();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
      if (toggleHideTimer) clearTimeout(toggleHideTimer);
    };
  }, []);

  return null;
}
