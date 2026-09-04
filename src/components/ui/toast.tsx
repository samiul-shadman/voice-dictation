import { useSyncExternalStore } from "react";
import { Check, CircleAlert, X } from "lucide-react";
import { IconButton } from "./IconButton";

export type ToastKind = "success" | "error" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  durationMs?: number;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  durationMs: number;
}

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const fn of listeners) fn();
}

function dismiss(id: number): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  if (!items.some((t) => t.id === id)) return;
  items = items.filter((t) => t.id !== id);
  emit();
}

export function toast(
  kind: ToastKind,
  message: string,
  opts?: ToastOptions,
): void {
  const id = nextId++;
  const durationMs = opts?.durationMs ?? 4000;
  const item: ToastItem = { id, kind, message, action: opts?.action, durationMs };
  items = [...items, item];
  emit();
  if (!(kind === "error" && item.action)) {
    timers.set(
      id,
      setTimeout(() => dismiss(id), durationMs),
    );
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): ToastItem[] {
  return items;
}

const KIND_STYLES: Record<ToastKind, { icon: typeof Check; className: string }> = {
  success: { icon: Check, className: "text-ok" },
  error: { icon: CircleAlert, className: "text-err" },
  info: { icon: CircleAlert, className: "text-text-2" },
};

export function ToastViewport() {
  const toasts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2">
      {toasts.map((t) => {
        const { icon: Icon, className } = KIND_STYLES[t.kind];
        const action = t.action;
        return (
          <div
            key={t.id}
            role="status"
            className="pop-in pointer-events-auto flex items-start gap-2.5 rounded-md border border-border bg-surface-2 p-3 shadow-raised"
          >
            <Icon size={16} strokeWidth={1.75} className={`mt-0.5 shrink-0 ${className}`} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-text">{t.message}</p>
              {action && (
                <button
                  type="button"
                  onClick={() => {
                    action.onClick();
                    dismiss(t.id);
                  }}
                  className="mt-1.5 text-[13px] font-medium text-accent hover:text-accent-strong"
                >
                  {action.label}
                </button>
              )}
            </div>
            <IconButton label="Dismiss notification" className="-mr-1 -mt-1 shrink-0" onClick={() => dismiss(t.id)}>
              <X size={14} strokeWidth={1.75} />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}
