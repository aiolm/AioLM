import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nProvider } from "../shared/i18n/i18n";
import { createTestStore } from "../testing/appStore";
import type { AppStore } from "../shared/state/store";
import App from "./App";
import { getTaskSnapshot, registerTask, removeTask } from "../shared/state/taskRegistry";
import { LocalTaskCancelButton } from "../shared/ui/TaskCancellation";
import { setSessionActivity } from "../shared/state/sessionActivity";
import type { ModelSettingsDialogProps } from "../features/model-settings/ModelSettingsDialog";

let store: AppStore;
let showBenchmarkCancel = false;
let benchmarkLoading: Promise<void> | null = null;
const cancelBenchmark = vi.fn();
vi.mock("../shared/state/store", () => ({ useAppStore: () => store }));
vi.mock("../features/chat/Chat", () => ({ default: () => <input aria-label="Conversation draft" /> }));
vi.mock("../features/projects/Projects", () => ({ default: ({ onOpenTuning }: { onOpenTuning: () => void }) => <><input aria-label="Project draft" /><button onClick={onOpenTuning}>Project parameters</button></> }));
vi.mock("../features/models/Models", () => ({ default: () => <p>Model library</p> }));
vi.mock('../features/models/ModelWorkspace', () => ({ default: ({ section }: { section: { id: string } }) => <><p>Model library</p>{section.id === 'tuning' && <p>Parameter form</p>}{section.id === 'profiles' && <p>Saved profiles</p>}</> }));
vi.mock("../features/runtimes/Runtimes", () => ({ default: ({ onOpenProfiles }: { onOpenProfiles: () => void }) => <button onClick={onOpenProfiles}>Saved runtime settings</button> }));
vi.mock("../features/sessions/Sessions", () => ({ default: () => <p>Sessions content</p> }));
vi.mock("../features/discover/Discover", () => ({ default: () => <p>Discover content</p> }));
vi.mock("../features/tuning/Tuning", () => ({ default: () => <p>Parameter form</p> }));
vi.mock("../features/profiles/ExecutionProfiles", () => ({ default: () => <p>Saved profiles</p> }));
vi.mock("../features/bench/Bench", () => ({ default: () => {
  if (benchmarkLoading) throw benchmarkLoading;
  return <><input aria-label="Benchmark result" />{showBenchmarkCancel && <LocalTaskCancelButton taskId="performance-benchmark-active" onClick={cancelBenchmark}>Cancel benchmark</LocalTaskCancelButton>}</>;
} }));
vi.mock("../features/model-settings/ModelSettingsDialog", () => ({ default: ({ open, initialConfig, initialSection, requireModelSelection, onClose }: ModelSettingsDialogProps) => open ? <div role="dialog" aria-label="Model settings editor"><p>{initialSection ?? "model"}</p><input aria-label="Editor model" value={requireModelSelection ? '' : initialConfig.active_model} readOnly /><button onClick={onClose}>Close editor</button></div> : null }));

describe("Workspace navigation", () => {
  beforeEach(() => { localStorage.clear(); store = createTestStore(); showBenchmarkCancel = false; benchmarkLoading = null; cancelBenchmark.mockReset(); });
  afterEach(() => { act(() => { for (const task of getTaskSnapshot()) removeTask(task.id); setSessionActivity("default", false); }); vi.restoreAllMocks(); });
  const mount = () => render(<I18nProvider initialLocale="en"><App /></I18nProvider>);
  const mainTab = (name: string) => within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("button", { name });

  it("opens global errors above the retained activity bar and preserves dismissal", async () => {
    store.actionError = "The model could not be started.";
    const view = mount();
    const drawer = view.container.querySelector<HTMLDetailsElement>("details.app-activity")!;
    await waitFor(() => expect(drawer.open).toBe(true));
    expect(drawer).not.toHaveAttribute("hidden");
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("The model could not be started.");
    expect(drawer.querySelector("summary")).toBeVisible();
    fireEvent.click(within(error).getByRole("button", { name: "Dismiss" }));
    expect(store.clearErrors).toHaveBeenCalledOnce();
  });

  it("keeps global cancellation through panel loading and restores it after leaving the owner page", async () => {
    showBenchmarkCancel = true;
    let release!: () => void;
    benchmarkLoading = new Promise<void>(resolve => { release = resolve; });
    const view = mount();
    act(() => { registerTask({ id: "performance-benchmark-active", kind: "benchmark", label: "Benchmark task", interruptible: true, cancel: cancelBenchmark }); });
    fireEvent.click(view.container.querySelector("details.app-activity > summary")!);
    const strip = screen.getByTestId("task-strip");
    expect(within(strip).getByRole("button", { name: "Cancel" })).toBeEnabled();
    fireEvent.click(mainTab("Benchmark"));
    expect(screen.queryByRole("button", { name: "Cancel benchmark" })).not.toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: "Cancel" })).toBeEnabled();
    await act(async () => { benchmarkLoading = null; release(); });
    expect(await screen.findByRole("button", { name: "Cancel benchmark" })).toBeVisible();
    await waitFor(() => expect(within(strip).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument());
    expect(within(strip).getByText("Benchmark task")).toBeVisible();
    fireEvent.click(mainTab("Chat"));
    const globalCancel = await within(strip).findByRole("button", { name: "Cancel" });
    expect(globalCancel).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cancel benchmark" })).not.toBeInTheDocument();
    fireEvent.click(globalCancel);
    expect(cancelBenchmark).toHaveBeenCalledOnce();
    fireEvent.click(mainTab("Benchmark"));
    const pendingCancel = await screen.findByRole("button", { name: "Cancelling" });
    expect(pendingCancel).toBeDisabled();
    expect(strip).not.toContainElement(pendingCancel);
    fireEvent.click(pendingCancel);
    expect(cancelBenchmark).toHaveBeenCalledOnce();
  });

  it("shows the grouped model name in the header while retaining the first shard path", async () => {
    const name = "Qwen3.8-Flash-Next-AD-4.27bpw-Q4_K_M-M64";
    const path = `C:/models/${name}-00001-of-00033.gguf`;
    store = createTestStore({ active_model: path });
    store.status = { state: 'running', model: path };
    mount();
    const model = screen.getByRole("button", { name: `Choose model: ${name}.gguf` });
    expect(model).toHaveAttribute("title", path);
    fireEvent.click(model);
    expect(await screen.findByRole("dialog", { name: "Model settings editor" })).toBeVisible();
    expect(screen.getByLabelText("Editor model")).toHaveValue(path);
    expect(mainTab("Chat")).toHaveAttribute("aria-current", "page");
    expect(store.cfg?.active_model).toBe(path);
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('shows the loaded model and opens its live settings when another model was saved', async () => {
    store = createTestStore({ active_model: 'models/next.gguf', ctx_size: 8192 });
    store.status = { state: 'running', model: 'models/loaded.gguf', execution: { active_model: 'models/loaded.gguf', ctx_size: 4096 } };
    mount();
    expect(screen.queryByText('next.gguf')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose model: loaded.gguf' }));
    await screen.findByRole('dialog', { name: 'Model settings editor' });
    expect(screen.getByLabelText('Editor model')).toHaveValue('models/loaded.gguf');
    expect(store.cfg?.active_model).toBe('models/next.gguf');
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('opens the last saved model settings when stopped without starting the model', async () => {
    store.status = { state: 'stopped', model: 'model.gguf' };
    mount();
    expect(screen.queryByText('model.gguf')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));
    await screen.findByRole('dialog', { name: 'Model settings editor' });
    expect(screen.getByLabelText('Editor model')).toHaveValue('model.gguf');
    expect(store.start).not.toHaveBeenCalled();
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it("guards navigation while settings can open without leaving the current workspace", async () => {
    mount();
    fireEvent.click(mainTab("Projects"));
    await screen.findByText("Project parameters");
    act(() => { registerTask({id:"blocked-navigation",kind:"other",label:"Saving work",interruptible:false}); });
    const confirm=vi.spyOn(window,"confirm").mockReturnValue(false);
    fireEvent.click(mainTab("Run a model"));
    expect(confirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button",{name:"Choose model"}));
    await screen.findByRole("dialog", { name: "Model settings editor" });
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(screen.getByText("Project parameters"));
    expect(await screen.findByText("tuning")).toBeVisible();
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Project draft")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    confirm.mockReturnValue(true);
    fireEvent.click(mainTab("Run a model"));
    expect(await screen.findByText("Model library")).toBeVisible();
  });

  it("keeps projects beside conversations and retains the conversation draft", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("Conversation draft"), { target: { value: "Keep this" } });
    fireEvent.click(mainTab("Projects"));
    fireEvent.change(await screen.findByLabelText("Project draft"), { target: { value: "New workspace" } });
    fireEvent.click(await screen.findByText("Project parameters"));
    expect(await screen.findByText("tuning")).toBeVisible();
    expect(store.start).not.toHaveBeenCalled();
    expect(store.stop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(mainTab("Chat"));
    expect(screen.getByLabelText("Conversation draft")).toHaveValue("Keep this");
    fireEvent.click(mainTab("Projects"));
    expect(screen.getByLabelText("Project draft")).toHaveValue("New workspace");
  });

  it("keeps twelve destinations and opens model selection over the current screen", async () => {
    mount();
    fireEvent.click(mainTab("Run a model"));
    await screen.findByText("Model library");
    expect(within(screen.getByRole("navigation", { name: "Primary navigation" })).getAllByRole("button")).toHaveLength(12);
    fireEvent.click(mainTab("Manage runtimes"));
    await screen.findByText("Saved runtime settings");
    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    expect(await screen.findByRole("dialog", { name: "Model settings editor" })).toBeVisible();
    expect(mainTab("Manage runtimes")).toHaveAttribute("aria-current", "page");
  });

  it("provides a single global stop action even during startup", async () => {
    store.status = { state: "starting" }; store.busy = true;
    mount();
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(store.stop).toHaveBeenCalledOnce();
    fireEvent.click(mainTab("Run a model"));
    await screen.findByText("Model library");
    expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
  });

  it("stops the running server while a response is active", () => {
    store.status = { state: "running" };
    setSessionActivity("default", true);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(store.stop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Model settings editor" })).not.toBeInTheDocument();
    expect(store.start).not.toHaveBeenCalled();
  });

  it("keeps benchmark state when changing tuning sections", async () => {
    mount();
    fireEvent.click(mainTab("Run a model"));
    fireEvent.click(mainTab("Benchmark"));
    fireEvent.change(await screen.findByLabelText("Benchmark result"), { target: { value: "completed 24 t/s" } });
    fireEvent.click(mainTab("Manage runtimes"));
    fireEvent.click(await screen.findByText('Saved runtime settings'));
    expect(await screen.findByText("profiles")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(mainTab("Benchmark"));
    expect(screen.getByLabelText("Benchmark result")).toHaveValue("completed 24 t/s");
  });
});
