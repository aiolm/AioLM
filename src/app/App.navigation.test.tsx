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
import type { ViewId } from "../shared/types/navigation";

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
vi.mock("../features/developer/Developer", () => ({ default: ({ section, onNavigate }: { section?: string; onNavigate?: (view: ViewId) => void }) => <><p>Developer section: {section}</p><button onClick={() => onNavigate?.("models")}>Load a model</button></> }));
vi.mock("../features/tuning/Tuning", () => ({ default: () => <p>Parameter form</p> }));
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

  it('waits for configuration and completes first-run setup before mounting the workspace', async () => {
    store = createTestStore({ onboarding_completed: false });
    const pendingConfig = store.cfg;
    store.cfg = null; store.bootState = 'loading';
    const view = mount();
    expect(screen.queryByRole('navigation', { name: 'Primary navigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Choose your language' })).not.toBeInTheDocument();
    store.cfg = pendingConfig; store.bootState = 'ready';
    view.rerender(<I18nProvider initialLocale="en"><App /></I18nProvider>);
    expect(screen.getByRole('heading', { name: 'Choose your language' })).toBeVisible();
    expect(screen.queryByLabelText('Conversation draft')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Dark/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start using AioLM/ })); });
    expect(store.updateConfig).toHaveBeenCalledWith({ models_dir: 'models', onboarding_completed: true });
    expect(JSON.parse(localStorage.getItem('aiolm-preferences')!).values).toMatchObject({ locale: 'en', theme: 'dark' });
    expect(await screen.findByLabelText('Conversation draft')).toBeVisible();
    view.unmount();
    mount();
    expect(await screen.findByLabelText('Conversation draft')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Choose your language' })).not.toBeInTheDocument();
  });

  it('preserves the system language of an existing user who never saved a language preference', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('ko-KR');
    mount();
    expect(await screen.findByRole('navigation', { name: '기본 탐색' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '언어를 선택하세요' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('aiolm-preferences')!).values.locale).toBe('ko');
  });

  it('keeps setup pending when native persistence fails and enters the workspace only after retry', async () => {
    store = createTestStore({ onboarding_completed: false });
    vi.mocked(store.updateConfig).mockRejectedValueOnce(new Error('disk full'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start using AioLM/ })); });
    expect(screen.getByRole('alert')).toHaveTextContent('disk full');
    expect(store.cfg?.onboarding_completed).toBe(false);
    expect(screen.queryByLabelText('Conversation draft')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start using AioLM/ })); });
    expect(await screen.findByLabelText('Conversation draft')).toBeVisible();
    expect(store.cfg?.onboarding_completed).toBe(true);
  });

  it('does not persist completion if language and theme could not be saved', async () => {
    store = createTestStore({ onboarding_completed: false });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start using AioLM/ })); });
    expect(screen.getByRole('alert')).toHaveTextContent('storage unavailable');
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(store.cfg?.onboarding_completed).toBe(false);
  });

  it('keeps the current setup step mounted while an optimistic config save is pending or rejected', async () => {
    store = createTestStore({ onboarding_completed: false });
    let rejectSave!: (cause: Error) => void;
    vi.mocked(store.updateConfig).mockImplementationOnce(() => {
      store.cfg = { ...store.cfg!, onboarding_completed: true };
      return new Promise((_, reject) => { rejectSave = reject; });
    });
    const view = mount();
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Start using AioLM/ }));
    view.rerender(<I18nProvider initialLocale="en"><App /></I18nProvider>);
    expect(screen.getByRole('button', { name: /Saving/ })).toBeDisabled();
    expect(screen.queryByLabelText('Conversation draft')).not.toBeInTheDocument();
    await act(async () => {
      store.cfg = { ...store.cfg!, onboarding_completed: false };
      rejectSave(new Error('disk full'));
    });
    expect(screen.getByRole('heading', { name: 'Give your models a home' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('disk full');
    expect(screen.queryByLabelText('Conversation draft')).not.toBeInTheDocument();
  });

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

  it("offers one API server destination and no separate gateways page", async () => {
    mount();
    const navigation = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(within(navigation).getAllByRole("button", { name: /API server|Gateways|Local API/ })).toHaveLength(1);
    expect(within(navigation).queryByRole("button", { name: /Gateways/ })).not.toBeInTheDocument();
    fireEvent.click(mainTab("API server"));
    expect(await screen.findByText("Developer section: api")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "API server" })).toBeVisible();
    fireEvent.click(mainTab("Diagnostics"));
    expect(await screen.findByText("Developer section: diagnostics")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "Diagnostics" })).toBeVisible();
  });

  it("lets the API server page send people to the model library to load a model", async () => {
    mount();
    fireEvent.click(mainTab("API server"));
    fireEvent.click(await screen.findByRole("button", { name: "Load a model" }));
    expect(await screen.findByText("Model library")).toBeVisible();
    expect(mainTab("Run a model")).toHaveAttribute("aria-current", "page");
  });

  it("keeps eleven destinations and opens model selection over the current screen", async () => {
    mount();
    fireEvent.click(mainTab("Run a model"));
    await screen.findByText("Model library");
    expect(within(screen.getByRole("navigation", { name: "Primary navigation" })).getAllByRole("button")).toHaveLength(11);
    fireEvent.click(mainTab("Manage runtimes"));
    await screen.findByText("Saved runtime settings");
    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    expect(await screen.findByRole("dialog", { name: "Model settings editor" })).toBeVisible();
    expect(mainTab("Manage runtimes")).toHaveAttribute("aria-current", "page");
  });

  it("collapses the desktop sidebar to a named icon rail that survives page changes", async () => {
    const { container } = mount();
    const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    const sidebar = document.getElementById(collapse.getAttribute("aria-controls")!)!;
    expect(sidebar).toContainElement(collapse);
    expect(container.querySelectorAll(`[id="${sidebar.id}"]`)).toHaveLength(1);
    collapse.focus();
    fireEvent.click(collapse);
    expect(collapse).toHaveAccessibleName("Expand sidebar");
    expect(collapse).toHaveAttribute("aria-expanded", "false");
    expect(collapse).toHaveFocus();
    expect(container.querySelector(".app-shell")).toHaveClass("app-shell--rail");
    const rail = within(sidebar).getByRole("navigation", { name: "Primary navigation" });
    expect(within(rail).getAllByRole("button")).toHaveLength(11);
    expect(within(rail).getByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Chat" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(rail).getByRole("button", { name: "Projects" }));
    expect(await screen.findByLabelText("Project draft")).toBeVisible();
    expect(within(rail).getByRole("button", { name: "Projects" })).toHaveAttribute("aria-current", "page");
    expect(within(rail).getByRole("button", { name: "Projects" })).toHaveAttribute("title", "Projects");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");
    const drawerLinks = container.querySelectorAll(".aiolm-drawer .aiolm-nav-link");
    expect(drawerLinks).toHaveLength(11);
    drawerLinks.forEach(link => expect(link).not.toHaveAttribute("title"));
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".app-shell")).not.toHaveClass("app-shell--rail");
    expect(within(rail).getByRole("button", { name: "Projects" })).not.toHaveAttribute("title");
  });

  it("provides a single global unload action even during model load", async () => {
    store.status = { state: "starting" }; store.busy = true;
    mount();
    expect(document.querySelector(".aiolm-status")).toHaveTextContent("loading model");
    const stop = screen.getByRole("button", { name: "Unload" });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(store.stop).toHaveBeenCalledOnce();
    fireEvent.click(mainTab("Run a model"));
    await screen.findByText("Model library");
    expect(screen.getAllByRole("button", { name: "Unload" })).toHaveLength(1);
  });

  it("describes the header in model terms and unloads the model while a response is active", () => {
    store.status = { state: "running" };
    setSessionActivity("default", true);
    mount();
    expect(document.querySelector(".aiolm-status")).toHaveTextContent("model loaded");
    fireEvent.click(screen.getByRole("button", { name: "Unload" }));
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
