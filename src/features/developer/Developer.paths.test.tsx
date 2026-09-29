import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../shared/i18n/i18n";
import type { AppStore } from "../../shared/state/store";
import * as api from "../../shared/api/index";
import DeveloperPanel from "./Developer";

vi.mock("../../shared/api/index", () => ({
  apiServerStatus: vi.fn(),
  localModels: vi.fn(async () => []),
  startApiServer: vi.fn(),
  stopApiServer: vi.fn(),
  sessionSummaryList: vi.fn(async () => []),
  normalizeSessionList: vi.fn((value: unknown) => Array.isArray(value) ? value : []),
}));

const path = String.raw`\\?\C:\models\example.gguf`;
const displayPath = String.raw`C:\models\example.gguf`;
const runningStore = {
  cfg: null,
  status: { state: "running", url: "http://127.0.0.1:49152/v1", api_key: "private", model: path },
} as unknown as AppStore;
const runningApi = { running: true, url: "http://127.0.0.1:8080/v1", api_key: "test", port: 8080 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.apiServerStatus).mockResolvedValue({ running: false, port: 8080 });
});

describe("developer page path presentation", () => {
  it("shows model IDs without the verbatim prefix but copies the exact ID the API reports", async () => {
    const models = [{ id: path, object: "model", owned_by: "llama.cpp" }];
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    vi.mocked(api.localModels).mockResolvedValueOnce(models);
    const { container } = render(<I18nProvider initialLocale="en"><DeveloperPanel store={runningStore} /></I18nProvider>);

    expect(await screen.findByText(displayPath)).toBeInTheDocument();
    expect(screen.getAllByTitle(displayPath)).toHaveLength(1);
    expect(container.textContent).not.toContain(path.slice(0, 4));
    // The other app needs the ID exactly as the API serves it, so only the display is cleaned.
    fireEvent.click(screen.getByRole("button", { name: "Copy model ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(path));
    expect(writeText).toHaveBeenCalledOnce();
    expect(models[0].id).toBe(path);
    expect(runningStore.status.model).toBe(path);
    // The list comes from the API's own URL and key, not the model's private ones.
    expect(api.localModels).toHaveBeenCalledWith(runningApi.url, runningApi.api_key);
  });

  it("shows the default model's file name with a cleaned path tooltip on the diagnostics screen", () => {
    const { container } = render(<I18nProvider initialLocale="en"><DeveloperPanel store={runningStore} section="diagnostics" /></I18nProvider>);

    expect(screen.getByTitle(displayPath)).toHaveTextContent(/^example\.gguf$/);
    expect(container.textContent).not.toContain(path.slice(0, 4));
    expect(runningStore.status.model).toBe(path);
  });

  it.each(["log_tail", "error"] as const)("cleans plain and escaped paths in diagnostics from %s", async (field) => {
    const diagnostics = `Cannot load ${path}\n${JSON.stringify({ path })}`;
    const store = { ...runningStore, status: { state: "stopped", [field]: diagnostics } } as AppStore;
    const { container } = render(<I18nProvider initialLocale="en"><DeveloperPanel store={store} section="diagnostics" /></I18nProvider>);

    expect(container.querySelector("pre")).toHaveTextContent(`Cannot load ${displayPath}`);
    expect(container.textContent).not.toContain(path.slice(0, 4));
    expect(store.status[field]).toBe(diagnostics);
  });

  it("cleans errors raised while starting the API", async () => {
    vi.mocked(api.startApiServer).mockRejectedValueOnce(new Error(`Cannot open ${path}`));
    render(<I18nProvider initialLocale="en"><DeveloperPanel store={runningStore} /></I18nProvider>);
    const start = await screen.findByRole("button", { name: "Start API" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(await screen.findByRole("alert")).toHaveTextContent(`Cannot open ${displayPath}`);
    expect(screen.getByRole("alert")).not.toHaveTextContent(path.slice(0, 4));
  });
});
