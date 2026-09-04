import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { primaryMonitor } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";

const pending = new Map<string, Promise<WebviewWindow>>();

export function overlayWindowUrl(hash: string): string {
  return `${location.origin}${location.pathname}#${hash}`;
}

export async function createOverlay(
  label: string,
  size: { width: number; height: number },
  url: string,
): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) return existing;
  const inFlight = pending.get(label);
  if (inFlight) return inFlight;
  const creation = (async () => {
    const win = new WebviewWindow(label, {
      x: -10000,
      y: -10000,
      width: size.width,
      height: size.height,
      url,
      visible: false,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      shadow: false,
      focusable: false,
    });
    await new Promise<void>((resolve, reject) => {
      void win.once("tauri://created", () => resolve());
      void win.once("tauri://error", (e) => reject(new Error(`overlay ${label} failed: ${String(e)}`)));
    });
    return win;
  })();
  pending.set(label, creation);
  try {
    return await creation;
  } finally {
    pending.delete(label);
  }
}

export async function ensureOverlayShown(label: string, position: { x: number; y: number }): Promise<void> {
  const win = await WebviewWindow.getByLabel(label);
  if (!win) return;
  let positioned = true;
  try {
    await win.setPosition(new PhysicalPosition(position.x, position.y));
  } catch (e) {
    console.warn(`[overlay] positioning ${label} failed, retrying once`, e);
    try {
      await win.setPosition(new PhysicalPosition(position.x, position.y));
    } catch (e2) {
      console.error(`[overlay] positioning ${label} failed twice; window may stay offscreen`, e2);
      positioned = false;
    }
  }
  try {
    await win.show();
  } catch (e) {
    console.error(`[overlay] show ${label} failed`, e);
  }
  if (!positioned) {
    console.error(`[overlay] ${label} shown at fallback position; primary monitor lookup failed`);
  }
}

export async function hideOverlayWindow(label: string): Promise<void> {
  const win = await WebviewWindow.getByLabel(label);
  if (!win) return;
  try {
    await win.hide();
  } catch (e) {
    console.warn(`[overlay] hide ${label} failed`, e);
  }
}

export async function makeClickThrough(label: string): Promise<void> {
  const win = await WebviewWindow.getByLabel(label);
  if (!win) return;
  // ONLY after first show — tao panics on unrealized GTK windows; re-verify on tao upgrades
  try {
    await win.setIgnoreCursorEvents(true);
  } catch (e) {
    console.warn(`[overlay] click-through ${label} failed`, e);
  }
}

export async function positionOnPrimaryMonitor(
  width: number,
  height: number,
  anchor: "center-75" | "bottom-center",
): Promise<{ x: number; y: number }> {
  const MARGIN = 12;
  const compute = async (): Promise<{ x: number; y: number }> => {
    const monitor = await primaryMonitor();
    if (!monitor) throw new Error("primary monitor unavailable");
    const x = monitor.position.x + Math.round((monitor.size.width - width) / 2);
    const y =
      anchor === "bottom-center"
        ? monitor.position.y + monitor.size.height - height - MARGIN
        : monitor.position.y + Math.round(monitor.size.height * 0.75 - height / 2);
    return { x, y };
  };
  try {
    return await compute();
  } catch (e) {
    console.warn("[overlay] primary monitor lookup failed, retrying once", e);
  }
  try {
    return await compute();
  } catch (e) {
    console.error("[overlay] primary monitor lookup failed twice; using viewport estimate", e);
    return {
      x: Math.round((screen.width - width) / 2),
      y: Math.round(screen.height * 0.75 - height / 2),
    };
  }
}
