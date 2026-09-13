import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../shared/i18n/i18n";
import { createTestStore } from "../../testing/appStore";
import { projectFromConfig, readProjects, setActiveProjectId, writeProjects } from "./projectStore";
import ProjectsPanel from "./Projects";
import { useModelSettings, type ModelSettingsContext } from "../model-settings/ModelSettingsProvider";
import { captureProfile, defaultSettingsProfile, emptyProfileLibrary, materializeProfileApplication, profileTargetKey } from '../../shared/config/settingsProfiles';

vi.mock("../model-settings/ModelSettingsProvider", () => ({ useModelSettings: vi.fn(() => null) }));

describe("Project configuration snapshots", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); vi.mocked(useModelSettings).mockReturnValue(null); });

  it("applies model settings to the project editor before explicit project save", async () => {
    const settings: ModelSettingsContext = { open: vi.fn(), suspended: false, resume: vi.fn(), getRequestConfig: (_id, cfg) => cfg, getRequestProfile: () => null };
    vi.mocked(useModelSettings).mockReturnValue(settings);
    const store = createTestStore({ active_model: "models/default.gguf" });
    const project = projectFromConfig("Notes", "Keep citations", store.cfg!, [{ name: "notes.md", path: "notes.md" }], ["docs:search"]);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /^Choose model:/ }));
    const request = vi.mocked(settings.open).mock.calls[0][0];
    expect(request.target).toEqual({ kind: "project", id: project.id });
    expect(request.systemPrompt).toBe("Keep citations");
    const changed = { ...store.cfg!, active_model: "models/project.gguf", ctx_size: 8192, chat_options: { stop: ["done"] } };
    await act(async () => { await request.onApply?.(changed); });
    changed.chat_options.stop.push("later mutation");
    expect(readProjects()[0].config.active_model).toBe("models/default.gguf");
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(store.start).not.toHaveBeenCalled();
    expect(screen.getByText("project.gguf")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0]).toMatchObject({ systemPrompt: "Keep citations", toolIds: ["docs:search"], documentBindings: [{ name: "notes.md", path: "notes.md" }], config: { active_model: "models/project.gguf", ctx_size: 8192, chat_options: { stop: ["done"] } } });
    expect(store.cfg?.active_model).toBe("models/default.gguf");
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it("copies profile settings and prompt into the project without changing the running target", async () => {
    const settings: ModelSettingsContext = { open: vi.fn(), suspended: false, resume: vi.fn(), getRequestConfig: (_id, cfg) => cfg, getRequestProfile: () => null };
    vi.mocked(useModelSettings).mockReturnValue(settings);
    const store = createTestStore({ active_model: "models/default.gguf" });
    const project = projectFromConfig("Research", "Original project instruction", store.cfg!);
    writeProjects([project]); setActiveProjectId(project.id);
    const view = render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Model settings" }));
    const request = vi.mocked(settings.open).mock.calls[0][0];
    expect(request.systemPrompt).toBe("Original project instruction");
    const next = { ...store.cfg!, active_model: "models/project.gguf", server_args: ["--jinja"], chat_options: { stop: ["finished"] } };
    const application = { model: next.active_model, profile_id: "project-profile", profile_revision: 3, settings: { temperature: 0.3 }, system_prompt: "Use the copied instruction" };
    store.cfg!.settings_profiles = { ...emptyProfileLibrary(), entries: [defaultSettingsProfile(), { ...captureProfile(next, 'Project profile', 'model', application.system_prompt), id: application.profile_id, revision: 3 }] };
    await act(async () => { await request.onApply?.(next, application); });
    application.system_prompt = "Later profile edit";
    expect(screen.getByLabelText("System prompt")).toHaveValue("Use the copied instruction");
    expect(readProjects()[0].systemPrompt).toBe("Original project instruction");
    fireEvent.click(screen.getByRole('button', { name: 'Model settings' }));
    expect(vi.mocked(settings.open).mock.calls[1][0].application).toMatchObject({ profile_id: 'project-profile', profile_revision: 3, system_prompt: 'Use the copied instruction' });
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0]).toMatchObject({ systemPrompt: "Use the copied instruction", config: { active_model: "models/project.gguf", server_args: ["--jinja"], chat_options: { stop: ["finished"] } } });
    expect(readProjects()[0].profileApplication).toMatchObject({ profile_id: 'project-profile', profile_revision: 3, system_prompt: 'Use the copied instruction' });
    view.unmount();
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Model settings' }));
    expect(vi.mocked(settings.open).mock.calls[2][0].application).toMatchObject({ profile_id: 'project-profile', profile_revision: 3, system_prompt: 'Use the copied instruction' });
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(store.start).not.toHaveBeenCalled();
  });

  it('applies an older project as a named profile without overwriting the active profile', async () => {
    const store = createTestStore({ active_model: 'models/shared.gguf', ctx_size: 4096 });
    const existing = captureProfile(store.cfg!, 'Interactive', 'model', 'Interactive prompt');
    const currentApplication = materializeProfileApplication(store.cfg!, 'Interactive prompt', existing);
    store.cfg!.settings_profiles = { ...emptyProfileLibrary(), entries: [defaultSettingsProfile(), existing], applied: { [profileTargetKey(store.cfg!.active_model)]: currentApplication } };
    const project = projectFromConfig('Batch work', 'Project prompt', { ...store.cfg!, ctx_size: 16384, temperature: 0.3, chat_options: { stop: ['finished'] } });
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Apply runtime settings' }));
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledOnce());
    await waitFor(() => expect(readProjects()[0].profileApplication?.profile_id).toBeTruthy());
    const saved = store.getConfig()!;
    const application = saved.settings_profiles!.applied[profileTargetKey(saved.active_model)];
    expect(saved).toMatchObject({ ctx_size: 16384, temperature: 0.3, chat_options: { stop: ['finished'] } });
    expect(application).toMatchObject({ model: saved.active_model, system_prompt: 'Project prompt', settings: { ctx_size: 16384, temperature: 0.3 } });
    expect(application.profile_id).not.toBe(existing.id);
    expect(saved.settings_profiles!.entries.find(profile => profile.id === application.profile_id)).toMatchObject({ settings: { ctx_size: 16384 }, system_prompt: 'Project prompt' });
    expect(saved.settings_profiles!.entries.find(profile => profile.id === existing.id)).toEqual(existing);
    expect(readProjects()[0].profileApplication?.profile_id).toBe(application.profile_id);
    expect(store.start).not.toHaveBeenCalled();
  });

  it('reuses the stored project profile identity when applying a project', async () => {
    const store = createTestStore({ active_model: 'models/shared.gguf' });
    const active = captureProfile(store.cfg!, 'Interactive', 'model', 'Interactive prompt');
    const projectCfg = { ...store.cfg!, ctx_size: 12288 };
    const savedProfile = captureProfile(projectCfg, 'Research', 'model', 'Research prompt');
    const projectApplication = materializeProfileApplication(projectCfg, 'Research prompt', savedProfile);
    store.cfg!.settings_profiles = { ...emptyProfileLibrary(), entries: [defaultSettingsProfile(), active, savedProfile], applied: { [profileTargetKey(store.cfg!.active_model)]: materializeProfileApplication(store.cfg!, 'Interactive prompt', active) } };
    const project = projectFromConfig('Research project', 'Research prompt', projectCfg, [], [], '', 100, projectApplication);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Apply runtime settings' }));
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledOnce());
    const library = store.getConfig()!.settings_profiles!;
    expect(library.applied[profileTargetKey(projectCfg.active_model)]).toMatchObject({ profile_id: savedProfile.id, profile_name: 'Research', system_prompt: 'Research prompt' });
    expect(library.entries).toEqual([defaultSettingsProfile(), active, savedProfile]);
    expect(store.start).not.toHaveBeenCalled();
  });

  it('opens the designated default when a project references a deleted profile', () => {
    const settings: ModelSettingsContext = { open: vi.fn(), suspended: false, resume: vi.fn(), getRequestConfig: (_id, value) => value, getRequestProfile: () => null };
    vi.mocked(useModelSettings).mockReturnValue(settings);
    const store = createTestStore({ ctx_size: 4096 });
    const fallback = captureProfile({ ...store.cfg!, ctx_size: 8192, temperature: 0.4 }, 'Everyday', 'global', 'Default instruction');
    const removedCfg = { ...store.cfg!, ctx_size: 32768, temperature: 1.1 };
    const removed = captureProfile(removedCfg, 'Removed profile', 'model', 'Removed instruction');
    store.cfg!.settings_profiles = { ...emptyProfileLibrary(), default_profile_id: fallback.id, entries: [fallback, removed] };
    const project = projectFromConfig('Imported workspace', 'Removed instruction', removedCfg, [], [], '', 100, materializeProfileApplication(removedCfg, 'Removed instruction', removed));
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    store.cfg!.settings_profiles = { ...store.cfg!.settings_profiles, entries: [fallback] };
    fireEvent.click(screen.getByRole('button', { name: 'Model settings' }));
    const request = vi.mocked(settings.open).mock.calls[0][0];
    expect(request.config).toMatchObject({ active_model: project.config.active_model, ctx_size: 8192, temperature: 0.4 });
    expect(request.application).toMatchObject({ profile_id: fallback.id, profile_name: 'Everyday', system_prompt: 'Default instruction' });
    expect(request.systemPrompt).toBe('Default instruction');
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(readProjects()[0].profileApplication?.profile_id).toBe(removed.id);
    expect(readProjects()[0].config.ctx_size).toBe(32768);
  });

  it('applies default values and prompt instead of recreating a deleted project profile', async () => {
    const store = createTestStore({ ctx_size: 4096 });
    const fallback = captureProfile({ ...store.cfg!, ctx_size: 8192, temperature: 0.4 }, 'Everyday', 'global', 'Default instruction');
    const active = captureProfile(store.cfg!, 'Interactive', 'model', 'Interactive instruction');
    store.cfg!.settings_profiles = { ...emptyProfileLibrary(), default_profile_id: fallback.id, entries: [fallback, active],
      applied: { [profileTargetKey(store.cfg!.active_model)]: materializeProfileApplication(store.cfg!, 'Interactive instruction', active) } };
    const removedCfg = { ...store.cfg!, ctx_size: 32768, temperature: 1.1 };
    const removed = captureProfile(removedCfg, 'Removed profile', 'model', 'Removed instruction');
    const project = projectFromConfig('Old workspace', 'Removed instruction', removedCfg, [], [], '', 100, materializeProfileApplication(removedCfg, 'Removed instruction', removed));
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Apply runtime settings' }));
    await waitFor(() => expect(readProjects()[0].profileApplication?.profile_id).toBe(fallback.id));
    expect(store.getConfig()).toMatchObject({ ctx_size: 8192, temperature: 0.4 });
    expect(store.getConfig()!.settings_profiles!.entries).toEqual([fallback, active]);
    expect(store.getConfig()!.settings_profiles!.applied[profileTargetKey(project.config.active_model)]).toMatchObject({ profile_id: fallback.id, system_prompt: 'Default instruction' });
    expect(readProjects()[0]).toMatchObject({ config: { ctx_size: 8192, temperature: 0.4 }, systemPrompt: 'Default instruction', profileApplication: { profile_id: fallback.id } });
    expect(screen.getByLabelText('System prompt')).toHaveValue('Default instruction');
    expect(store.start).not.toHaveBeenCalled();
  });

  it('keeps project edits saved while its runtime assignment is pending', async () => {
    const store = createTestStore();
    const project = projectFromConfig('Original name', 'Project prompt', store.cfg!);
    writeProjects([project]); setActiveProjectId(project.id);
    const update = store.updateConfig;
    let finish!: () => void;
    store.updateConfig = vi.fn(async patch => {
      const saved = await update(patch);
      await new Promise<void>(resolve => { finish = resolve; });
      return saved;
    });
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Apply runtime settings' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.change(screen.getByDisplayValue('Original name'), { target: { value: 'Updated name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update project' }));
    await act(async () => { finish(); });
    expect(readProjects()[0].name).toBe('Updated name');
    expect(readProjects()[0].profileApplication?.profile_id).toBeTruthy();
  });

  it("keeps saved tuning when only project metadata changes", () => {
    const store = createTestStore({ ctx_size: 8192, temperature: 0.3, runtime_defaults: ["ngl"] });
    const project = projectFromConfig("Research", "Cite the source", store.cfg!);
    writeProjects([project]); setActiveProjectId(project.id);
    store.cfg = { ...store.cfg!, ctx_size: 2048, temperature: 1.1, runtime_defaults: [] };
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Research"), { target: { value: "Research notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0].config).toMatchObject({ ctx_size: 8192, temperature: 0.3, runtime_defaults: ["ngl"] });
    expect(readProjects()[0].name).toBe("Research notes");
  });

  it("captures current settings explicitly while preserving workspace content", () => {
    const gpu = { gpu_ids: ["runtime:cuda:CUDA0"], main_gpu: "runtime:cuda:CUDA0", split_mode: "none" as const, tensor_split: [], draft_gpu_id: null };
    const store = createTestStore();
    const project = projectFromConfig("Research", "Cite the source", store.cfg!, [{ name: "notes.md", path: "notes.md" }], ["docs:search"]);
    writeProjects([project]); setActiveProjectId(project.id);
    Object.assign(store.cfg!, { ctx_size: 32768, gpu, runtime_defaults: ["ngl", "temperature"] });
    const profile = captureProfile(store.cfg!, 'Research settings', 'model', 'Use the saved profile instruction');
    store.cfg!.settings_profiles = { ...emptyProfileLibrary(), entries: [defaultSettingsProfile(), profile],
      applied: { [profileTargetKey(store.cfg!.active_model)]: materializeProfileApplication(store.cfg!, profile.system_prompt!, profile) } };
    const entries = structuredClone(store.cfg!.settings_profiles.entries);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Use current settings" }));
    expect(screen.getByLabelText('System prompt')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('System prompt')).toHaveValue(profile.system_prompt);
    expect(readProjects()[0].config.ctx_size).toBe(4096);
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0]).toMatchObject({ systemPrompt: profile.system_prompt, profileApplication: { profile_id: profile.id }, toolIds: ["docs:search"], documentBindings: [{ name: "notes.md", path: "notes.md" }], config: { ctx_size: 32768, gpu, runtime_defaults: ["ngl", "temperature"] } });
    expect(store.cfg!.settings_profiles.entries).toEqual(entries);
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('initializes a new project from the assigned saved profile without modifying its source', () => {
    const store = createTestStore({ ctx_size: 4096 });
    const profile = captureProfile({ ...store.cfg!, ctx_size: 8192 }, 'Selected setup', 'model', 'Current saved instruction');
    store.cfg!.settings_profiles = { ...emptyProfileLibrary(), entries: [defaultSettingsProfile(), profile],
      applied: { [profileTargetKey(store.cfg!.active_model)]: materializeProfileApplication(store.cfg!, 'Earlier instruction', profile) } };
    const entries = structuredClone(store.cfg!.settings_profiles.entries);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    expect(screen.getByLabelText('System prompt')).toHaveValue('Current saved instruction');
    expect(screen.getByText('8,192')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'New workspace' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }));
    expect(readProjects()[0]).toMatchObject({ systemPrompt: 'Current saved instruction', config: { ctx_size: 8192 },
      profileApplication: { profile_id: profile.id, profile_revision: profile.revision } });
    expect(store.cfg!.settings_profiles.entries).toEqual(entries);
    expect(store.cfg!.ctx_size).toBe(4096);
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('displays and applies the latest saved profile instead of a stale project snapshot', async () => {
    const store = createTestStore({ ctx_size: 4096, temperature: 0.8 });
    const profile = captureProfile(store.cfg!, 'Shared setup', 'model', 'Old profile instruction');
    const application = materializeProfileApplication(store.cfg!, profile.system_prompt!, profile);
    const project = projectFromConfig('Research', application.system_prompt, store.cfg!, [{ name: 'notes.md', path: 'notes.md' }], ['docs:search'], '', 100, application);
    const revised = { ...profile, revision: 2, system_prompt: 'Revised profile instruction', settings: { ...profile.settings, ctx_size: 32768, temperature: 0.3, active_backend: 'vulkan', active_build: 'b456' } };
    store.cfg!.settings_profiles = { ...emptyProfileLibrary(), entries: [defaultSettingsProfile(), revised],
      applied: { [profileTargetKey(store.cfg!.active_model)]: application } };
    const entries = structuredClone(store.cfg!.settings_profiles.entries);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    expect(screen.getByLabelText('System prompt')).toHaveValue('Revised profile instruction');
    expect(screen.getByText('vulkan · b456')).toBeVisible();
    expect(screen.getByText('32,768')).toBeVisible();
    expect(readProjects()[0]).toMatchObject({ systemPrompt: 'Old profile instruction', config: { ctx_size: 4096 } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply runtime settings' }));
    await waitFor(() => expect(store.getConfig()).toMatchObject({ ctx_size: 32768, temperature: 0.3, active_backend: 'vulkan', active_build: 'b456' }));
    expect(readProjects()[0]).toMatchObject({ systemPrompt: 'Revised profile instruction', config: { ctx_size: 32768 },
      profileApplication: { profile_id: revised.id, profile_revision: 2 }, toolIds: ['docs:search'], documentBindings: [{ name: 'notes.md', path: 'notes.md' }] });
    expect(store.cfg!.settings_profiles!.entries).toEqual(entries);
    expect(store.start).not.toHaveBeenCalled();
  });

  it("hides prefixes in restored document editors and model tooltips while preserving saved paths", () => {
    const model = String.raw`\\?\C:\models\test.gguf`;
    const document = String.raw`\\?\UNC\server\share\notes.md`;
    const displayDocument = String.raw`\\server\share\notes.md`;
    const store = createTestStore({ active_model: model });
    const project = projectFromConfig("Research", "Cite the source", store.cfg!, [{ name: "notes.md", path: document }]);
    writeProjects([project]); setActiveProjectId(project.id);
    const { container } = render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    expect(screen.getByLabelText("Document bindings · one path per line")).toHaveValue(displayDocument);
    expect(screen.getByTitle(String.raw`C:\models\test.gguf`)).toHaveTextContent('test.gguf');
    expect(container.textContent).not.toContain('\\\\?\\');
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0]).toMatchObject({ config: { active_model: model }, documentBindings: [{ name: "notes.md", path: document }] });
  });
});
