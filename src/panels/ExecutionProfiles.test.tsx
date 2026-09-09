import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { createTestStore } from "../testing/appStore";
import { createServerProfile, loadProfiles, saveServerProfile, serverProfilePatch, createModelProfile, modelProfilePatch, saveModelProfile } from "../modelProfiles";
import { writeLoadingProfiles } from "../runtimeUtils";
import ExecutionProfiles from "./ExecutionProfiles";

describe("Saved execution settings", () => {
  beforeEach(() => localStorage.clear());

  it("previews selection without applying it; load preserves sampling and its defaults", async () => {
    const store = createTestStore({ runtime_defaults: ["temperature"], temperature: 0.65 });
    const initial = loadProfiles(store.cfg!, "model.gguf");
    const saved = createServerProfile({ ...store.cfg!, ctx_size: 8192, runtime_defaults: ["ngl"] }, "Long context");
    saveServerProfile(saved);
    render(<I18nProvider initialLocale="en"><ExecutionProfiles store={store} modelPath="model.gguf" /></I18nProvider>);
    fireEvent.change(screen.getByLabelText("Select server profile"), { target: { value: saved.id } });
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(loadProfiles(store.cfg!, "model.gguf").activeServerId).toBe(initial.activeServerId);
    const card = screen.getByRole("heading", { name: "Server profile" }).closest("section")!;
    fireEvent.click(within(card).getByRole("button", { name: "Load saved settings" }));
    await waitFor(() => expect(store.cfg?.ctx_size).toBe(8192));
    expect(store.cfg?.temperature).toBe(0.65);
    expect(store.cfg?.runtime_defaults).toEqual(["temperature", "ngl"]);
    expect(loadProfiles(store.cfg!, "model.gguf").activeServerId).toBe(saved.id);
    expect(store.start).not.toHaveBeenCalled();
    expect(store.stop).not.toHaveBeenCalled();
  });

  it("captures current values under a name without duplicating field editors", () => {
    const store = createTestStore({ active_build: "b123", ctx_size: 12288 });
    render(<I18nProvider initialLocale="en"><ExecutionProfiles store={store} modelPath="model.gguf" /></I18nProvider>);
    const card = screen.getByRole("heading", { name: "Server profile" }).closest("section")!;
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "New profile" }));
    fireEvent.change(within(card).getByLabelText("Profile name"), { target: { value: "Work" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    const saved = loadProfiles(store.cfg!, "model.gguf").server.find((profile) => profile.name === "Work")!;
    expect(serverProfilePatch(saved)).toMatchObject({ ctx_size: 12288, active_build: "b123" });
  });

  it("requires confirmation before replacing a saved preset", () => {
    const store = createTestStore();
    loadProfiles(store.cfg!, "model.gguf");
    store.cfg = { ...store.cfg!, ctx_size: 16384 };
    render(<I18nProvider initialLocale="en"><ExecutionProfiles store={store} modelPath="model.gguf" /></I18nProvider>);
    fireEvent.click(screen.getAllByRole("button", { name: "Save current" })[0]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(loadProfiles(store.cfg!, "model.gguf").server[0].ctx_size).toBe(4096);
  });

  it("keeps selection unchanged when persistence fails", async () => {
    const store = createTestStore();
    const initial = loadProfiles(store.cfg!, "model.gguf");
    const saved = createServerProfile(store.cfg!, "Other");
    saveServerProfile(saved);
    store.updateConfig = vi.fn(async () => { throw new Error("Disk full"); });
    render(<I18nProvider initialLocale="en"><ExecutionProfiles store={store} modelPath="model.gguf" /></I18nProvider>);
    fireEvent.change(screen.getByLabelText("Select server profile"), { target: { value: saved.id } });
    fireEvent.click(screen.getAllByRole("button", { name: "Load saved settings" })[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk full");
    expect(loadProfiles(store.cfg!, "model.gguf").activeServerId).toBe(initial.activeServerId);
  });

  it("keeps older launch presets accessible from the same screen", async () => {
    const store = createTestStore();
    writeLoadingProfiles([{ id: "old", name: "Old laptop", backend: "cpu", build: "b100", active_model: "old.gguf", mmproj: "", ctx_size: 8192, ngl: 0, threads: 6, flash_attn: "auto" }]);
    render(<I18nProvider initialLocale="en"><ExecutionProfiles store={store} modelPath="model.gguf" /></I18nProvider>);
    fireEvent.click(screen.getByText(/Previously saved launch presets/));
    const row = screen.getByText("Old laptop").closest(".legacy-profile-row")!;
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Load saved settings" }));
    await waitFor(() => expect(store.cfg?.active_model).toBe("old.gguf"));
    expect(store.cfg?.ctx_size).toBe(8192);
  });

  it("captures stop strings along with sampling values", () => {
    const store = createTestStore({ chat_options: { stop: ["<end>"], seed: 42 } });
    const profile = createModelProfile(store.cfg!, "Deterministic");
    expect(modelProfilePatch(profile).chat_options).toEqual({ stop: ["<end>"], seed: 42 });
  });

  it("saves a shared profile without a model and keeps it available after a model change", () => {
    const store = createTestStore({ active_model: "", temperature: 0.45 });
    const view = render(<I18nProvider initialLocale="en"><ExecutionProfiles store={store} modelPath="" /></I18nProvider>);
    const card = screen.getByRole("heading", { name: "Shared model profile" }).closest("section")!;
    fireEvent.click(within(card).getByRole("button", { name: "New profile" }));
    fireEvent.change(within(card).getByLabelText("Profile name"), { target: { value: "Everyday" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    const saved = loadProfiles(store.cfg!, "").model.find((profile) => profile.name === "Everyday")!;
    expect(saved.temperature).toBe(0.45);
    expect(saved).not.toHaveProperty("modelPath");
    Object.assign(store.cfg!, { active_model: "another.gguf" });
    view.rerender(<I18nProvider initialLocale="en"><ExecutionProfiles store={store} modelPath="another.gguf" /></I18nProvider>);
    expect(screen.getByLabelText("Select shared model profile")).toHaveValue(saved.id);
    expect(screen.getByText("Available to all models")).toBeInTheDocument();
  });

  it("loads a shared profile explicitly without changing the current model or server settings", async () => {
    const store = createTestStore({ active_model: "a.gguf", runtime_defaults: ["ctx_size"] });
    const initial = loadProfiles(store.cfg!, "a.gguf");
    const shared = createModelProfile({ ...store.cfg!, temperature: 0.25, chat_options: { stop: ["<end>"] }, runtime_defaults: ["top_k"] }, "Precise");
    saveModelProfile(shared);
    Object.assign(store.cfg!, { active_model: "b.gguf" });
    render(<I18nProvider initialLocale="en"><ExecutionProfiles store={store} modelPath="b.gguf" /></I18nProvider>);
    fireEvent.change(screen.getByLabelText("Select shared model profile"), { target: { value: shared.id } });
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(loadProfiles(store.cfg!, "b.gguf").activeModelId).toBe(initial.activeModelId);
    const card = screen.getByRole("heading", { name: "Shared model profile" }).closest("section")!;
    fireEvent.click(within(card).getByRole("button", { name: "Load saved settings" }));
    await waitFor(() => expect(store.cfg?.temperature).toBe(0.25));
    expect(store.cfg).toMatchObject({ active_model: "b.gguf", ctx_size: 4096, runtime_defaults: ["ctx_size", "top_k"], chat_options: { stop: ["<end>"] } });
    expect(loadProfiles(store.cfg!, "c.gguf").activeModelId).toBe(shared.id);
  });
});
