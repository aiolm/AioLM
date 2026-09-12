import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../shared/i18n/i18n";
import type { AppStore } from "../../shared/state/store";
import * as api from "../../shared/api/index";
import DeveloperPanel from "./Developer";

vi.mock("../../shared/api/index", () => ({
  anthropicGatewayStatus: vi.fn(async () => ({ running: false })),
  localModels: vi.fn(async () => []),
  startAnthropicGateway: vi.fn(),
  stopAnthropicGateway: vi.fn(),
}));

const path = String.raw`\\?\C:\models\example.gguf`;
const displayPath = String.raw`C:\models\example.gguf`;
const runningStore = {
  cfg: null,
  status: { state: "running", url: "http://127.0.0.1:8080/v1", api_key: "test", model: path },
} as unknown as AppStore;

beforeEach(() => vi.clearAllMocks());

describe("developer page path presentation", () => {
  it("renders model endpoint IDs and effective-model tooltips without changing the API result", async () => {
    const models = [{ id: path, object: "model", owned_by: "llama.cpp" }];
    vi.mocked(api.localModels).mockResolvedValueOnce(models);
    const { container } = render(<I18nProvider initialLocale="en"><DeveloperPanel store={runningStore} /></I18nProvider>);

    expect(await screen.findByText(displayPath)).toBeInTheDocument();
    expect(screen.getAllByTitle(displayPath)).toHaveLength(2);
    expect(container.textContent).not.toContain(path.slice(0, 4));
    expect(models[0].id).toBe(path);
    expect(runningStore.status.model).toBe(path);
    expect(api.localModels).toHaveBeenCalledWith(runningStore.status.url, "test");
  });

  it.each(["log_tail", "error"] as const)("cleans plain and escaped paths in diagnostics from %s", async (field) => {
    const diagnostics = `Cannot load ${path}\n${JSON.stringify({ path })}`;
    const store = { ...runningStore, status: { state: "stopped", [field]: diagnostics } } as AppStore;
    const { container } = render(<I18nProvider initialLocale="en"><DeveloperPanel store={store} section="diagnostics" /></I18nProvider>);

    expect(container.querySelector("pre")).toHaveTextContent(`Cannot load ${displayPath}`);
    expect(container.textContent).not.toContain(path.slice(0, 4));
    expect(store.status[field]).toBe(diagnostics);
  });

  it("cleans errors raised from the gateways page", async () => {
    vi.mocked(api.startAnthropicGateway).mockRejectedValueOnce(new Error(`Cannot open ${path}`));
    render(<I18nProvider initialLocale="en"><DeveloperPanel store={runningStore} section="gateways" /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Start gateway" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`Cannot open ${displayPath}`);
    expect(screen.getByRole("alert")).not.toHaveTextContent(path.slice(0, 4));
  });
});
