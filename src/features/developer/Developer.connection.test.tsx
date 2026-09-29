import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { I18nProvider } from "../../shared/i18n/i18n";
import type { AppStore } from "../../shared/state/store";
import type { ApiServerStatus, ServerStatus } from "../../shared/api/types";
import type { ViewId } from "../../shared/types/navigation";
import { ActivePanelContext } from "../../shared/ui/PanelFeedback";
import { createTestStore } from "../../testing/appStore";
import * as api from "../../shared/api/index";
import DeveloperPanel from "./Developer";

vi.mock("../../shared/api/index", () => ({
  apiServerStatus: vi.fn(),
  startApiServer: vi.fn(),
  stopApiServer: vi.fn(),
  localModels: vi.fn(),
  sessionSummaryList: vi.fn(async () => []),
  normalizeSessionList: vi.fn((value: unknown) => Array.isArray(value) ? value : []),
  // Model lifecycle commands: nothing on the API screen may reach any of them.
  startServer: vi.fn(),
  stopServer: vi.fn(),
  unloadModel: vi.fn(),
  sessionStart: vi.fn(),
  sessionStop: vi.fn(),
  sessionUnload: vi.fn(),
}));

const SECRET = "sk-test-secret-value";
const API_URL = "http://127.0.0.1:8080/v1";
const API_ROOT = "http://127.0.0.1:8080";
const stoppedApi: ApiServerStatus = { running: false, url: null, api_key: null, port: 8080 };
const runningApi: ApiServerStatus = { running: true, url: API_URL, api_key: SECRET, port: 8080 };
// The model's own server is private: its URL and key must never reach this page.
const privateModel: ServerStatus = { state: "running", url: "http://127.0.0.1:49152/v1", api_key: "private-internal-key", model: "models/loaded.gguf" };

const writeText = vi.fn(async (_text: string) => undefined);
const modelLifecycleCommands = () => [api.startServer, api.stopServer, api.unloadModel, api.sessionStart, api.sessionStop, api.sessionUnload];
const listed = (id: string) => ({ id, object: "model", owned_by: "llama.cpp" });

function storeWith(status: ServerStatus = { state: "stopped" }, overrides: Partial<AppStore> = {}): AppStore {
  return { ...createTestStore(), status, ...overrides };
}

function page(store: AppStore, section: "api" | "diagnostics" = "api", onNavigate?: (view: ViewId) => void): ReactElement {
  return <I18nProvider initialLocale="en"><DeveloperPanel store={store} section={section} onNavigate={onNavigate} /></I18nProvider>;
}

/** Port settings and the API reference are native details, closed until the user opens them. */
function openDisclosure(summary: string): HTMLDetailsElement {
  const label = screen.getByText(summary, { selector: "summary" });
  const details = label.closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(label);
  expect(details.open).toBe(true);
  return details;
}

/** Chooses an option the way a user does: open the labelled dropdown, then click the option. */
function chooseOption(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

const lifecycleButtons = () => screen.getAllByRole("button", { name: /^(Start|Stop|Restart) API$/ }).map(button => button.textContent);
const baseUrlText = () => document.querySelector(".api-connection-values code");
const snippet = () => document.querySelector("pre.api-code");
const endpoints = () => Array.from(document.querySelectorAll(".api-endpoints tbody code"), code => code.textContent).sort();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  vi.mocked(api.apiServerStatus).mockResolvedValue(stoppedApi);
  vi.mocked(api.localModels).mockResolvedValue([]);
  vi.mocked(api.startApiServer).mockResolvedValue(runningApi);
  vi.mocked(api.stopApiServer).mockResolvedValue(undefined);
});

afterEach(() => { vi.useRealTimers(); });

describe("single API control", () => {
  it("offers exactly one Start/Stop API control and no gateway control", async () => {
    const { container } = render(page(storeWith()));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start API" })).toBeEnabled());
    expect(lifecycleButtons()).toEqual(["Start API"]);
    expect(container.querySelectorAll(".developer-api-status")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Start API" }));
    await waitFor(() => expect(lifecycleButtons()).toEqual(["Stop API"]));
    expect(container.querySelectorAll(".developer-api-status")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /gateway/i })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/gateway/i);
  });
});

describe("connection format", () => {
  it("changes the copied base URL and the documentation without starting, stopping or reading anything", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    const store = storeWith(privateModel);
    const { container } = render(page(store));
    const copyUrl = await screen.findByRole("button", { name: "Copy URL" });
    await waitFor(() => expect(copyUrl).toBeEnabled());
    await waitFor(() => expect(api.localModels).toHaveBeenCalledTimes(1));
    const modelReads = vi.mocked(api.localModels).mock.calls.length;
    openDisclosure("API reference & examples");
    const format = screen.getByRole("combobox", { name: "Connection format" });

    // OpenAI: the /v1 base URL and bearer authentication.
    expect(format).toHaveTextContent("OpenAI");
    expect(format).toHaveAccessibleDescription("Choose the format your app expects. Both use this same server.");
    expect(baseUrlText()).toHaveTextContent(new RegExp(`^${API_URL}$`));
    fireEvent.click(copyUrl);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(API_URL));
    expect(copyUrl).toHaveAccessibleName("Copied");
    expect(snippet()).toHaveTextContent("Authorization: Bearer <LOCAL_API_KEY>");
    expect(snippet()).toHaveTextContent(`${API_URL}/chat/completions`);
    expect(endpoints()).toContain("/v1/chat/completions");

    // Anthropic: the root URL (the SDK appends /v1 itself), its own headers and endpoint.
    chooseOption("Connection format", "Anthropic");
    expect(baseUrlText()).toHaveTextContent(new RegExp(`^${API_ROOT}$`));
    // A confirmation for the old URL must not carry over to the new one.
    expect(copyUrl).toHaveAccessibleName("Copy URL");
    fireEvent.click(copyUrl);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(API_ROOT));
    expect(snippet()).toHaveTextContent("x-api-key: <LOCAL_API_KEY>");
    expect(snippet()).toHaveTextContent("anthropic-version: 2023-06-01");
    expect(snippet()).toHaveTextContent(`${API_ROOT}/v1/messages`);
    expect(snippet()).not.toHaveTextContent("Authorization: Bearer");
    expect(endpoints()).toEqual(["/v1/messages"]);

    // The chosen example language survives a format change.
    chooseOption("Example language", "Python");
    expect(snippet()).toHaveTextContent(`from anthropic import Anthropic`);
    expect(snippet()).toHaveTextContent(`base_url="${API_ROOT}"`);
    chooseOption("Connection format", "OpenAI");
    expect(snippet()).toHaveTextContent("from openai import OpenAI");
    expect(snippet()).toHaveTextContent(`base_url="${API_URL}"`);
    fireEvent.click(copyUrl);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(API_URL));

    // The key is the same for both formats and never rendered.
    fireEvent.click(screen.getByRole("button", { name: "Copy API key" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(SECRET));
    expect(container.innerHTML).not.toContain(SECRET);

    // Format is a view of the same server: nothing was started, stopped or re-read.
    expect(api.startApiServer).not.toHaveBeenCalled();
    expect(api.stopApiServer).not.toHaveBeenCalled();
    expect(api.localModels).toHaveBeenCalledTimes(modelReads);
    expect(store.start).not.toHaveBeenCalled();
    expect(store.stop).not.toHaveBeenCalled();
    modelLifecycleCommands().forEach(command => expect(command).not.toHaveBeenCalled());
  });

  it("shows the URL for the saved port while stopped, in both formats, with copying disabled", async () => {
    render(page(storeWith(undefined, { cfg: { ...createTestStore().cfg!, port: 9191 } })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start API" })).toBeEnabled());

    expect(baseUrlText()).toHaveTextContent(/^http:\/\/127\.0\.0\.1:9191\/v1$/);
    chooseOption("Connection format", "Anthropic");
    expect(baseUrlText()).toHaveTextContent(/^http:\/\/127\.0\.0\.1:9191$/);
    expect(screen.getByRole("button", { name: "Copy URL" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy API key" })).toBeDisabled();
  });

  it("keeps the API key out of the examples and the copied example", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    const { container } = render(page(storeWith()));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy API key" })).toBeEnabled());
    openDisclosure("API reference & examples");

    expect(snippet()).toHaveTextContent("<LOCAL_API_KEY>");
    expect(snippet()).toHaveTextContent("<MODEL_ID>");
    const copyExample = screen.getByRole("button", { name: "Copy example" });
    fireEvent.click(copyExample);
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copied = String(writeText.mock.calls[0][0]);
    expect(copied).toContain("<LOCAL_API_KEY>");
    expect(copied).toContain(`${API_URL}/chat/completions`);
    expect(copied).not.toContain(SECRET);
    expect(container.innerHTML).not.toContain(SECRET);
    // Only the example was copied: the key button does not claim to have been used.
    expect(copyExample).toHaveAccessibleName("Copied");
    expect(screen.getByRole("button", { name: "Copy API key" })).toBeInTheDocument();
  });
});

describe("model IDs and navigation", () => {
  it("copies the exact ID of the chosen model and confirms only that row", async () => {
    // A sharded or unusual ID must be copied byte for byte, not grouped or shortened for display.
    const shard = "models/Qwen3 8B-Q4_K_M-00001-of-00003.gguf";
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    vi.mocked(api.localModels).mockResolvedValue([listed(shard), listed("models/other.gguf")]);
    const store = storeWith(privateModel);
    render(page(store));

    const row = (await screen.findByText(shard)).closest("li")!;
    const otherRow = screen.getByText("models/other.gguf").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Copy model ID" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(shard));
    expect(writeText).toHaveBeenCalledOnce();
    expect(within(row).getByRole("button")).toHaveAccessibleName("Copied");
    expect(within(otherRow).getByRole("button")).toHaveAccessibleName("Copy model ID");
    expect(document.querySelector(".sr-only[role='status']")).toHaveTextContent("Copied");
    expect(store.stop).not.toHaveBeenCalled();
    modelLifecycleCommands().forEach(command => expect(command).not.toHaveBeenCalled());
  });

  it.each([["stopped", stoppedApi], ["running", runningApi]] as const)("opens the model library through onNavigate while the API is %s", async (_state, status) => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(status);
    const onNavigate = vi.fn();
    const store = storeWith();
    render(page(store, "api", onNavigate));
    await waitFor(() => expect(screen.getByRole("button", { name: status.running ? "Stop API" : "Start API" })).toBeEnabled());
    await waitFor(() => expect(api.localModels).toHaveBeenCalledTimes(status.running ? 1 : 0));
    const modelReads = vi.mocked(api.localModels).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Open model library" }));

    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("models");
    // Navigating away neither changes the API nor loads or unloads a model.
    expect(api.startApiServer).not.toHaveBeenCalled();
    expect(api.stopApiServer).not.toHaveBeenCalled();
    expect(api.localModels).toHaveBeenCalledTimes(modelReads);
    expect(store.start).not.toHaveBeenCalled();
    modelLifecycleCommands().forEach(command => expect(command).not.toHaveBeenCalled());
  });

  it("opens model diagnostics from the server settings once they are expanded", async () => {
    const onNavigate = vi.fn();
    render(page(storeWith(), "api", onNavigate));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start API" })).toBeEnabled());
    openDisclosure("Server settings");

    fireEvent.click(screen.getByRole("button", { name: "Open model diagnostics" }));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("diagnostics");
    expect(api.stopApiServer).not.toHaveBeenCalled();
  });
});

describe("closed details", () => {
  it("keeps port settings and the API reference hidden until they are expanded", async () => {
    render(page(storeWith(), "api", vi.fn()));
    const start = await screen.findByRole("button", { name: "Start API" });
    await waitFor(() => expect(start).toBeEnabled());
    const port = screen.getByLabelText("API port");
    const diagnosticsLink = screen.getByRole("button", { name: "Open model diagnostics" });
    const reference = snippet()!;
    const table = screen.getByRole("table");

    for (const hidden of [port, diagnosticsLink, reference, table]) expect(hidden).not.toBeVisible();
    // The everyday controls never sit behind a disclosure.
    for (const shown of [start, screen.getByRole("button", { name: "Copy URL" }), screen.getByLabelText("Connection format"), screen.getByRole("button", { name: "Open model library" })]) {
      expect(shown).toBeVisible();
    }

    openDisclosure("Server settings");
    expect(port).toBeVisible();
    expect(diagnosticsLink).toBeVisible();
    expect(reference).not.toBeVisible();

    openDisclosure("API reference & examples");
    expect(reference).toBeVisible();
    expect(table).toBeVisible();
  });
});

describe("diagnostics screen", () => {
  it("shows model diagnostics only, with no API status request, control or polling", async () => {
    vi.useFakeTimers();
    const store = storeWith({ ...privateModel, log_tail: "llama-server: model loaded in 4.2s" });
    const { container } = render(page(store, "diagnostics"));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Diagnostics");
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Runtime diagnostics");
    expect(container.querySelector(".api-hint")).toHaveTextContent("Default model: model loaded · loaded.gguf");
    expect(container.querySelector("pre")).toHaveTextContent("llama-server: model loaded in 4.2s");
    // No API state is read, shown or controlled here, and the model's private server details stay private.
    for (const command of [api.apiServerStatus, api.startApiServer, api.stopApiServer, api.localModels, api.sessionSummaryList, ...modelLifecycleCommands()]) {
      expect(command).not.toHaveBeenCalled();
    }
    expect(screen.queryByRole("button", { name: /API/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    for (const selector of [".developer-api-status", ".api-model-count", ".api-model-list", "details"]) {
      expect(container.querySelector(selector)).not.toBeInTheDocument();
    }
    expect(container.textContent).not.toContain("private-internal-key");
    expect(container.textContent).not.toContain("127.0.0.1:49152");
  });

  it.each([
    ["the log tail over the error", { log_tail: "log line", error: "boom" }, "log line"],
    ["the error when there is no log", { error: "boom" }, "boom"],
    ["a note when nothing was reported", {}, "No runtime diagnostics reported."],
  ] as const)("shows %s", (_name, fields, expected) => {
    const { container } = render(page(storeWith({ state: "failed", ...fields }), "diagnostics"));
    expect(container.querySelector("pre")?.textContent).toBe(expected);
  });

  it("stops every API read when the app moves from the API screen to diagnostics, without stopping the API", async () => {
    vi.useFakeTimers();
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    const view = render(page(storeWith(), "api"));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(api.localModels).toHaveBeenCalledWith(API_URL, SECRET);
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    // While the API screen is shown its status is re-read periodically.
    expect(vi.mocked(api.apiServerStatus).mock.calls.length).toBeGreaterThan(1);

    view.rerender(page(storeWith(), "diagnostics"));
    const reads = () => [api.apiServerStatus, api.localModels, api.sessionSummaryList].map(command => vi.mocked(command).mock.calls.length);
    const before = reads();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(reads()).toEqual(before);
    expect(screen.queryByRole("button", { name: "Stop API" })).not.toBeInTheDocument();
    expect(api.stopApiServer).not.toHaveBeenCalled();

    // Coming back reads the real state again instead of trusting a stale one.
    view.rerender(page(storeWith(), "api"));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(vi.mocked(api.apiServerStatus).mock.calls.length).toBe(before[0] + 1);
    expect(screen.getByRole("button", { name: "Stop API" })).toBeEnabled();
  });

  it("does not read the API while the panel is hidden and reads once it is shown", async () => {
    vi.useFakeTimers();
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    const panel = (active: boolean) => <ActivePanelContext.Provider value={active}>{page(storeWith())}</ActivePanelContext.Provider>;
    const view = render(panel(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    for (const command of [api.apiServerStatus, api.localModels, api.sessionSummaryList]) expect(command).not.toHaveBeenCalled();
    // The status is unknown, so the button must not pretend to know it.
    expect(screen.getByRole("button", { name: "Start API" })).toBeDisabled();

    view.rerender(panel(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(api.apiServerStatus).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Stop API" })).toBeEnabled();
    expect(api.localModels).toHaveBeenCalledWith(API_URL, SECRET);
  });
});
