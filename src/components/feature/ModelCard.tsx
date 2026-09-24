import { Check, CircleCheck, Cpu, Download, Trash2 } from "lucide-react";
import { Badge, Button, IconButton, Progress, Tooltip } from "../ui";
import { humanSize } from "../../lib/format";
import type { DownloadInfo } from "../../lib/stores/downloads";

export interface ModelInfo {
  id: string;
  name: string;
  languages: string[];
  description: string;
  totalSizeBytes: number;
  downloaded: boolean;
  downloading: boolean;
  cancelling: boolean;
  downloadError: string | null;
  isDefault: boolean;
}

export interface ModelCardProps {
  model: ModelInfo;
  download?: DownloadInfo;
  onDownload: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  onSetDefault: (id: string) => void;
  busy: boolean;
}

export default function ModelCard({
  model,
  download,
  onDownload,
  onCancel,
  onDelete,
  onSetDefault,
  busy,
}: ModelCardProps) {
  const downloading = model.downloading || download?.state === "active";
  const cancelling = model.cancelling;
  const downloaded = model.downloaded || download?.state === "done";
  const errorText =
    download?.state === "error"
      ? (download.error ?? model.downloadError ?? "Download failed.")
      : model.downloadError;
  const failed = !downloading && errorText !== null;
  const percent = downloading ? Math.round(download?.percent ?? 0) : 0;

  let status;
  if (downloading) {
    status = cancelling ? (
      <span className="font-mono text-xs tabular-nums text-text-2">Cancelling…</span>
    ) : (
      <span className="font-mono text-xs tabular-nums text-text-2">Downloading… {percent}%</span>
    );
  } else if (failed) {
    status = <span className="text-xs font-medium text-err">{errorText}</span>;
  } else if (downloaded) {
    status = (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ok">
        <Check size={14} strokeWidth={2} />
        Ready
      </span>
    );
  } else {
    status = <span className="text-xs text-text-3">Not downloaded</span>;
  }

  const deleteLabel = model.isDefault
    ? "Default model — remove default first"
    : downloading
      ? "Downloading — stop it before deleting"
      : "Delete";

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Cpu size={18} strokeWidth={1.75} className="shrink-0 text-text-3" />
          <h3 className="truncate text-[15px] font-medium text-text">{model.name}</h3>
          {model.isDefault && <Badge kind="success">Default</Badge>}
        </div>
        <span className="shrink-0 font-mono text-xs text-text-2" title="Total download size">
          {humanSize(model.totalSizeBytes)}
        </span>
      </div>

      <div className="flex flex-wrap gap-1">
        {model.languages.map((lang) => (
          <Badge key={lang}>{lang}</Badge>
        ))}
      </div>

      <p className="text-[13px] leading-5 text-text-2">{model.description}</p>

      <div className="mt-auto flex flex-col gap-2 pt-1">
        <div className="flex flex-col gap-1.5">
          {status}
          {failed && (
            <p className="text-xs text-text-3">
              Try re-downloading — the download may have been interrupted.
            </p>
          )}
        </div>
        {downloading && <Progress value={percent} />}
        <div className="mt-1 flex items-center gap-2">
          {downloading ? (
            <Button variant="danger" size="sm" loading={busy || cancelling} onClick={() => onCancel(model.id)}>
              Cancel
            </Button>
          ) : (
            !downloaded && (
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Download size={14} strokeWidth={1.75} />}
                loading={busy}
                onClick={() => onDownload(model.id)}
              >
                Download
              </Button>
            )
          )}
          {!model.isDefault && (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<CircleCheck size={14} strokeWidth={1.75} />}
              disabled={!downloaded || busy || downloading}
              loading={busy}
              onClick={() => onSetDefault(model.id)}
            >
              Set default
            </Button>
          )}
          <Tooltip label={deleteLabel}>
            <IconButton
              label={deleteLabel}
              disabled={busy || downloading || model.isDefault}
              onClick={() => onDelete(model.id)}
              className="text-err! ml-auto"
            >
              <Trash2 size={15} strokeWidth={1.75} />
            </IconButton>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}
