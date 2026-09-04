import { comboFromKeyboardEvent } from "./canonical";

export interface CaptureHandlers {
  onPreview: (combo: string) => void;
  onCommit: (combo: string) => void;
  onCancel: () => void;
  onClear: () => void;
}

function partialCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  if (e.metaKey) parts.push("meta");
  return parts.join("+");
}

export function startCapture(handlers: CaptureHandlers): () => void {
  let detached = false;
  const stop = (): void => {
    if (detached) return;
    detached = true;
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", onWindowBlur, true);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      stop();
      handlers.onCancel();
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      handlers.onClear();
      return;
    }
    const combo = comboFromKeyboardEvent(e);
    if (!combo) {
      handlers.onPreview(partialCombo(e));
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    stop();
    handlers.onCommit(combo);
  };
  const onWindowBlur = (): void => {
    stop();
    handlers.onCancel();
  };
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", onWindowBlur, true);
  return stop;
}
