import { invoke } from "@tauri-apps/api/core";

export async function readRecordingBytes(path: string): Promise<ArrayBuffer> {
  return await invoke<ArrayBuffer>("read_recording", { path });
}
