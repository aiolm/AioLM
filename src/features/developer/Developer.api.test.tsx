import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { I18nProvider } from "../../shared/i18n/i18n";
import type { AppStore } from "../../shared/state/store";
import type { ApiServerStatus, ServerStatus } from "../../shared/api/types";
import { createTestStore } from "../../testing/appStore";
import * as api from "../../shared/api/index";
import { SESSION_STATUS_CHANGED_EVENT } from "../../shared/runtime/sessionUtils";
import DeveloperPanel from "./Developer";
import { useApiServer } from "./useApiServer";

vi.mock("../../shared/api/index", () => ({
  apiServerStatus: vi.fn(),
  startApiServer: vi.fn(),
  stopApiServer: vi.fn(),
  localModels: vi.fn(),
  sessionSummaryList: vi.fn(async () => []),
  normalizeSessionList: vi.fn((value: unknown) => Array.isArray(value) ? value : []),
  // Model lifecycle commands: the API page must never reach any of them.
  startServer: vi.fn(),
  stopServer: vi.fn(),
  unloadModel: vi.fn(),
  sessionStart: vi.fn(),
  sessionStop: vi.fn(),
  sessionUnload: vi.fn(),
}));

const SECRET = "sk-test-secret-value";
const API_URL = "http://127.0.0.1:8080/v1";
const stoppedApi: ApiServerStatus = { running: false, url: null, api_key: null, port: 8080 };
const runningApi: ApiServerStatus = { running: true, url: API_URL, api_key: SECRET, port: 8080 };
// The model's own server is private: its URL and key must never leak into the API page.
const privateModel: ServerStatus = { state: "running", url: "http://127.0.0.1:49152/v1", api_key: "private-internal-key", model: "models/loaded.gguf" };

const modelLifecycleCommands = () => [api.startServer, api.stopServer, api.unloadModel, api.sessionStart, api.sessionStop, api.sessionUnload];

function storeWith(status: ServerStatus = { state: "stopped" }, overrides: Partial<AppStore> = {}): AppStore {
  return { ...createTestStore(), status, ...overrides };
}

function page(store: AppStore, section: "api" | "diagnostics" = "api"): ReactElement {
  return <I18nProvider initialLocale="en"><DeveloperPanel store={store} section={section} /></I18nProvider>;
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

const modelCount = () => document.querySelector(".api-model-count");

/** A promise the test settles by hand, to observe the pending state of an action. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.apiServerStatus).mockResolvedValue(stoppedApi);
  vi.mocked(api.localModels).mockResolvedValue([]);
  vi.mocked(api.startApiServer).mockResolvedValue(runningApi);
  vi.mocked(api.stopApiServer).mockResolvedValue(undefined);
});

describe("API server lifecycle", () => {
  it("starts the API while no model is loaded and shows the waiting state", async () => {
    const store = storeWith({ state: "stopped" });
    render(page(store));

    const start = await screen.findByRole("button", { name: "Start API" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);

    expect(await screen.findByRole("button", { name: "Stop API" })).toBeEnabled();
    expect(api.startApiServer).toHaveBeenCalledOnce();
    expect(screen.getAllByText("API running").length).toBeGreaterThan(0);
    expect(screen.getAllByText(API_URL).length).toBeGreaterThan(0);
    // The list is read through the API's own URL and key, and an empty list is a waiting state, not a failure.
    await waitFor(() => expect(api.localModels).toHaveBeenCalledWith(API_URL, SECRET));
    expect((await screen.findAllByText(/No model is loaded yet/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(store.start).not.toHaveBeenCalled();
    modelLifecycleCommands().forEach((command) => expect(command).not.toHaveBeenCalled());
  });

  it("shows separate busy state while starting and announces it politely", async () => {
    const pending = deferred<ApiServerStatus>();
    vi.mocked(api.startApiServer).mockReturnValueOnce(pending.promise);
    render(page(storeWith()));

    const start = await screen.findByRole("button", { name: "Start API" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);

    const busy = await screen.findByRole("button", { name: "Starting API…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    const status = document.querySelector<HTMLElement>(".developer-api-status")!;
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Starting API…");

    await act(async () => { pending.resolve(runningApi); await pending.promise; });
    expect(await screen.findByRole("button", { name: "Stop API" })).toBeEnabled();
    expect(status).toHaveTextContent("API running");
  });

  it("keeps the API running while the model loads, unloads and is replaced", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    vi.mocked(api.localModels).mockResolvedValue([]);
    const view = render(page(storeWith({ state: "stopped" })));
    expect(await screen.findByRole("button", { name: "Stop API" })).toBeEnabled();
    await waitFor(() => expect(api.localModels).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText(/No model is loaded yet/).length).toBeGreaterThan(0);

    // A model finishes loading: the list is read again, through the API, and shows it.
    vi.mocked(api.localModels).mockResolvedValue([{ id: "models/loaded.gguf", object: "model", owned_by: "llama.cpp" }]);
    view.rerender(page(storeWith(privateModel)));
    expect(await screen.findByText("models/loaded.gguf")).toBeInTheDocument();
    expect(api.localModels).toHaveBeenLastCalledWith(API_URL, SECRET);

    // The model is replaced by another one.
    vi.mocked(api.localModels).mockResolvedValue([{ id: "models/other.gguf", object: "model", owned_by: "llama.cpp" }]);
    view.rerender(page(storeWith({ ...privateModel, model: "models/other.gguf" })));
    expect(await screen.findByText("models/other.gguf")).toBeInTheDocument();

    // Then it is unloaded: the API stays up and is back to waiting for a model.
    vi.mocked(api.localModels).mockResolvedValue([]);
    view.rerender(page(storeWith({ state: "stopped" })));
    await waitFor(() => expect(screen.queryByText("models/other.gguf")).not.toBeInTheDocument());
    expect(screen.getAllByText(/No model is loaded yet/).length).toBeGreaterThan(0);

    expect(screen.getByRole("button", { name: "Stop API" })).toBeEnabled();
    expect(document.querySelector(".developer-api-status")).toHaveTextContent("API running");
    expect(api.startApiServer).not.toHaveBeenCalled();
    expect(api.stopApiServer).not.toHaveBeenCalled();
    // Only the API's own URL and key were ever used, never the model's private ones.
    for (const call of vi.mocked(api.localModels).mock.calls) expect(call).toEqual([API_URL, SECRET]);
  });

  it("never stops or unloads the model when the API is stopped", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    vi.mocked(api.localModels).mockResolvedValue([{ id: "models/loaded.gguf", object: "model", owned_by: "llama.cpp" }]);
    const store = storeWith(privateModel);
    render(page(store));

    const stop = await screen.findByRole("button", { name: "Stop API" });
    await waitFor(() => expect(stop).toBeEnabled());
    expect(await screen.findByText("models/loaded.gguf")).toBeInTheDocument();
    fireEvent.click(stop);

    expect(await screen.findByRole("button", { name: "Start API" })).toBeEnabled();
    expect(api.stopApiServer).toHaveBeenCalledOnce();
    expect(store.stop).not.toHaveBeenCalled();
    expect(store.start).not.toHaveBeenCalled();
    modelLifecycleCommands().forEach((command) => expect(command).not.toHaveBeenCalled());
    // The API list clears and asks to start the API again; nothing tells the loaded model to stop.
    await waitFor(() => expect(screen.queryByText("models/loaded.gguf")).not.toBeInTheDocument());
    expect(document.querySelector(".api-model-list")).not.toBeInTheDocument();
    expect(modelCount()).not.toBeInTheDocument();
    expect(screen.getByText("Start the API to see the models available to other apps.")).toBeInTheDocument();
    expect(screen.getByText("Start the server when you want to connect another app.")).toBeInTheDocument();
    expect(document.querySelector(".developer-api-status")).toHaveTextContent("API stopped");
  });

  it("reports a failed start without touching the model and lets the user retry", async () => {
    vi.mocked(api.startApiServer).mockRejectedValueOnce(new Error("address already in use: 127.0.0.1:8080"));
    const store = storeWith({ state: "stopped" });
    render(page(store));

    const start = await screen.findByRole("button", { name: "Start API" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Local API problem");
    expect(alert).toHaveTextContent("address already in use: 127.0.0.1:8080");
    // Still stopped, retryable, and no model command was issued.
    expect(screen.getByRole("button", { name: "Start API" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start API" })).not.toHaveAttribute("aria-busy", "true");
    expect(document.querySelector(".developer-api-status")).toHaveTextContent("API stopped");
    expect(store.start).not.toHaveBeenCalled();
    modelLifecycleCommands().forEach((command) => expect(command).not.toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Start API" }));
    expect(await screen.findByRole("button", { name: "Stop API" })).toBeEnabled();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(api.startApiServer).toHaveBeenCalledTimes(2);
  });

  it("re-reads the real status when a stop fails instead of guessing", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    vi.mocked(api.stopApiServer).mockRejectedValueOnce(new Error("listener is busy"));
    render(page(storeWith()));

    const stop = await screen.findByRole("button", { name: "Stop API" });
    await waitFor(() => expect(stop).toBeEnabled());
    fireEvent.click(stop);

    expect(await screen.findByRole("alert")).toHaveTextContent("listener is busy");
    expect(screen.getByRole("button", { name: "Stop API" })).toBeEnabled();
    expect(document.querySelector(".developer-api-status")).toHaveTextContent("API running");
  });
});

describe("API status freshness", () => {
  it("ignores a status read that began before a start finished", async () => {
    const { result } = renderHook(() => useApiServer(8080));
    await waitFor(() => expect(result.current.checked).toBe(true));

    // A read starts while the listener is still stopped and is answered late.
    const stale = deferred<ApiServerStatus>();
    vi.mocked(api.apiServerStatus).mockReturnValueOnce(stale.promise);
    let staleRead!: Promise<void>;
    act(() => { staleRead = result.current.refresh(); });
    await act(async () => { await result.current.start(); });
    expect(result.current.status.running).toBe(true);

    await act(async () => { stale.resolve(stoppedApi); await staleRead; });
    expect(result.current.status.running).toBe(true);
    expect(result.current.status.url).toBe(API_URL);
  });

  describe("polling", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    // The visibility spies must not outlive the test that installed them.
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it("stops polling when the page closes during a status read", async () => {
      const { unmount } = renderHook(() => useApiServer(8080));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const pending = deferred<ApiServerStatus>();
      vi.mocked(api.apiServerStatus).mockReturnValueOnce(pending.promise);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(api.apiServerStatus).toHaveBeenCalledTimes(2);

      unmount();
      await act(async () => { pending.resolve(stoppedApi); await pending.promise; });
      await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
      expect(api.apiServerStatus).toHaveBeenCalledTimes(2);
    });

    it("reflects a listener that stopped without the UI asking, only while active and visible", async () => {
      vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
      const { result, rerender } = renderHook(({ active }) => useApiServer(8080, active), { initialProps: { active: true } });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.status.running).toBe(true);

      // The backend reports the listener gone; the next visible tick shows it.
      vi.mocked(api.apiServerStatus).mockResolvedValue(stoppedApi);
      await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
      expect(result.current.status.running).toBe(false);
      expect(result.current.error).toBeNull();

      // A hidden window does not poll.
      vi.mocked(api.apiServerStatus).mockClear();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      await act(async () => { await vi.advanceTimersByTimeAsync(9500); });
      expect(api.apiServerStatus).not.toHaveBeenCalled();

      // Neither does an inactive page.
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      rerender({ active: false });
      vi.mocked(api.apiServerStatus).mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(9500); });
      expect(api.apiServerStatus).not.toHaveBeenCalled();
    });

    it("does not report a failing background read as an error and keeps the last status", async () => {
      vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
      const { result } = renderHook(() => useApiServer(8080));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      vi.mocked(api.apiServerStatus).mockRejectedValue(new Error("ipc unavailable"));
      await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
      expect(result.current.status.running).toBe(true);
      expect(result.current.error).toBeNull();
    });
  });

  it("re-reads the loaded models when a named session changes, not only the default one", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    vi.mocked(api.localModels).mockResolvedValue([]);
    vi.mocked(api.sessionSummaryList).mockResolvedValue([{ id: "default", name: "Default", state: "stopped" }]);
    render(page(storeWith({ state: "stopped" })));
    await waitFor(() => expect(api.sessionSummaryList).toHaveBeenCalled());
    await waitFor(() => expect(api.localModels).toHaveBeenCalledTimes(1));

    // A named session finishes loading its own model; the default session stays stopped.
    vi.mocked(api.localModels).mockResolvedValue([{ id: "models/named.gguf", object: "model", owned_by: "llama.cpp" }]);
    vi.mocked(api.sessionSummaryList).mockResolvedValue([
      { id: "default", name: "Default", state: "stopped" },
      { id: "work", name: "Work", state: "running", model: "models/named.gguf" },
    ]);
    act(() => { window.dispatchEvent(new Event(SESSION_STATUS_CHANGED_EVENT)); });

    expect(await screen.findByText("models/named.gguf")).toBeInTheDocument();
    expect(api.localModels).toHaveBeenLastCalledWith(API_URL, SECRET);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.stopApiServer).not.toHaveBeenCalled();
  });

  it("finishes checking models when a session refresh overtakes a manual refresh", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    vi.mocked(api.sessionSummaryList).mockResolvedValue([{ id: "default", name: "Default", state: "stopped" }]);
    render(page(storeWith()));
    await waitFor(() => expect(api.sessionSummaryList).toHaveBeenCalled());
    const check = await screen.findByRole("button", { name: "Refresh models" });
    await waitFor(() => expect(check).toBeEnabled());
    const pending = deferred<Awaited<ReturnType<typeof api.localModels>>>();
    vi.mocked(api.localModels).mockReturnValueOnce(pending.promise);
    fireEvent.click(check);
    expect(await screen.findByRole("button", { name: "Checking" })).toBeDisabled();

    vi.mocked(api.localModels).mockResolvedValue([{ id: "named.gguf", object: "model" }]);
    vi.mocked(api.sessionSummaryList).mockResolvedValue([
      { id: "default", name: "Default", state: "stopped" },
      { id: "work", name: "Work", state: "running", model: "named.gguf" },
    ]);
    act(() => { window.dispatchEvent(new Event(SESSION_STATUS_CHANGED_EVENT)); });
    expect(await screen.findByText("named.gguf")).toBeInTheDocument();
    await act(async () => { pending.resolve([]); await pending.promise; });
    expect(screen.getByRole("button", { name: "Refresh models" })).toBeEnabled();
    expect(screen.getByText("named.gguf")).toBeInTheDocument();
  });
});

describe("available model count", () => {
  const listed = (id: string) => ({ id, object: "model", owned_by: "llama.cpp" });

  it("shows no count until the API answers, then the real count including zero", async () => {
    const answer = deferred<Array<{ id: string; object: string; owned_by: string }>>();
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    vi.mocked(api.localModels).mockReturnValueOnce(answer.promise);
    render(page(storeWith()));

    await waitFor(() => expect(api.localModels).toHaveBeenCalled());
    // Waiting for the first answer is neither a count of zero nor an empty list.
    expect(modelCount()).not.toBeInTheDocument();
    expect(screen.getByText("Checking available models…")).toBeInTheDocument();

    await act(async () => { answer.resolve([]); await answer.promise; });
    await waitFor(() => expect(modelCount()).toHaveTextContent("0"));
    expect(document.querySelector(".api-model-list")).not.toBeInTheDocument();

    // Once the listener is stopped the count is unavailable again, not zero.
    fireEvent.click(screen.getByRole("button", { name: "Stop API" }));
    await waitFor(() => expect(modelCount()).not.toBeInTheDocument());
  });

  it("counts every listed model next to its heading", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    vi.mocked(api.localModels).mockResolvedValue([listed("models/a.gguf"), listed("models/b.gguf"), listed("models/c.gguf")]);
    render(page(storeWith()));

    await waitFor(() => expect(modelCount()).toHaveTextContent("3"));
    expect(document.querySelectorAll(".api-model-list li")).toHaveLength(3);
    expect(screen.getByRole("heading", { name: /Available models/ })).toContainElement(modelCount() as HTMLElement);
  });

  it("does not turn an unreadable model list into a count of zero, and recovers on refresh", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    vi.mocked(api.localModels).mockRejectedValueOnce(new Error("models endpoint unreachable"));
    render(page(storeWith()));

    expect(await screen.findByRole("alert")).toHaveTextContent("models endpoint unreachable");
    expect(modelCount()).not.toBeInTheDocument();
    expect(screen.getByText("The model list could not be read. Try refreshing it.")).toBeInTheDocument();
    // The listener itself is fine: only the list is unavailable.
    expect(screen.getByRole("button", { name: "Stop API" })).toBeEnabled();
    expect(document.querySelector(".developer-api-status")).toHaveTextContent("API running");

    vi.mocked(api.localModels).mockResolvedValue([listed("models/a.gguf")]);
    const refresh = screen.getByRole("button", { name: "Refresh models" });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    await waitFor(() => expect(modelCount()).toHaveTextContent("1"));
    expect(screen.getByText("models/a.gguf")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("drops a model list that arrives after the API was stopped", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    const late = deferred<Array<{ id: string; object: string; owned_by: string }>>();
    vi.mocked(api.localModels).mockReturnValueOnce(late.promise);
    render(page(storeWith()));
    await waitFor(() => expect(api.localModels).toHaveBeenCalled());

    const stop = await screen.findByRole("button", { name: "Stop API" });
    await waitFor(() => expect(stop).toBeEnabled());
    fireEvent.click(stop);
    expect(await screen.findByRole("button", { name: "Start API" })).toBeEnabled();

    await act(async () => { late.resolve([listed("models/late.gguf")]); await late.promise; });
    expect(screen.queryByText("models/late.gguf")).not.toBeInTheDocument();
    expect(modelCount()).not.toBeInTheDocument();
    expect(screen.getByText("Start the API to see the models available to other apps.")).toBeInTheDocument();
  });
});

describe("API key and connection details", () => {
  it("copies the API key without ever rendering it", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container } = render(page(storeWith(privateModel)));

    const copy = await screen.findByRole("button", { name: "Copy API key" });
    await waitFor(() => expect(copy).toBeEnabled());
    fireEvent.click(copy);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    // A polite live region announces the copy; the secret itself appears nowhere in the page.
    expect(document.querySelector(".sr-only[role='status']")).toHaveTextContent("Copied");
    expect(container.textContent).not.toContain(SECRET);
    expect(container.innerHTML).not.toContain(SECRET);
    expect(container.textContent).not.toContain("private-internal-key");
  });

  it("disables key and URL copying while the API is stopped", async () => {
    render(page(storeWith()));
    expect(await screen.findByRole("button", { name: "Copy API key" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy URL" })).toBeDisabled();
  });

  it("announces a failed key copy and still hides the key", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => { throw new Error("Clipboard permission denied"); }) }, configurable: true });
    const { container } = render(page(storeWith()));

    const copy = await screen.findByRole("button", { name: "Copy API key" });
    await waitFor(() => expect(copy).toBeEnabled());
    fireEvent.click(copy);

    expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard permission denied");
    expect(container.textContent).not.toContain(SECRET);
    expect(screen.getByRole("button", { name: "Copy API key" })).toBeEnabled();
  });

  it("lists only the endpoints the selected format serves and no LM Studio REST or HTTP model management", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    const { container } = render(page(storeWith()));
    await screen.findByRole("button", { name: "Stop API" });
    openDisclosure("API reference & examples");

    const endpoints = () => Array.from(container.querySelectorAll(".api-endpoints tbody code"), code => code.textContent).sort();
    expect(endpoints()).toEqual(["/v1/chat/completions", "/v1/completions", "/v1/embeddings", "/v1/models", "/v1/responses", "/v1/responses/<id>"]);

    chooseOption("Connection format", "Anthropic");
    expect(endpoints()).toEqual(["/v1/messages"]);
    expect(container.querySelector("pre.api-code")).toHaveTextContent(`${API_URL.replace(/\/v1$/, "")}/v1/messages`);

    expect(container.textContent).not.toMatch(/LM Studio/i);
    expect(container.textContent).not.toContain("/api/v1/chat");
    expect(container.textContent).not.toMatch(/load\/unload|download status|model lifecycle endpoints/i);
  });
});

describe("API port", () => {
  it("saves the port for the next API start without restarting anything", async () => {
    const store = storeWith();
    render(page(store));
    openDisclosure("Server settings");
    const port = await screen.findByRole("spinbutton", { name: "API port" });
    await waitFor(() => expect(port).toBeEnabled());

    fireEvent.change(port, { target: { value: "9090" } });
    fireEvent.click(screen.getByRole("button", { name: "Save port" }));

    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledWith({ port: 9090 }));
    expect(api.stopApiServer).not.toHaveBeenCalled();
    expect(api.startApiServer).not.toHaveBeenCalled();
    modelLifecycleCommands().forEach((command) => expect(command).not.toHaveBeenCalled());
  });

  it("restarts only the API to apply a port change while a model stays loaded", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    const order: string[] = [];
    vi.mocked(api.stopApiServer).mockImplementation(async () => { order.push("stop-api"); });
    vi.mocked(api.startApiServer).mockImplementation(async () => { order.push("start-api"); return { ...runningApi, url: "http://127.0.0.1:9090/v1", port: 9090 }; });
    const store = storeWith(privateModel);
    vi.mocked(store.updateConfig).mockImplementation(async (patch) => { order.push("save-config"); return Object.assign(store.cfg!, typeof patch === "function" ? patch(store.cfg!) : patch); });
    render(page(store));

    openDisclosure("Server settings");
    const port = await screen.findByRole("spinbutton", { name: "API port" });
    await waitFor(() => expect(port).toBeEnabled());
    fireEvent.change(port, { target: { value: "9090" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and restart API" }));

    await waitFor(() => expect(order).toEqual(["save-config", "stop-api", "start-api"]));
    expect((await screen.findAllByText("http://127.0.0.1:9090/v1")).length).toBeGreaterThan(0);
    expect(store.stop).not.toHaveBeenCalled();
    expect(store.start).not.toHaveBeenCalled();
    modelLifecycleCommands().forEach((command) => expect(command).not.toHaveBeenCalled());
  });

  it("offers an API restart when the saved port differs from the one in use", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    render(page(storeWith(undefined, { cfg: { ...createTestStore().cfg!, port: 9191 } })));

    openDisclosure("Server settings");
    expect(await screen.findByText(/Port 9191 is saved, but the API is still listening on 8080/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart API" }));
    await waitFor(() => expect(api.startApiServer).toHaveBeenCalledOnce());
    expect(api.stopApiServer).toHaveBeenCalledOnce();
  });

  it("keeps the draft and reports an error when the port cannot be saved", async () => {
    const store = storeWith();
    vi.mocked(store.updateConfig).mockRejectedValueOnce(new Error("Configuration was not saved"));
    render(page(store));
    openDisclosure("Server settings");
    const port = await screen.findByRole("spinbutton", { name: "API port" });
    await waitFor(() => expect(port).toBeEnabled());

    fireEvent.change(port, { target: { value: "9090" } });
    fireEvent.click(screen.getByRole("button", { name: "Save port" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Configuration was not saved");
    expect(port).toHaveValue(9090);
    expect(api.startApiServer).not.toHaveBeenCalled();
  });

  it("rejects ports outside 1-65535", async () => {
    render(page(storeWith()));
    openDisclosure("Server settings");
    const port = await screen.findByRole("spinbutton", { name: "API port" });
    await waitFor(() => expect(port).toBeEnabled());
    for (const value of ["0", "65536", "1.5", ""]) {
      fireEvent.change(port, { target: { value } });
      expect(port).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("button", { name: "Save port" })).toBeDisabled();
    }
  });
});

describe("API server screen", () => {
  it("offers one lifecycle and reads the same backend state on every mount", async () => {
    const stopped = render(page(storeWith()));
    const start = await screen.findByRole("button", { name: "Start API" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(await screen.findByRole("button", { name: "Stop API" })).toBeEnabled();
    expect(api.startApiServer).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /gateway/i })).not.toBeInTheDocument();
    stopped.unmount();

    // A second mount reads the same backend state rather than keeping its own.
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    render(page(storeWith()));
    expect(await screen.findByRole("button", { name: "Stop API" })).toBeEnabled();
    expect(api.startApiServer).toHaveBeenCalledOnce();
    modelLifecycleCommands().forEach((command) => expect(command).not.toHaveBeenCalled());
  });

  it("keeps the model status out of the API lifecycle", async () => {
    vi.mocked(api.apiServerStatus).mockResolvedValue(runningApi);
    const view = render(page(storeWith({ state: "starting" })));
    await screen.findByRole("button", { name: "Stop API" });
    // While the default model is still loading the API is up and says the list will fill in.
    expect(await screen.findByText("The model is loading. It will appear here when ready.")).toBeInTheDocument();

    view.rerender(page(storeWith({ state: "stopped" })));
    expect(await screen.findByText(/No model is loaded yet/)).toBeInTheDocument();
    vi.mocked(api.localModels).mockResolvedValue([{ id: "models/loaded.gguf", object: "model", owned_by: "llama.cpp" }]);
    view.rerender(page(storeWith(privateModel)));
    expect(await screen.findByText("models/loaded.gguf")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Stop API" })).toBeEnabled();
    expect(document.querySelector(".developer-api-status")).toHaveTextContent("API running");
    expect(api.stopApiServer).not.toHaveBeenCalled();
    expect(api.startApiServer).not.toHaveBeenCalled();
    modelLifecycleCommands().forEach((command) => expect(command).not.toHaveBeenCalled());
  });
});
