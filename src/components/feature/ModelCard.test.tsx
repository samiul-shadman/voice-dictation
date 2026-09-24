// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ModelCard, { type ModelInfo } from "./ModelCard";
import type { DownloadInfo } from "../../lib/stores/downloads";

const baseModel: ModelInfo = {
  id: "parakeet-tdt-0.6b-v2",
  name: "Parakeet TDT 0.6B v2",
  languages: ["en"],
  description: "Fast English transcription.",
  totalSizeBytes: 640_000_000,
  downloaded: false,
  downloading: false,
  cancelling: false,
  downloadError: null,
  isDefault: false,
};

function activeDownload(percent: number): DownloadInfo {
  return {
    id: baseModel.id,
    downloaded: percent,
    total: 100,
    percent,
    state: "active",
  };
}

function renderCard(
  model: Partial<ModelInfo> = {},
  download?: DownloadInfo,
  busy = false,
) {
  const handlers = {
    onDownload: vi.fn(),
    onCancel: vi.fn(),
    onDelete: vi.fn(),
    onSetDefault: vi.fn(),
  };
  render(
    <ModelCard
      model={{ ...baseModel, ...model }}
      download={download}
      busy={busy}
      {...handlers}
    />,
  );
  return handlers;
}

afterEach(() => {
  cleanup();
});

describe("ModelCard", () => {
  it("shows Ready for a downloaded model", () => {
    renderCard({ downloaded: true });

    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("shows the download percentage while downloading", () => {
    renderCard({ downloading: true }, activeDownload(42));

    expect(screen.getByText("Downloading… 42%")).toBeTruthy();
  });

  it("treats an active download record as downloading", () => {
    renderCard({}, activeDownload(7));

    expect(screen.getByText("Downloading… 7%")).toBeTruthy();
  });

  it("shows Cancelling and disables the Cancel button while cancelling", () => {
    renderCard({ downloading: true, cancelling: true }, activeDownload(42));

    expect(screen.getByText("Cancelling…")).toBeTruthy();
    const cancel = screen.getByRole("button", { name: /Cancel/ }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
  });

  it("surfaces a download error when no active download exists", () => {
    renderCard({ downloadError: "disk full" });

    expect(screen.getByText("disk full")).toBeTruthy();
  });

  it("shows Not downloaded and Download calls onDownload with the id", () => {
    const handlers = renderCard({ downloaded: false });

    expect(screen.getByText("Not downloaded")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(handlers.onDownload).toHaveBeenCalledWith(baseModel.id);
  });

  it("disables Delete and hides Set default for the default model", () => {
    renderCard({ downloaded: true, isDefault: true });

    const remove = screen.getByRole("button", {
      name: "Default model — remove default first",
    }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Set default" })).toBeNull();
  });

  it("disables Set default until the model is downloaded", () => {
    renderCard({ downloaded: false });

    const setDefault = screen.getByRole("button", { name: "Set default" }) as HTMLButtonElement;
    expect(setDefault.disabled).toBe(true);
  });

  it("marks the default model with a badge", () => {
    renderCard({ downloaded: true, isDefault: true });

    expect(screen.getByText("Default")).toBeTruthy();
  });
});
