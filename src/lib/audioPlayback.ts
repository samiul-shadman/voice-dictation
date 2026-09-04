import { readRecordingBytes } from "./audio";

export interface AudioElementLike {
  pause(): void;
  paused: boolean;
}

const playing = new Set<AudioElementLike>();
const elementPaths = new WeakMap<AudioElementLike, string>();
const urlCache = new Map<string, { url: string; bytes: ArrayBuffer }>();

function mimeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  return "application/octet-stream";
}

export function claimExclusivePlayback(el: AudioElementLike, path?: string): void {
  for (const other of playing) {
    if (other !== el && !other.paused) other.pause();
  }
  playing.add(el);
  if (path !== undefined) elementPaths.set(el, path);
}

export function unregisterPlayback(el: AudioElementLike): void {
  playing.delete(el);
  elementPaths.delete(el);
}

export function pausePath(path: string): boolean {
  let paused = false;
  for (const el of playing) {
    if (elementPaths.get(el) === path && !el.paused) {
      el.pause();
      paused = true;
    }
  }
  return paused;
}

export async function loadRecordingUrl(path: string): Promise<string> {
  const cached = urlCache.get(path);
  if (cached) return cached.url;
  const bytes = await readRecordingBytes(path);
  const blob = new Blob([bytes], { type: mimeForPath(path) });
  const url = URL.createObjectURL(blob);
  urlCache.set(path, { url, bytes });
  return url;
}

export function getCachedRecordingBytes(path: string): ArrayBuffer | null {
  const cached = urlCache.get(path);
  return cached ? cached.bytes : null;
}

export function forgetRecordingUrl(path: string): void {
  const cached = urlCache.get(path);
  if (!cached) return;
  URL.revokeObjectURL(cached.url);
  urlCache.delete(path);
}

export function forgetAllRecordingUrls(): void {
  for (const cached of urlCache.values()) URL.revokeObjectURL(cached.url);
  urlCache.clear();
}

export function base64DataUrl(bytes: ArrayBuffer, mime: string): string {
  const view = new Uint8Array(bytes);
  // chunked 32 KiB String.fromCharCode — spread-arg/stack + webkit blob-URL
  // playback quirk fallback (plan 05 pitfall #5); used only on <audio> error.
  const CHUNK = 32 * 1024;
  let binary = "";
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
