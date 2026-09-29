import { invoke } from "@tauri-apps/api/core";

interface ModelSummary {
  downloaded?: boolean;
}

export async function anyModelDownloaded(): Promise<boolean> {
  try {
    const models = await invoke<ModelSummary[]>("list_models");
    return models.some((m) => m.downloaded === true);
  } catch {
    return false;
  }
}

export function isMissingModelError(message: string): boolean {
  return /no model downloaded/i.test(message);
}
