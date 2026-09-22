import * as recorder from "./stores/recorder";
import { getTranscriberState, transcribeFile } from "./stores/transcriber";

function logError(context: string, e: unknown): void {
  console.error(`[voice-note] ${context}`, e);
}

export async function startVoiceNoteHold(): Promise<void> {
  if (getTranscriberState().busy) return;
  try {
    await recorder.startRecording();
  } catch (e) {
    logError("could not start recording", e);
  }
}

export async function endVoiceNoteHold(): Promise<void> {
  const meta = await recorder.stopRecording();
  if (!meta) return;
  void transcribeFile(meta.path, true).catch((e) => {
    logError("transcription failed", e);
  });
}

export async function toggleVoiceNote(): Promise<void> {
  if (getTranscriberState().busy) return;
  if (recorder.getRecorderState().recording) {
    await endVoiceNoteHold();
    return;
  }
  await startVoiceNoteHold();
}
