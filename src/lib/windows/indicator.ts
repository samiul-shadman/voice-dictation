import {
  createOverlay,
  ensureOverlayShown,
  hideOverlayWindow,
  makeClickThrough,
  overlayWindowUrl,
  positionOnPrimaryMonitor,
} from "./overlay";

const INDICATOR_SIZE = { width: 320, height: 96 };
const LABEL = "indicator";

export async function ensureIndicatorWindow(): Promise<void> {
  try {
    await createOverlay(LABEL, INDICATOR_SIZE, overlayWindowUrl("indicator"));
    const position = await positionOnPrimaryMonitor(INDICATOR_SIZE.width, INDICATOR_SIZE.height, "center-75");
    await ensureOverlayShown(LABEL, position);
    await makeClickThrough(LABEL);
  } catch (e) {
    console.error("[indicator] ensure failed", e);
  }
}

export async function hideIndicatorWindow(): Promise<void> {
  await hideOverlayWindow(LABEL);
}
