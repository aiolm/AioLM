import { describe, expect, it, vi } from 'vitest';
import { EXECUTION_KEYS, executionSettings } from '../../shared/config/executionSettings';
import { testConfig } from '../../testing/appStore';
import { ACTIVE_PROJECT_KEY, PROJECTS_CHANGED_EVENT, PROJECTS_KEY, activeProjectId, exportProject, importProject, projectConfigPatch, projectFromConfig, readProjects, setActiveProjectId, writeProjects } from './projectStore';
import { materializeProfileApplication, captureProfile } from '../../shared/config/settingsProfiles';

describe('project settings snapshots', () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    const store = { getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
      removeItem: vi.fn((key: string) => { values.delete(key); }),
    } as unknown as Storage;
    return { values, store };
  }

  it('reports quota failure without changing saved projects, the active pointer, or listeners', () => {
    const { store } = memoryStorage();
    const original = projectFromConfig('Original', '', testConfig, [], [], '', 100);
    writeProjects([original], store, original.id);
    const changed = { ...original, name: 'Edited' };
    const listener = vi.fn();
    window.addEventListener(PROJECTS_CHANGED_EVENT, listener);
    try {
      vi.mocked(store.setItem).mockImplementationOnce(() => { throw new DOMException('Synthetic project quota exceeded', 'QuotaExceededError'); });
      expect(() => writeProjects([changed], store, changed.id)).toThrow('Synthetic project quota exceeded');
      expect(readProjects(store)).toEqual([original]);
      expect(activeProjectId(store)).toBe(original.id);
      expect(listener).not.toHaveBeenCalled();
      writeProjects([changed], store, changed.id);
      expect(readProjects(store)).toEqual([changed]);
      expect(listener).toHaveBeenCalledOnce();
    } finally { window.removeEventListener(PROJECTS_CHANGED_EVENT, listener); }
  });

  it('restores the previous project list if its active pointer cannot be saved', () => {
    const { store, values } = memoryStorage();
    const original = projectFromConfig('Original', '', testConfig, [], [], '', 100);
    const replacement = projectFromConfig('Replacement', '', testConfig, [], [], '', 200);
    writeProjects([original], store, original.id);
    const raw = values.get(PROJECTS_KEY);
    vi.mocked(store.setItem).mockImplementation((key, value) => {
      if (key === ACTIVE_PROJECT_KEY) throw new Error('Synthetic active-project write failure');
      values.set(key, value);
    });
    expect(() => writeProjects([replacement], store, replacement.id)).toThrow('Synthetic active-project write failure');
    expect(values.get(PROJECTS_KEY)).toBe(raw);
    expect(readProjects(store)).toEqual([original]);
    expect(activeProjectId(store)).toBe(original.id);
    expect(() => setActiveProjectId(replacement.id, store)).toThrow('Synthetic active-project write failure');
  });

  it('keeps the project being removed if clearing the active pointer fails', () => {
    const { store } = memoryStorage();
    const original = projectFromConfig('Original', '', testConfig, [], [], '', 100);
    writeProjects([original], store, original.id);
    vi.mocked(store.removeItem).mockImplementationOnce(() => { throw new Error('Synthetic active-project removal failure'); });
    expect(() => writeProjects([], store, null)).toThrow('Synthetic active-project removal failure');
    expect(readProjects(store)).toEqual([original]);
    expect(activeProjectId(store)).toBe(original.id);
  });

  it('keeps reading resilient while making unavailable project writes explicit', () => {
    const blocked = { getItem: () => { throw new Error('Synthetic read restriction'); } } as unknown as Storage;
    expect(readProjects(blocked)).toEqual([]);
    expect(activeProjectId(blocked)).toBeNull();
    expect(readProjects(null)).toEqual([]);
    expect(activeProjectId(null)).toBeNull();
    expect(() => writeProjects([], null)).toThrow('Project storage is unavailable');
    expect(() => setActiveProjectId(null, null)).toThrow('Project storage is unavailable');
  });
  it('round-trips every execution setting without copying app-level configuration', () => {
    const cfg = {
      ...structuredClone(testConfig), runtime_defaults: ['temperature'],
      gpu: { gpu_ids: ['gpu-1'], main_gpu: 'gpu-1', split_mode: 'none' as const, tensor_split: [], draft_gpu_id: null },
      mmproj: 'models/vision.gguf', spec_draft_model: 'models/draft.gguf', server_args: ['--jinja'],
      chat_options: { stop: ['done'] }, lora_adapters: [{ path: 'models/adapter.gguf', scale: 0.5, enabled: true }],
    };
    const project = projectFromConfig('Research', 'Use project instructions', cfg);
    const restored = importProject(exportProject(project));
    expect(Object.keys(restored.config).sort()).toEqual([...EXECUTION_KEYS].sort());
    expect(restored.config).toEqual({ ...executionSettings(cfg), active_provider: 'llama.cpp', active_runtime: '', provider_options: {} });
    expect(restored.systemPrompt).toBe('Use project instructions');
    expect(restored.config).not.toHaveProperty('models_dir');
    expect(restored.config).not.toHaveProperty('settings_profiles');
    expect(restored.config).not.toHaveProperty('sessions');
  });
  it('keeps captured settings separate from source and applied copies', () => {
    const cfg = { ...structuredClone(testConfig), chat_options: { stop: ['done'] } };
    const project = projectFromConfig('Research', '', cfg);
    cfg.chat_options.stop.push('changed in source');
    const patch = projectConfigPatch(project);
    (patch.chat_options!.stop as string[]).push('changed after apply');
    expect(project.config.chat_options).toEqual({ stop: ['done'] });
    expect(project.systemPrompt).toBe('');
  });

  it('retains profile identity through project storage and import without copying unrelated application fields', () => {
    const cfg = structuredClone(testConfig);
    const profile = captureProfile(cfg, 'Writing', 'model', 'Use concise answers');
    const application = { ...materializeProfileApplication(cfg, 'Use concise answers', profile), ignored: 'Not part of the profile' };
    const project = projectFromConfig('Writing project', 'Use project instructions', cfg, [], [], '', 100, application);
    writeProjects([project], localStorage);
    const restored = importProject(exportProject(readProjects(localStorage)[0]));
    expect(restored.profileApplication).toMatchObject({ model: cfg.active_model, profile_id: profile.id, profile_name: 'Writing', profile_revision: 1, system_prompt: 'Use project instructions' });
    expect(restored.profileApplication).not.toHaveProperty('ignored');
    expect(restored.profileApplication?.settings).not.toHaveProperty('active_model');
    expect(restored.profileApplication?.settings).not.toHaveProperty('models_dir');
    application.profile_id = 'changed-after-save';
    expect(project.profileApplication?.profile_id).toBe(profile.id);
  });

  it.each([
    { model: 'another-model.gguf', profile_id: 'profile-other' },
    { model: testConfig.active_model, profile_id: '' },
    { model: testConfig.active_model, profile_id: 12 },
  ])('ignores an invalid or mismatched imported profile identity', application => {
    const project = projectFromConfig('Legacy project', '', testConfig);
    const restored = importProject(JSON.stringify({ ...project, profileApplication: application }));
    expect(restored.profileApplication).toBeUndefined();
    expect(restored.config).toEqual(project.config);
  });

  it('normalizes profile metadata while keeping the project snapshot authoritative', () => {
    const project = projectFromConfig('Snapshot', 'Project prompt', testConfig);
    const restored = importProject(JSON.stringify({ ...project, profileApplication: {
      model: testConfig.active_model, profile_id: '  profile-writing  ', profile_name: 'Writing', profile_revision: -2,
      settings: { ctx_size: 32768, models_dir: 'ignored' }, system_prompt: 'Stale prompt',
    } }));
    expect(restored.profileApplication).toMatchObject({ profile_id: 'profile-writing', system_prompt: 'Project prompt', settings: { ctx_size: testConfig.ctx_size } });
    expect(restored.profileApplication).not.toHaveProperty('profile_revision');
    expect(restored.profileApplication?.settings).not.toHaveProperty('models_dir');
  });
});
