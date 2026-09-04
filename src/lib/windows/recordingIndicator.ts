import {
  createOverlay,
  ensureOverlayShown,
  hideOverlayWindow,
  makeClickThrough,
  overlayWindowUrl,
  positionOnPrimaryMonitor,
} from "./overlay";

const RECORDING_INDICATOR_SIZE = { width: 260, height: 76 };
const LABEL = "recording-indicator";

export async function ensureRecordingIndicatorWindow(): Promise<void> {
  try {
    await createOverlay(LABEL, RECORDING_INDICATOR_SIZE, overlayWindowUrl("recording-indicator"));
    const position = await positionOnPrimaryMonitor(
      RECORDING_INDICATOR_SIZE.width,
      RECORDING_INDICATOR_SIZE.height,
      "bottom-center",
    );
    await ensureOverlayShown(LABEL, position);
    await makeClickThrough(LABEL);
  } catch (e) {
    console.error("[recording-indicator] ensure failed", e);
  }
}

export async function hideRecordingIndicatorWindow(): Promise<void> {
  await hideOverlayWindow(LABEL);
}
