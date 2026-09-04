import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { Cpu, FolderOpen, RotateCcw } from "lucide-react";
import ModelCard from "../components/feature/ModelCard";
import type { ModelInfo } from "../components/feature/ModelCard";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  PageHeader,
  SectionCard,
  Spinner,
  toast,
} from "../components/ui";
import { humanSize } from "../lib/format";
import { cancelDownload, downloadModel, useDownloads } from "../lib/stores/downloads";

const REFETCH_EVENTS = [
  "model-download-done",
  "model-download-error",
  "model-download-cancelled",
] as const;

function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

export function ModelsPage() {
  const downloads = useDownloads();
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modelsDir, setModelsDir] = useState<string | null>(null);
  const [defaultDir, setDefaultDir] = useState<string | null>(null);
  const [dirBusy, setDirBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, dir, fallbackDir] = await Promise.all([
        invoke<ModelInfo[]>("list_models"),
        invoke<string>("get_models_dir"),
        invoke<string>("default_models_dir"),
      ]);
      setModels(list);
      setModelsDir(dir);
      setDefaultDir(fallbackDir);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const unlistens: Array<() => void> = [];
    void (async () => {
      for (const event of REFETCH_EVENTS) {
        try {
          const unlisten = await listen(event, () => {
            void load();
          });
          unlistens.push(unlisten);
        } catch {}
      }
      try {
        const unlisten = await listen<{ field: string }>("settings-changed", (e) => {
          if (e.payload.field === "defaultModel" || e.payload.field === "modelsDir") {
            void load();
          }
        });
        unlistens.push(unlisten);
      } catch {}
    })();
    return () => {
      for (const unlisten of unlistens) unlisten();
    };
  }, [load]);

  const withBusy = useCallback(async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    try {
      await action();
    } finally {
      setBusyId(null);
    }
  }, []);

  const handleDownload = useCallback(
    (id: string) => {
      void withBusy(id, () => downloadModel(id));
    },
    [withBusy],
  );

  const handleCancel = useCallback(
    (id: string) => {
      void withBusy(id, () => cancelDownload(id));
    },
    [withBusy],
  );

  const handleSetDefault = useCallback(
    (id: string) => {
      void withBusy(
        id,
        async () => {
          try {
            await invoke("set_default_model", { id });
            await load();
          } catch (e) {
            toast("error", errorMessage(e));
          }
        },
      );
    },
    [withBusy, load],
  );

  const applyDir = useCallback(
    async (dir: string | null) => {
      setDirBusy(true);
      try {
        await invoke("set_models_dir", { dir });
        await load();
      } catch (e) {
        toast("error", errorMessage(e));
      } finally {
        setDirBusy(false);
      }
    },
    [load],
  );

  const browseDir = useCallback(async () => {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") void applyDir(picked);
    } catch (e) {
      toast("error", errorMessage(e));
    }
  }, [applyDir]);

  const resetDir = useCallback(() => {
    void applyDir(null);
  }, [applyDir]);

  const openDir = useCallback(async () => {
    if (modelsDir === null) return;
    try {
      await openPath(modelsDir);
    } catch (e) {
      toast("error", errorMessage(e));
    }
  }, [modelsDir]);

  const deleteTarget =
    deleteId === null ? null : (models ?? []).find((m) => m.id === deleteId) ?? null;

  const confirmDelete = useCallback(async () => {
    if (deleteTarget === null) return;
    setBusyId(deleteTarget.id);
    try {
      await invoke("delete_model", { id: deleteTarget.id });
      setDeleteId(null);
      await load();
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }, [deleteTarget, load]);

  const isCustomDir = modelsDir !== null && defaultDir !== null && modelsDir !== defaultDir;
  const downloadedModels = (models ?? []).filter((m) => m.downloaded);
  const onDiskBytes = downloadedModels.reduce((sum, m) => sum + m.totalSizeBytes, 0);

  return (
    <>
      <PageHeader
        title="Models"
        description="Two local Parakeet models power transcription. Downloads run in the background."
      />
      {models === null ? (
        loadError !== null ? (
          <EmptyState
            icon={<Cpu size={24} strokeWidth={1.75} />}
            title="Couldn't load models"
            hint={loadError}
            action={
              <Button variant="secondary" onClick={() => void load()}>
                Retry
              </Button>
            }
          />
        ) : (
          <div className="flex justify-center py-16">
            <Spinner size={24} />
          </div>
        )
      ) : (
        <>
          <p className="mb-4 font-mono text-xs text-text-2">
            {downloadedModels.length} / {models.length} downloaded · {humanSize(onDiskBytes)} on
            disk
          </p>
          <SectionCard title="Storage" className="mb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="min-w-0 truncate font-mono text-xs text-text-2"
                  title={modelsDir ?? undefined}
                >
                  {modelsDir ?? "—"}
                </span>
                <Badge kind={isCustomDir ? "neutral" : "success"}>
                  {isCustomDir ? "Custom" : "Default"}
                </Badge>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button size="sm" onClick={() => void browseDir()}>
                  Browse…
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  leftIcon={<RotateCcw size={13} strokeWidth={1.75} />}
                  disabled={dirBusy || !isCustomDir}
                  onClick={resetDir}
                >
                  Reset
                </Button>
                <IconButton
                  label="Open folder"
                  disabled={modelsDir === null}
                  onClick={() => void openDir()}
                >
                  <FolderOpen size={15} strokeWidth={1.75} />
                </IconButton>
              </div>
            </div>
            <p className="mt-2 text-xs text-text-3">
              Directory changes lock while a download is active.
            </p>
          </SectionCard>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
            {models.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                download={downloads[model.id]}
                onDownload={handleDownload}
                onCancel={handleCancel}
                onDelete={setDeleteId}
                onSetDefault={handleSetDefault}
                busy={busyId === model.id}
              />
            ))}
          </div>
          <Dialog
            open={deleteTarget !== null}
            onClose={() => {
              if (busyId === null) setDeleteId(null);
            }}
            title={deleteTarget === null ? "Delete model?" : `Delete ${deleteTarget.name}?`}
            description="You can download it again."
            destructive
            actions={
              <>
                <Button variant="ghost" onClick={() => setDeleteId(null)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={busyId !== null}
                  onClick={() => void confirmDelete()}
                >
                  Delete
                </Button>
              </>
            }
          />
        </>
      )}
    </>
  );
}
