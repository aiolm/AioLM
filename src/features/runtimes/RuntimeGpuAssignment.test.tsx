import { fireEvent, render as renderUI, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from 'react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { describe, expect, it, vi } from "vitest";
import type * as api from "../../shared/api/types";
import type { UnifiedKey } from "../../shared/i18n/i18nUnified";
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
  it("hides device path prefixes from labels and accessible names while preserving saved identities", async () => {
    const firstId = String.raw`\\?\C:\devices\gpu-a`;
    const secondId = String.raw`\\?\UNC\server\gpu-b`;
    const pathPlacement: api.GpuPlacement = { ...placement, gpu_ids: [firstId, secondId], main_gpu: firstId };
    const pathDevice = {
      ...device,
      profile: { ...device.profile, gpus: device.profile.gpus.map((gpu, index) => ({ ...gpu, stable_id: index === 0 ? firstId : secondId })) },
    };
    const onChange = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<RuntimeGpuAssignment t={t} device={pathDevice} placement={pathPlacement} disabled={false} onChange={onChange} />);

    const ratio = screen.getByLabelText(String.raw`ui.gpuTensorSplit C:\devices\gpu-a`);
    expect(container.textContent).not.toContain(firstId.slice(0, 4));
    fireEvent.change(ratio, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "panel.save" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...pathPlacement, tensor_split: [2, 1] }));
  });

  it('can clear a previous GPU assignment when the selected runtime has no devices', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<RuntimeGpuAssignment t={t} device={{ ...device, profile: { ...device.profile, gpus: [] } }} placement={placement} disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'ui.gpuAny' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'panel.save' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ gpu_ids: [], main_gpu: null, draft_gpu_id: null, split_mode: 'none', tensor_split: [] }));
  });
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
