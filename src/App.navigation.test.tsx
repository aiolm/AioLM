import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "./i18n";
import { createTestStore } from "./testing/appStore";
import type { AppStore } from "./store";
import App from "./App";
import { registerTask, removeTask } from "./taskRegistry";

let store: AppStore;
vi.mock("./store", () => ({ useAppStore: () => store }));
vi.mock("./panels/Chat", () => ({ default: () => <input aria-label="Conversation draft" /> }));
vi.mock("./panels/Projects", () => ({ default: ({ onOpenTuning }: { onOpenTuning: () => void }) => <><input aria-label="Project draft" /><button onClick={onOpenTuning}>Project parameters</button></> }));
vi.mock("./panels/Models", () => ({ default: () => <p>Model library</p> }));
vi.mock("./panels/Runtimes", () => ({ default: ({ onOpenProfiles }: { onOpenProfiles: () => void }) => <button onClick={onOpenProfiles}>Saved runtime settings</button> }));
vi.mock("./panels/Sessions", () => ({ default: () => <p>Sessions content</p> }));
vi.mock("./panels/Discover", () => ({ default: () => <p>Discover content</p> }));
vi.mock("./panels/Tuning", () => ({ default: () => <p>Parameter form</p> }));
vi.mock("./panels/ExecutionProfiles", () => ({ default: () => <p>Saved profiles</p> }));
vi.mock("./panels/Bench", () => ({ default: () => <input aria-label="Benchmark result" /> }));

describe("Workspace navigation", () => {
  beforeEach(() => { localStorage.clear(); store = createTestStore(); });
  afterEach(() => { act(() => removeTask("blocked-navigation")); vi.restoreAllMocks(); });
  const mount = () => render(<I18nProvider initialLocale="en"><App /></I18nProvider>);
  const mainTab = (name: string) => within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("button", { name });

  it("applies the task leave guard to sidebar, header and panel shortcuts", async () => {
    mount();
    fireEvent.click(mainTab("Projects"));
    await screen.findByText("Project parameters");
    act(() => { registerTask({id:"blocked-navigation",kind:"other",label:"Saving work",interruptible:false}); });
    const confirm=vi.spyOn(window,"confirm").mockReturnValue(false);
    fireEvent.click(mainTab("Library"));
    fireEvent.click(screen.getByRole("button",{name:"model.gguf"}));
    fireEvent.click(screen.getByText("Project parameters"));
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText("Project draft")).toBeVisible();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText("Project parameters"));
    expect(await screen.findByText("Parameter form")).toBeVisible();
  });

  it("keeps projects beside conversations and retains the conversation draft", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("Conversation draft"), { target: { value: "Keep this" } });
    fireEvent.click(mainTab("Projects"));
    fireEvent.change(await screen.findByLabelText("Project draft"), { target: { value: "New workspace" } });
    fireEvent.click(await screen.findByText("Project parameters"));
    expect(await screen.findByText("Parameter form")).toBeVisible();
    expect(store.start).not.toHaveBeenCalled();
    expect(store.stop).not.toHaveBeenCalled();
    fireEvent.click(mainTab("Chat"));
    expect(screen.getByLabelText("Conversation draft")).toHaveValue("Keep this");
    fireEvent.click(mainTab("Projects"));
    expect(screen.getByLabelText("Project draft")).toHaveValue("New workspace");
  });

  it("exposes all fifteen destinations and routes the global model picker back to the library", async () => {
    mount();
    fireEvent.click(mainTab("Library"));
    await screen.findByText("Model library");
    expect(within(screen.getByRole("navigation", { name: "Primary navigation" })).getAllByRole("button")).toHaveLength(15);
    fireEvent.click(mainTab("Runtimes"));
    await screen.findByText("Saved runtime settings");
    fireEvent.click(screen.getByRole("button", { name: "model.gguf" }));
    expect(await screen.findByText("Model library")).toBeVisible();
  });

  it("provides a single global stop action even during startup", async () => {
    store.status = { state: "starting" }; store.busy = true;
    mount();
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(store.stop).toHaveBeenCalledOnce();
    fireEvent.click(mainTab("Library"));
    await screen.findByText("Model library");
    expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
  });

  it("keeps benchmark state when changing tuning sections", async () => {
    mount();
    fireEvent.click(mainTab("Parameters"));
    fireEvent.click(mainTab("Benchmark"));
    fireEvent.change(await screen.findByLabelText("Benchmark result"), { target: { value: "completed 24 t/s" } });
    fireEvent.click(mainTab("Execution profiles"));
    expect(await screen.findByText("Saved profiles")).toBeVisible();
    fireEvent.click(mainTab("Benchmark"));
    expect(screen.getByLabelText("Benchmark result")).toHaveValue("completed 24 t/s");
  });
});
