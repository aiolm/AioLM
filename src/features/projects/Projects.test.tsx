import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../shared/i18n/i18n";
import { createTestStore } from "../../testing/appStore";
import { ACTIVE_PROJECT_KEY, PROJECTS_KEY, activeProjectId, exportProject, projectFromConfig, readProjects, setActiveProjectId, writeProjects } from "./projectStore";
import ProjectsPanel from "./Projects";
import * as api from "../../shared/api/index";
import { useModelSettings, type ModelSettingsContext } from "../model-settings/ModelSettingsProvider";
import { captureProfile, defaultSettingsProfile, emptyProfileLibrary, materializeProfileApplication, profileTargetKey } from '../../shared/config/settingsProfiles';

vi.mock("../model-settings/ModelSettingsProvider", () => ({ useModelSettings: vi.fn(() => null) }));

vi.mock("../../shared/api/index", () => ({
  pickDocument: vi.fn(async () => null),
  projectExportJson: vi.fn(async () => true),
  projectImportJson: vi.fn(async () => null),
  mcpListServers: vi.fn(async () => []),
  mcpListTools: vi.fn(async () => []),
  rtProbe: vi.fn(async () => ({ backend: 'cpu', build: 'b123', executable: 'llama-server', state: 'available', version: 'test', flags: [], devices: [], diagnostics: [], server_help: '' })),
  isNativeRuntimeAvailable: vi.fn(() => false),
  rtList: vi.fn(async () => []),
  providerRuntimes: vi.fn(async () => []),
}));

const mockedApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe("Project configuration snapshots", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); vi.mocked(useModelSettings).mockReturnValue(null); mockedApi.isNativeRuntimeAvailable.mockReturnValue(false); mockedApi.providerRuntimes.mockResolvedValue([]); });
  afterEach(() => { vi.restoreAllMocks(); });

  const failWrites = (failedKey = PROJECTS_KEY) => {
    const original = Storage.prototype.setItem;
    return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === failedKey) throw new DOMException('Synthetic project storage failure', 'QuotaExceededError');
      original.call(this, key, value);
    });
  };

  it('imports a same-name copy and preserves the active project and its document bindings', async () => {
    mockedApi.isNativeRuntimeAvailable.mockReturnValue(true);
    const store = createTestStore();
    const original = projectFromConfig('Research', 'Keep citations', store.cfg!, [{ name: 'notes.md', path: '/synthetic/notes.md' }], ['local:lookup'], '', 100);
    writeProjects([original]); setActiveProjectId(original.id);
    mockedApi.projectImportJson.mockResolvedValueOnce(exportProject(original));
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Import JSON' }));
    await screen.findByText('Imported “Research (2)”.');
    expect(readProjects()).toHaveLength(2);
    expect(readProjects().find(item => item.id === original.id)).toEqual(original);
    expect(activeProjectId()).toBe(original.id);
    expect(screen.getByLabelText('Project name')).toHaveValue('Research (2)');
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it.each([PROJECTS_KEY, ACTIVE_PROJECT_KEY])('keeps the edited project and reports failed persistence of %s before a successful retry', key => {
    const store = createTestStore();
    const project = projectFromConfig('Research', 'Keep citations', store.cfg!, [], [], '', 100);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Edited project' } });
    const failure = failWrites(key);
    fireEvent.click(screen.getByRole('button', { name: 'Update project' }));
    expect(screen.getByText(/Synthetic project storage failure/)).toBeVisible();
    expect(readProjects()).toEqual([project]);
    expect(activeProjectId()).toBe(project.id);
    expect(screen.getByLabelText('Project name')).toHaveValue('Edited project');
    expect(screen.queryByText('Saved project “Edited project”.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(screen.getByRole('dialog', { name: 'Unsaved settings' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    failure.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Update project' }));
    expect(readProjects()[0].name).toBe('Edited project');
    expect(screen.queryByText(/Synthetic project storage failure/)).not.toBeInTheDocument();
  });

  it('keeps a project visible and active when its deletion cannot be persisted', () => {
    const store = createTestStore();
    const project = projectFromConfig('Research', '', store.cfg!, [], [], '', 100);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    failWrites();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(screen.getByText(/Synthetic project storage failure/)).toBeVisible();
    expect(readProjects()).toEqual([project]);
    expect(activeProjectId()).toBe(project.id);
    expect(screen.getByLabelText('Project name')).toHaveValue('Research');
    expect(screen.queryByText('Deleted “Research”.')).not.toBeInTheDocument();
  });

  it('handles import storage failure after discard confirmation without losing the current draft', async () => {
    mockedApi.isNativeRuntimeAvailable.mockReturnValue(true);
    const store = createTestStore();
    const project = projectFromConfig('Research', '', store.cfg!, [], [], '', 100);
    const imported = projectFromConfig('Imported', '', store.cfg!, [], [], '', 200);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Unsaved draft' } });
    mockedApi.projectImportJson.mockResolvedValueOnce(exportProject(imported));
    failWrites();
    fireEvent.click(screen.getByRole('button', { name: 'Import JSON' }));
    await screen.findByRole('dialog', { name: 'Unsaved settings' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByText(/Synthetic project storage failure/)).toBeVisible();
    expect(readProjects()).toEqual([project]);
    expect(activeProjectId()).toBe(project.id);
    expect(screen.getByLabelText('Project name')).toHaveValue('Unsaved draft');
    expect(screen.queryByText(/Imported “/)).not.toBeInTheDocument();
  });

  it('reports project state failure after runtime configuration is applied without claiming the project was applied', async () => {
    const store = createTestStore();
    const project = projectFromConfig('Research', 'Project prompt', store.cfg!, [], [], '', 100);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    failWrites();
    fireEvent.click(screen.getByRole('button', { name: 'Apply runtime settings' }));
    expect(await screen.findByText(/Synthetic project storage failure/)).toBeVisible();
    expect(store.updateConfig).toHaveBeenCalledOnce();
    expect(readProjects()).toEqual([project]);
    expect(screen.queryByText(/^Applied “Research”\./)).not.toBeInTheDocument();
  });

  it.each(['name', 'description', 'documents', 'tools', 'model settings'] as const)('keeps unsaved %s edits when creating another project is cancelled', async field => {
    const settings: ModelSettingsContext = { open: vi.fn(), suspended: false, resume: vi.fn(), getRequestConfig: (_id, cfg) => cfg, getRequestProfile: () => null };
    vi.mocked(useModelSettings).mockReturnValue(settings);
    const store = createTestStore();
    const project = projectFromConfig('Research', 'Cite the source', store.cfg!, [{ name: 'notes.md', path: '/synthetic/notes.md' }], ['synthetic:search'], 'Original description', 100);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    if (field === 'name') fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Edited name' } });
    if (field === 'description') fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Edited description' } });
    if (field === 'documents') fireEvent.click(screen.getByRole('button', { name: 'Remove notes.md' }));
    if (field === 'tools') fireEvent.click(screen.getByRole('checkbox', { name: 'synthetic:search · Unavailable' }));
    if (field === 'model settings') {
      fireEvent.click(screen.getByRole('button', { name: 'Edit prompt in model settings' }));
      await act(async () => { await vi.mocked(settings.open).mock.calls[0][0].onApply?.({ ...store.cfg!, ctx_size: 8192 }); });
    }
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(screen.getByRole('dialog', { name: 'Unsaved settings' })).toBeVisible();
    expect(readProjects()).toEqual([project]);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('dialog', { name: 'Unsaved settings' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toHaveValue(field === 'name' ? 'Edited name' : 'Research');
    if (field === 'description') expect(screen.getByLabelText('Description')).toHaveValue('Edited description');
    if (field === 'documents') expect(screen.getByText('No documents yet.')).toBeVisible();
    if (field === 'tools') expect(screen.queryByRole('checkbox', { name: 'synthetic:search · Unavailable' })).not.toBeInTheDocument();
    if (field === 'model settings') expect(screen.getByText('8,192')).toBeVisible();
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('switches presets only after discarding edits, and does not interrupt selection after saving', () => {
    const store = createTestStore();
    const first = projectFromConfig('First project', 'First prompt', store.cfg!, [], [], 'First description', 100);
    const second = projectFromConfig('Second project', 'Second prompt', store.cfg!, [], [], 'Second description', 200);
    writeProjects([first, second]); setActiveProjectId(first.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Unsaved name' } });
    fireEvent.click(screen.getByRole('button', { name: /First project.*model\.gguf/ }));
    expect(screen.queryByRole('dialog', { name: 'Unsaved settings' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toHaveValue('Unsaved name');
    fireEvent.click(screen.getByRole('button', { name: /Second project.*model\.gguf/ }));
    expect(screen.getByLabelText('Project name')).toHaveValue('Unsaved name');
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Project name')).toHaveValue('Second project');
    expect(readProjects()).toEqual([first, second]);
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Saved description' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update project' }));
    fireEvent.click(screen.getByRole('button', { name: /First project.*model\.gguf/ }));
    expect(screen.queryByRole('dialog', { name: 'Unsaved settings' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toHaveValue('First project');
    expect(readProjects().find(project => project.id === second.id)?.description).toBe('Saved description');
  });

  it('protects a new draft and accepts import only after its edits are explicitly discarded', async () => {
    mockedApi.isNativeRuntimeAvailable.mockReturnValue(true);
    const store = createTestStore();
    const imported = projectFromConfig('Imported project', 'Imported prompt', store.cfg!, [], [], '', 100);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(screen.queryByRole('dialog', { name: 'Unsaved settings' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Unsaved draft' } });
    mockedApi.projectImportJson.mockResolvedValueOnce(exportProject(imported));
    fireEvent.click(screen.getByRole('button', { name: 'Import JSON' }));
    expect(await screen.findByRole('dialog', { name: 'Unsaved settings' })).toBeVisible();
    expect(readProjects()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Project name')).toHaveValue('Unsaved draft');
    expect(readProjects()).toEqual([]);
    mockedApi.projectImportJson.mockResolvedValueOnce(exportProject(imported));
    fireEvent.click(screen.getByRole('button', { name: 'Import JSON' }));
    await screen.findByRole('dialog', { name: 'Unsaved settings' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Project name')).toHaveValue('Imported project');
    expect(readProjects()).toHaveLength(1);
    expect(readProjects()[0]).toMatchObject({ name: imported.name, systemPrompt: imported.systemPrompt, config: imported.config });
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('checks the latest edits when an asynchronous import finishes', async () => {
    mockedApi.isNativeRuntimeAvailable.mockReturnValue(true);
    const store = createTestStore();
    const imported = projectFromConfig('Imported project', 'Imported prompt', store.cfg!, [], [], '', 100);
    let finish!: (value: string) => void;
    mockedApi.projectImportJson.mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve; }));
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Import JSON' }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Edited during import' } });
    await act(async () => { finish(exportProject(imported)); });
    expect(screen.getByRole('dialog', { name: 'Unsaved settings' })).toBeVisible();
    expect(screen.getByLabelText('Project name')).toHaveValue('Edited during import');
    expect(readProjects()).toEqual([]);
  });

  it('does not mark a successful runtime assignment as an unsaved user edit', async () => {
    const store = createTestStore();
    const project = projectFromConfig('Research', 'Project prompt', store.cfg!, [], [], '', 100);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Apply runtime settings' }));
    await waitFor(() => expect(readProjects()[0].profileApplication?.profile_id).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(screen.queryByRole('dialog', { name: 'Unsaved settings' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toHaveValue('');
  });

  it('uses the native JSON save dialog and retains the saved project after cancellation or failure', async () => {
    mockedApi.isNativeRuntimeAvailable.mockReturnValue(true);
    const store = createTestStore();
    const project = projectFromConfig('Native workspace', 'Keep citations', store.cfg!);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    mockedApi.projectExportJson.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export JSON' })).toBeEnabled());
    expect(mockedApi.projectExportJson).toHaveBeenCalledWith(expect.any(String), 'native-workspace.json');
    expect(JSON.parse(mockedApi.projectExportJson.mock.calls[0][0]).project).toMatchObject({ name: project.name, systemPrompt: project.systemPrompt });
    expect(readProjects()).toEqual([project]);
    mockedApi.projectExportJson.mockRejectedValueOnce(new Error('Destination is not writable'));
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    expect(await screen.findByText('Destination is not writable')).toBeVisible();
    expect(readProjects()).toEqual([project]);
    mockedApi.projectExportJson.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    expect(await screen.findByText('Saved')).toBeVisible();
    expect(readProjects()).toEqual([project]);
  });

  it('imports from the native picker while leaving saved projects intact on cancel or invalid input', async () => {
    mockedApi.isNativeRuntimeAvailable.mockReturnValue(true);
    const store = createTestStore();
    const project = projectFromConfig('Existing workspace', 'Keep citations', store.cfg!);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    mockedApi.projectImportJson.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: 'Import JSON' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import JSON' })).toBeEnabled());
    expect(readProjects()).toEqual([project]);
    mockedApi.projectImportJson.mockResolvedValueOnce('{}');
    fireEvent.click(screen.getByRole('button', { name: 'Import JSON' }));
    expect(await screen.findByText('The selected file is not a valid aiolm project preset.')).toBeVisible();
    expect(readProjects()).toEqual([project]);
    const imported = projectFromConfig('Imported native workspace', 'Imported prompt', store.cfg!);
    mockedApi.projectImportJson.mockResolvedValueOnce(exportProject(imported));
    fireEvent.click(screen.getByRole('button', { name: 'Import JSON' }));
    expect(await screen.findByText('Imported “Imported native workspace”.')).toBeVisible();
    expect(readProjects()).toHaveLength(2);
    expect(readProjects().find(item => item.id === project.id)).toEqual(project);
  });

  it('displays the Python runtime and its context instead of stale llama settings', async () => {
    mockedApi.isNativeRuntimeAvailable.mockReturnValue(true);
    mockedApi.providerRuntimes.mockResolvedValue([{ provider: 'vllm', id: 'synthetic-metal', version: '0.30.0+cpu', variant: 'vllm-metal', plugin_version: '0.30.0', accelerator: 'metal', installation: 'managed' }]);
    const store = createTestStore({ active_provider: 'vllm', active_runtime: 'synthetic-metal', active_backend: 'vulkan', active_build: 'stale-build', ctx_size: 8192,
      provider_options: { vllm: { max_model_len: 512 } } });
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    expect(await screen.findByText('vLLM · vllm-metal 0.30.0 · vLLM 0.30.0+cpu (synthetic-metal) · metal · Installed by AioLM')).toBeVisible();
    expect(screen.getByTestId('project-prompt-preview')).toHaveTextContent('512');
    expect(screen.getByTestId('project-prompt-preview')).not.toHaveTextContent('stale-build');
  });

  it("applies model settings to the project editor before explicit project save", async () => {
    const settings: ModelSettingsContext = { open: vi.fn(), suspended: false, resume: vi.fn(), getRequestConfig: (_id, cfg) => cfg, getRequestProfile: () => null };
    vi.mocked(useModelSettings).mockReturnValue(settings);
    const store = createTestStore({ active_model: "models/default.gguf" });
    const project = projectFromConfig("Notes", "Keep citations", store.cfg!, [{ name: "notes.md", path: "notes.md" }], ["docs:search"]);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Edit prompt in model settings" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Edit prompt in model settings" }));
    const request = vi.mocked(settings.open).mock.calls[0][0];
    expect(request.systemPrompt).toBe("Original project instruction");
    const next = { ...store.cfg!, active_model: "models/project.gguf", server_args: ["--jinja"], chat_options: { stop: ["finished"] } };
    const application = { model: next.active_model, profile_id: "project-profile", profile_revision: 3, settings: { temperature: 0.3 }, system_prompt: "Use the copied instruction" };
    store.cfg!.settings_profiles = { ...emptyProfileLibrary(), entries: [defaultSettingsProfile(), { ...captureProfile(next, 'Project profile', 'model', application.system_prompt), id: application.profile_id, revision: 3 }] };
    await act(async () => { await request.onApply?.(next, application); });
    application.system_prompt = "Later profile edit";
    expect(screen.getByLabelText("System prompt")).toHaveTextContent("Use the copied instruction");
    expect(readProjects()[0].systemPrompt).toBe("Original project instruction");
    fireEvent.click(screen.getByRole('button', { name: 'Edit prompt in model settings' }));
    expect(vi.mocked(settings.open).mock.calls[1][0].application).toMatchObject({ profile_id: 'project-profile', profile_revision: 3, system_prompt: 'Use the copied instruction' });
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0]).toMatchObject({ systemPrompt: "Use the copied instruction", config: { active_model: "models/project.gguf", server_args: ["--jinja"], chat_options: { stop: ["finished"] } } });
    expect(readProjects()[0].profileApplication).toMatchObject({ profile_id: 'project-profile', profile_revision: 3, system_prompt: 'Use the copied instruction' });
    view.unmount();
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Edit prompt in model settings' }));
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
    expect(saved.settings_profiles!.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp').find(profile => profile.id === application.profile_id)).toMatchObject({ settings: { ctx_size: 16384 }, system_prompt: 'Project prompt' });
    expect(saved.settings_profiles!.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp').find(profile => profile.id === existing.id)).toEqual(existing);
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
    expect(library.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toEqual([defaultSettingsProfile(), active, savedProfile]);
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit prompt in model settings' }));
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
    expect(store.getConfig()!.settings_profiles!.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toEqual([fallback, active]);
    expect(store.getConfig()!.settings_profiles!.applied[profileTargetKey(project.config.active_model)]).toMatchObject({ profile_id: fallback.id, system_prompt: 'Default instruction' });
    expect(readProjects()[0]).toMatchObject({ config: { ctx_size: 8192, temperature: 0.4 }, systemPrompt: 'Default instruction', profileApplication: { profile_id: fallback.id } });
    expect(screen.getByLabelText('System prompt')).toHaveTextContent('Default instruction');
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

  it.each([true, false])('does not reactivate a deleted project when its pending runtime assignment finishes (remaining project: %s)', async hasRemaining => {
    const store = createTestStore();
    const project = projectFromConfig('Pending project', 'Pending prompt', { ...store.cfg!, ctx_size: 8192 }, [], [], '', 100);
    const remaining = projectFromConfig('Remaining project', 'Remaining prompt', store.cfg!, [], [], '', 200);
    const afterDeletion = hasRemaining ? [remaining] : [];
    writeProjects([project, ...afterDeletion]); setActiveProjectId(project.id);
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
    expect(store.getConfig()?.ctx_size).toBe(8192);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(readProjects()).toEqual(afterDeletion);
    expect(activeProjectId()).toBe(hasRemaining ? remaining.id : null);
    await act(async () => { finish(); });
    expect(readProjects()).toEqual(afterDeletion);
    expect(activeProjectId()).toBe(hasRemaining ? remaining.id : null);
    expect(screen.getByLabelText('Project name')).toHaveValue(hasRemaining ? 'Remaining project' : '');
    expect(store.getConfig()?.ctx_size).toBe(8192);
    expect(screen.queryByText(/^Applied “Pending project”\./)).not.toBeInTheDocument();
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

  it('initializes a new project from the assigned saved profile without modifying its source', () => {
    const store = createTestStore({ ctx_size: 4096 });
    const profile = captureProfile({ ...store.cfg!, ctx_size: 8192 }, 'Selected setup', 'model', 'Current saved instruction');
    store.cfg!.settings_profiles = { ...emptyProfileLibrary(), entries: [defaultSettingsProfile(), profile],
      applied: { [profileTargetKey(store.cfg!.active_model)]: materializeProfileApplication(store.cfg!, 'Earlier instruction', profile) } };
    const entries = structuredClone(store.cfg!.settings_profiles.entries);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    expect(screen.getByLabelText('System prompt')).toHaveTextContent('Current saved instruction');
    expect(screen.getByText('8,192')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'New workspace' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }));
    expect(readProjects()[0]).toMatchObject({ systemPrompt: 'Current saved instruction', config: { ctx_size: 8192 },
      profileApplication: { profile_id: profile.id, profile_revision: profile.revision } });
    expect(store.cfg!.settings_profiles.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toEqual(entries);
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
    expect(screen.getByLabelText('System prompt')).toHaveTextContent('Revised profile instruction');
    expect(screen.getByText('llama.cpp · cpu · b123')).toBeVisible();
    expect(screen.getByText('32,768')).toBeVisible();
    expect(readProjects()[0]).toMatchObject({ systemPrompt: 'Old profile instruction', config: { ctx_size: 4096 } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply runtime settings' }));
    await waitFor(() => expect(store.getConfig()).toMatchObject({ ctx_size: 32768, temperature: 0.3, active_backend: 'cpu', active_build: 'b123' }));
    expect(readProjects()[0]).toMatchObject({ systemPrompt: 'Revised profile instruction', config: { ctx_size: 32768 },
      profileApplication: { profile_id: revised.id, profile_revision: 2 }, toolIds: ['docs:search'], documentBindings: [{ name: 'notes.md', path: 'notes.md' }] });
    expect(store.cfg!.settings_profiles!.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp').map(profile => profile.id)).toEqual(entries.map(profile => profile.id));
    expect(store.cfg!.settings_profiles!.entries.find(profile => profile.id === revised.id)).toMatchObject({ revision: 2, legacy_runtime: { active_backend: 'vulkan', active_build: 'b456' } });
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
    expect(screen.getByLabelText("Linked documents · one path per line")).toHaveTextContent(displayDocument);
    expect(screen.getByTitle(String.raw`C:\models\test.gguf`)).toHaveTextContent('test.gguf');
    expect(container.textContent).not.toContain('\\\\?\\');
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0]).toMatchObject({ config: { active_model: model }, documentBindings: [{ name: "notes.md", path: document }] });
  });

  it("adds a document through the file picker and saves its stored path", async () => {
    const store = createTestStore();
    const project = projectFromConfig("Research", "Cite the source", store.cfg!);
    writeProjects([project]); setActiveProjectId(project.id);
    mockedApi.pickDocument.mockResolvedValueOnce("C:/docs/picked.md");
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    expect(screen.getByText("No documents yet.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add document" }));
    await waitFor(() => expect(screen.getByLabelText("Linked documents · one path per line")).toHaveTextContent("picked.md"));
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0]).toMatchObject({ documentBindings: [{ name: "picked.md", path: "C:/docs/picked.md" }] });
  });

  it("removes a document without touching the stored copy until saved", () => {
    const store = createTestStore();
    const project = projectFromConfig("Research", "Cite the source", store.cfg!, [{ name: "notes.md", path: "notes.md" }]);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Remove notes.md" }));
    expect(screen.getByText("No documents yet.")).toBeVisible();
    expect(readProjects()[0].documentBindings).toEqual([{ name: "notes.md", path: "notes.md" }]);
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0].documentBindings).toEqual([]);
  });

  it("selects MCP tools from registered servers instead of typing IDs", async () => {
    const store = createTestStore();
    const project = projectFromConfig("Research", "Cite the source", store.cfg!);
    writeProjects([project]); setActiveProjectId(project.id);
    mockedApi.mcpListServers.mockResolvedValue([{ id: "docs", name: "Docs", command: "docs-mcp", args: [], enabled: true }]);
    mockedApi.mcpListTools.mockResolvedValue([{ name: "search", description: "Search docs", input_schema: { type: "object", properties: {} } }]);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    const checkbox = await screen.findByRole("checkbox", { name: "Docs · search" });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0].toolIds).toEqual(["docs:search"]);
  });

  it("keeps stale tool IDs visible until explicitly removed", async () => {
    const store = createTestStore();
    const project = projectFromConfig("Research", "Cite the source", store.cfg!, [], ["gone:missing"]);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    await waitFor(() => expect(mockedApi.mcpListServers).toHaveBeenCalled());
    expect(screen.getByRole("checkbox", { name: "gone:missing · Unavailable" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0].toolIds).toEqual(["gone:missing"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "gone:missing · Unavailable" }));
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0].toolIds).toEqual([]);
  });

  it("shows a concrete app default for inherited context size instead of a bare label", async () => {
    const store = createTestStore({ runtime_defaults: ["ctx_size"] });
    const project = projectFromConfig("Research", "Cite the source", store.cfg!);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    // Documented app default (4096) with its source, never a stale stored number.
    expect(await screen.findByText("4096 (using app default)")).toBeVisible();
    expect(screen.queryByText("default", { exact: true })).not.toBeInTheDocument();
  });

  it("localizes the fallback tools/docs summary and profile version label in Korean without raw rN shorthand", () => {
    const store = createTestStore();
    const profile = { ...captureProfile(store.cfg!, "Shared setup", "model", "Prompt"), revision: 2 };
    const application = materializeProfileApplication(store.cfg!, "Prompt", profile);
    store.cfg!.settings_profiles = { ...emptyProfileLibrary(), entries: [defaultSettingsProfile(), profile], applied: { [profileTargetKey(store.cfg!.active_model)]: application } };
    const project = projectFromConfig("Research", "Prompt", store.cfg!, [{ name: "notes.md", path: "notes.md" }], ["docs:search"], "", 100, application);
    writeProjects([project]); setActiveProjectId(project.id);
    render(<I18nProvider initialLocale="ko"><ProjectsPanel store={store} /></I18nProvider>);
    expect(screen.getByText("도구 1개 · 문서 1개")).toBeVisible();
    expect(screen.getByText("Shared setup · 버전 2")).toBeVisible();
    expect(screen.queryByText(/· r2/)).not.toBeInTheDocument();
  });
});
