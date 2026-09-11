import { fireEvent, render as renderUI, screen } from "@testing-library/react";
import type { ReactElement } from 'react';
import { I18nProvider } from '../i18n';
import { describe, expect, it, vi } from "vitest";
import type * as api from "../api";
import type { UnifiedKey } from "../i18nUnified";
import RuntimeGpuAssignment from "./RuntimeGpuAssignment";

const placement: api.GpuPlacement = {
  gpu_ids: ["gpu-a", "gpu-b"],
  main_gpu: "gpu-a",
  draft_gpu_id: null,
  split_mode: "layer",
  tensor_split: [1, 1],
};

const device = {
  profile: {
    gpus: [
      { stable_id: "gpu-a", name: "Radeon 9700", vendor: "amd", integrated: false, vram_mb: 16384 },
      { stable_id: "gpu-b", name: "Radeon 9700", vendor: "amd", integrated: false, vram_mb: 16384 },
    ],
  },
} as api.DeviceReport;

const t = (key: UnifiedKey) => key;
const render = (element: ReactElement) => renderUI(element, { wrapper: ({ children }) => <I18nProvider initialLocale="en">{children}</I18nProvider> });

describe("RuntimeGpuAssignment", () => {
  it("preserves unsaved ratios when another panel saves the placement", () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const view = render(<RuntimeGpuAssignment t={t} device={device} placement={placement} disabled={false} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("ui.gpuTensorSplit gpu-a"), { target: { value: "0.25" } });
    view.rerender(<RuntimeGpuAssignment t={t} device={device} placement={{ ...placement, tensor_split: [2, 3] }} disabled={false} onChange={onChange} />);
    expect(screen.getByLabelText("ui.gpuTensorSplit gpu-a")).toHaveValue("0.25");
  });
  it("keeps per-GPU ratios as drafts and only saves valid complete values", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<RuntimeGpuAssignment t={t} device={device} placement={placement} disabled={false} onChange={onChange} />);

    const first = screen.getByLabelText("ui.gpuTensorSplit gpu-a");
    const second = screen.getByLabelText("ui.gpuTensorSplit gpu-b");
    fireEvent.change(second, { target: { value: "" } });
    expect(second).toHaveValue("");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "panel.save" }));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(first, { target: { value: "0.25" } });
    fireEvent.change(second, { target: { value: "0.75" } });
    fireEvent.click(screen.getByRole("button", { name: "panel.save" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tensor_split: [0.25, 0.75] }));
  });

  it("preserves automatic distribution until manual ratios are enabled", () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<RuntimeGpuAssignment t={t} device={device} placement={{ ...placement, tensor_split: [] }} disabled={false} onChange={onChange} />);

    expect(screen.queryByLabelText("ui.gpuTensorSplit gpu-a")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "panel.save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "ui.gpuCustomTensorSplit" }));

    expect(screen.getByLabelText("ui.gpuTensorSplit gpu-a")).toHaveValue("1");
    expect(screen.getByRole("button", { name: "panel.save" })).toBeEnabled();
  });

});
