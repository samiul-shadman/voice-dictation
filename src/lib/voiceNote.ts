import { toast } from "../components/ui";
import * as recorder from "./stores/recorder";
import { getTranscriberState, transcribeFile } from "./stores/transcriber";

const TRANSCRIBE_BUSY_MESSAGE = "Wait for the current transcription to finish";

function friendlyError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export async function startVoiceNoteHold(): Promise<void> {
  if (getTranscriberState().busy) {
    toast("error", TRANSCRIBE_BUSY_MESSAGE);
    return;
  }
  try {
    await recorder.startRecording();
  } catch (e) {
    toast("error", `Could not start recording — ${friendlyError(e)}`);
  }
}

export async function endVoiceNoteHold(): Promise<void> {
  const meta = await recorder.stopRecording();
  if (!meta) return;
  void transcribeFile(meta.path, true).catch((e) => {
    toast("error", `Transcription failed — ${friendlyError(e)}`);
  });
}

export async function toggleVoiceNote(): Promise<void> {
  if (getTranscriberState().busy) {
    toast("error", TRANSCRIBE_BUSY_MESSAGE);
    return;
  }
  if (recorder.getRecorderState().recording) {
    await endVoiceNoteHold();
    return;
  }
  await startVoiceNoteHold();
}
