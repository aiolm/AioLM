import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../shared/api/types';
import { providerOf } from '../../shared/api/providers';
import { migrateProfileLibrary } from '../../shared/config/profileMigration';
import { testConfig } from '../../testing/appStore';
import { captureProfile, defaultSettingsProfile, deleteSettingsProfile, emptyProfileLibrary, ensureProfileLibrary, materializeProfileApplication, profileTargetKey, type SettingsProfileLibrary } from '../../shared/config/settingsProfiles';
import { appliedProfile, mergeProfileEditor, profileLibrary, profileLibraryConfigPatch, rebaseStaleProfileEdit, requestProfileFromApplication, type ProfileEditorResult } from './profileEditor';
import { emptyGpuPlacement, sessionConfig } from '../../shared/runtime/sessionUtils';

function fixture() {
  const profile = { ...captureProfile(testConfig, 'Shared', 'global', 'Original prompt'), id: 'shared' };
  const application = materializeProfileApplication({ ...testConfig, chat_options: { stop: [' end ', '\n'] } }, 'Original prompt', profile);
  const other = materializeProfileApplication({ ...testConfig, active_model: 'other.gguf', temperature: 0.3 }, 'Other prompt', profile);
  const library: SettingsProfileLibrary = { ...emptyProfileLibrary(), revision: 4, legacy_imported: true,
    entries: [profile, defaultSettingsProfile()], default_profile_id: defaultSettingsProfile().id, applied: {
    [profileTargetKey(testConfig.active_model)]: application, [profileTargetKey('other.gguf')]: other,
  } };
  const current = { ...testConfig, settings_profiles: library };
  const edit: ProfileEditorResult = { baseRevision: 4, library: structuredClone(library), application: structuredClone(application) };
  return { current, edit, application, other };
}

beforeEach(() => localStorage.clear());

describe('profile editor persistence', () => {
  it('rebases independent runtime default and recent selections and rejects competing selections for one runtime', () => {
    const base = fixture().current.settings_profiles;
    base.provider_defaults = { 'llama.cpp': 'profile-default', vllm: 'vllm-old' };
    base.provider_recent = { vllm: 'vllm-old', 'mlx-vlm': 'mlx-old' };
    const latest = structuredClone(base);
    latest.provider_defaults!.vllm = 'vllm-new';
    latest.provider_recent!.vllm = 'vllm-new';
    const edited = structuredClone(base);
    edited.provider_recent!['mlx-vlm'] = 'mlx-new';
    const merged = rebaseStaleProfileEdit(base, latest, edited);
    expect(merged?.provider_defaults?.vllm).toBe('vllm-new');
    expect(merged?.provider_recent).toEqual({ vllm: 'vllm-new', 'mlx-vlm': 'mlx-new' });
    edited.provider_defaults!.vllm = 'vllm-competing';
    expect(rebaseStaleProfileEdit(base, latest, edited)).toBeNull();
    expect(base.provider_recent).toEqual({ vllm: 'vllm-old', 'mlx-vlm': 'mlx-old' });
  });
  it('reads a migrated library without writing browser storage or modifying config', () => {
    localStorage.setItem('aiolm-model-profiles', JSON.stringify({ version: 4, server: [], model: [{ id: 'old', name: 'Old', system_prompt: 'Saved prompt' }] }));
    const before = localStorage.getItem('aiolm-model-profiles');
    const library = profileLibrary(testConfig);
    expect(library.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toHaveLength(1);
    expect(library.legacy_imported).toBe(true);
    expect(localStorage.getItem('aiolm-model-profiles')).toBe(before);
    expect(testConfig).not.toHaveProperty('settings_profiles');
  });

  it('keeps applied values independent when a global profile is overwritten or renamed', () => {
    const { current, edit, application, other } = fixture();
    edit.library.entries[0] = { ...edit.library.entries[0], revision: 2, name: 'Renamed', system_prompt: 'Replacement prompt', settings: { temperature: 1.1 } };
    const next = mergeProfileEditor(current, edit);
    expect(next.revision).toBe(5);
    expect(next.applied[profileTargetKey(testConfig.active_model)]).toEqual({ ...application, profile_name: 'Renamed' });
    expect(next.applied[profileTargetKey('other.gguf')]).toEqual({ ...other, profile_name: 'Renamed' });
    expect(current.settings_profiles.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[0]).toMatchObject({ revision: 1, name: 'Shared', system_prompt: 'Original prompt' });
  });

  it('rejects library edits that leave saved targets referencing a removed profile', () => {
    const { current, edit, application, other } = fixture();
    edit.library.entries = [defaultSettingsProfile()];
    expect(() => mergeProfileEditor(current, edit)).toThrow('Every model must reference an available profile');
    expect(current.settings_profiles.applied[profileTargetKey(testConfig.active_model)]).toEqual(application);
    expect(current.settings_profiles.applied[profileTargetKey('other.gguf')]).toEqual(other);
    expect(current.settings_profiles.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toHaveLength(2);
  });

  it('rejects saving an application whose selected profile was removed', () => {
    const { current, edit } = fixture();
    edit.library.entries = [defaultSettingsProfile()];
    expect(() => mergeProfileEditor(current, edit, 'default')).toThrow('Every model must reference an available profile');
  });

  it('commits a target snapshot and library changes together without changing another model', () => {
    const { current, edit, other } = fixture();
    edit.application.system_prompt = 'Edited prompt';
    edit.application.settings.chat_options = { stop: ['new stop'] };
    const next = mergeProfileEditor(current, edit, 'default');
    expect(next.applied[profileTargetKey(testConfig.active_model)]).toMatchObject({ system_prompt: 'Edited prompt', settings: { chat_options: { stop: ['new stop'] } } });
    expect(next.applied[profileTargetKey('other.gguf')]).toEqual(other);
    expect(next.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[0].system_prompt).toBe('Original prompt');
    edit.application.system_prompt = 'Changed later';
    expect(next.applied[profileTargetKey(testConfig.active_model)].system_prompt).toBe('Edited prompt');
  });

  it.each(['default', 'work', undefined])('saves final normalized values into the selected global profile for target %s', sessionId => {
    const { current, edit, other } = fixture();
    const before = structuredClone(current);
    edit.saveMode = 'all';
    edit.library.entries[0].revision = 2;
    edit.application = { ...edit.application, profile_revision: 2, system_prompt: 'Final prompt',
      settings: { ...edit.application.settings, active_backend: 'vulkan', active_build: 'normalized-build', ngl: 9, mmproj: 'models/vision.gguf', runtime_defaults: [] } };
    const next = mergeProfileEditor(current, edit, sessionId);
    expect(next.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[0]).toMatchObject({ id: 'shared', scope: 'global', revision: 2, system_prompt: 'Final prompt',
      settings: { ngl: 9, mmproj: 'models/vision.gguf' } });
    expect(next.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[0].coverage).not.toContain('active_backend');
    expect(next.applied[profileTargetKey(other.model)]).toEqual(other);
    if (sessionId === undefined) expect(next.applied).toEqual(current.settings_profiles.applied);
    else expect(next.applied[profileTargetKey(testConfig.active_model, sessionId)]).toMatchObject({ profile_id: 'shared', profile_revision: 2, system_prompt: 'Final prompt' });
    expect(current).toEqual(before);
  });

  it('keeps benchmark-controlled values and prompt while saving final editable fields to a legacy profile', () => {
    const { current, edit } = fixture();
    current.settings_profiles.entries[0] = { ...current.settings_profiles.entries[0], legacy: true, coverage: ['temperature', 'threads'],
      settings: { temperature: 0.2, threads: 4, runtime_defaults: ['temperature'] } };
    edit.library = structuredClone(current.settings_profiles);
    edit.saveMode = 'benchmark';
    edit.application = { ...edit.application, system_prompt: 'Workload prompt', settings: { ...edit.application.settings,
      temperature: 1.5, threads: 7, ngl: 12, runtime_defaults: [] } };
    const next = mergeProfileEditor(current, edit);
    expect(next.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[0]).toMatchObject({ id: 'shared', revision: 2, system_prompt: 'Original prompt',
      settings: { temperature: 0.2, threads: 7, ngl: 12, runtime_defaults: ['temperature'] } });
    expect(next.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[0].coverage).toContain('ngl');
    expect(next.applied).toEqual(current.settings_profiles.applied);
  });

  it('rejects stale library edits before any target or source data is changed', () => {
    const { current, edit } = fixture();
    const before = structuredClone(current);
    edit.baseRevision = 3;
    expect(() => mergeProfileEditor(current, edit, 'default')).toThrow('Profiles changed elsewhere');
    expect(current).toEqual(before);
  });

  it('synchronizes deleted-profile replacements into the active model and every affected session', () => {
    const { current: original, application, other } = fixture();
    const fallback = { ...defaultSettingsProfile(), settings: { temperature: 0.55, threads: 9 }, system_prompt: 'Fallback prompt' };
    const sessions = [
      { id: 'first', name: 'First session', enabled: true, models: { primary_model: 'first.gguf', mmproj: 'first-projector.gguf', draft_model: '' },
        gpu: emptyGpuPlacement(), execution: { temperature: 0.2, threads: 2 }, model_profile_id: 'legacy-first' },
      { id: 'second', name: 'Second session', enabled: false, models: { primary_model: 'second.gguf', mmproj: '', draft_model: 'second-draft.gguf' },
        gpu: emptyGpuPlacement(), execution: { temperature: 0.3, threads: 3 }, model_profile_id: 'legacy-second' },
      { id: 'untouched', name: 'Keep session', enabled: true, models: { primary_model: 'keep.gguf', mmproj: '', draft_model: '' },
        gpu: emptyGpuPlacement(), execution: { temperature: 0.8, threads: 4 }, model_profile_id: 'legacy-keep' },
    ];
    const current = { ...original, port: 9090, sessions, settings_profiles: { ...original.settings_profiles,
      entries: [original.settings_profiles.entries[0], fallback], applied: { ...original.settings_profiles.applied } } };
    for (const definition of sessions) {
      const source = definition.id === 'untouched' ? fallback : current.settings_profiles.entries[0];
      current.settings_profiles.applied[profileTargetKey(definition.models.primary_model, definition.id)] = materializeProfileApplication(sessionConfig(current, definition), `${definition.id} prompt`, source);
    }
    const before = structuredClone(current);
    const edit = { baseRevision: current.settings_profiles.revision, library: deleteSettingsProfile(current.settings_profiles, 'shared'), application };
    const patch = profileLibraryConfigPatch(current, edit);
    expect(patch).toMatchObject({ temperature: 0.55, threads: 9 });
    expect(patch).not.toHaveProperty('port');
    expect(patch).not.toHaveProperty('active_model');
    expect(patch.settings_profiles!.applied[profileTargetKey(current.active_model)]).toMatchObject({ profile_id: fallback.id, system_prompt: 'Fallback prompt' });
    expect(patch.settings_profiles!.applied[profileTargetKey(other.model)]).toMatchObject({ model: other.model, profile_id: fallback.id, settings: { temperature: 0.55 } });
    for (const [index, definition] of sessions.entries()) {
      const target = patch.sessions![index];
      if (definition.id === 'untouched') {
        expect(target).toEqual(definition);
        expect(patch.settings_profiles!.applied['session:untouched']).toEqual(current.settings_profiles.applied['session:untouched']);
      } else {
        expect(target).toMatchObject({ id: definition.id, name: definition.name, enabled: definition.enabled,
          models: definition.models, gpu: definition.gpu, execution: { temperature: 0.55, threads: 9 } });
        expect(target).not.toHaveProperty('model_profile_id');
        expect(patch.settings_profiles!.applied[`session:${definition.id}`]).toMatchObject({ profile_id: fallback.id, system_prompt: 'Fallback prompt' });
      }
    }
    expect(current).toEqual(before);
    expect(() => profileLibraryConfigPatch(current, { ...edit, baseRevision: edit.baseRevision - 1 })).toThrow('Profiles changed elsewhere');
    expect(current).toEqual(before);
  });

  it('rejects an empty library before changing saved target snapshots', () => {
    const { current, edit } = fixture();
    edit.library.entries = [];
    const before = structuredClone(current);
    expect(() => mergeProfileEditor(current, edit)).toThrow('At least one profile');
    expect(current).toEqual(before);
  });

  it('resolves equivalent model paths and rejects a snapshot belonging to another named-session model', () => {
    const { current, application } = fixture();
    current.settings_profiles.applied[profileTargetKey('C:\\Models\\Example.gguf')] = { ...application, model: 'C:\\Models\\Example.gguf' };
    expect(appliedProfile({ ...current, active_model: 'c:/models/example.gguf' })?.system_prompt).toBe('Original prompt');
    current.settings_profiles.applied['session:work'] = { ...application, model: 'different.gguf' };
    expect(appliedProfile(current, 'work')).toBeUndefined();
  });

  it('derives request defaults from the application without consulting or mutating its source', () => {
    const { application } = fixture();
    const request = requestProfileFromApplication(application)!;
    expect(request).toMatchObject({ id: 'shared', system_prompt: 'Original prompt', stop_strings: [' end ', '\n'] });
    request.stop_strings.push('extra');
    request.chat_options.stop = [];
    expect(application.settings.chat_options?.stop).toEqual([' end ', '\n']);
    expect(requestProfileFromApplication(undefined)).toBeNull();
  });
});

describe('profile removal membership', () => {
  function removalFixture(removedId: string, retainedId: string) {
    const fallbackOptions = { synthetic_unknown: { items: ['끝', 'first', '끝'], count: 0, enabled: false } };
    const fallbackChat = { stop: [' end ', '\n'], synthetic_unknown: { order: ['second', 'first'] } };
    const fallback: SettingsProfileLibrary['entries'][number] = { ...defaultSettingsProfile(), name: 'Fallback', revision: 4,
      coverage: ['temperature', 'provider_options', 'chat_options'],
      settings: { temperature: 0.45, provider_options: { 'llama.cpp': fallbackOptions }, chat_options: fallbackChat },
      legacy_runtime: { active_runtime: 'synthetic-history', synthetic_unknown: { order: ['second', 'first'] } },
      system_prompt: '  Fallback prompt\n' };
    const removed = { ...fallback, id: removedId, name: 'Removed', revision: 1 };
    const retained = { ...fallback, id: retainedId, name: 'Retained', revision: 2 };
    const removedOther = { ...fallback, id: 'synthetic-deleted-other', name: 'Removed other', revision: 1 };
    const tail = { ...fallback, id: 'synthetic-retained-tail', name: 'Retained tail', revision: 1 };
    const sessions: NonNullable<AppConfig['sessions']> = [
      { id: 'work', name: 'Work', enabled: false, models: { primary_model: 'C:\\Synthetic\\Work.gguf', mmproj: '/synthetic/work-projector.gguf', draft_model: '/synthetic/work-draft.gguf' },
        gpu: emptyGpuPlacement(), execution: { temperature: 0.2, runtime_defaults: [], chat_options: { stop: ['old work'] } }, model_profile_id: 'legacy-work' },
      { id: 'keep', name: 'Keep', enabled: true, models: { primary_model: '/synthetic/Keep.gguf', mmproj: '', draft_model: '' },
        gpu: emptyGpuPlacement(), execution: { temperature: 0.73, runtime_defaults: [] }, model_profile_id: 'legacy-keep' },
    ];
    const current: AppConfig = { ...structuredClone(testConfig), active_provider: 'llama.cpp', active_model: 'c:/synthetic/active.gguf',
      port: 9090, runtime_defaults: [], gpu: emptyGpuPlacement(), sessions,
      provider_options: { 'llama.cpp': { synthetic_unknown: { items: ['old'], enabled: true } } }, chat_options: { stop: ['old active'] } };
    const activeKey = profileTargetKey(current.active_model);
    const active = materializeProfileApplication({ ...current, active_model: 'C:\\Synthetic\\Active.gguf' }, 'Active prompt', removed);
    const work = materializeProfileApplication(sessionConfig(current, sessions[0]), 'Work prompt', removedOther);
    const keep = materializeProfileApplication(sessionConfig(current, sessions[1]), 'Keep prompt', retained);
    current.settings_profiles = ensureProfileLibrary({ ...emptyProfileLibrary(), revision: 12, legacy_imported: true,
      entries: [removed, retained, fallback, removedOther, tail], default_profile_id: fallback.id,
      provider_defaults: { 'llama.cpp': fallback.id }, provider_recent: { 'llama.cpp': removed.id },
      applied: { [activeKey]: active, 'session:work': work, 'session:keep': keep } });
    const library = structuredClone(current.settings_profiles);
    library.entries = library.entries.filter(entry => entry.id !== removed.id && entry.id !== removedOther.id);
    library.provider_recent = {};
    for (const key of [activeKey, 'session:work']) {
      const saved = library.applied[key];
      library.applied[key] = { ...saved, profile_id: fallback.id, profile_name: fallback.name, profile_revision: fallback.revision,
        settings: { ...saved.settings, temperature: 0.45, provider_options: { 'llama.cpp': structuredClone(fallbackOptions) }, chat_options: structuredClone(fallbackChat) },
        system_prompt: '  Fallback prompt\n' };
    }
    const edit: ProfileEditorResult = { baseRevision: 12, baseLibrary: structuredClone(current.settings_profiles), library,
      application: structuredClone(library.applied[activeKey]) };
    const expectedWorkExecution = { ...structuredClone(library.applied['session:work'].settings), active_provider: 'llama.cpp' as const,
      active_backend: current.active_backend, active_build: current.active_build };
    delete expectedWorkExecution.gpu;
    delete expectedWorkExecution.mmproj;
    delete expectedWorkExecution.spec_draft_model;
    const expectedWork = { ...structuredClone(sessions[0]), execution: expectedWorkExecution };
    delete expectedWork.model_profile_id;
    const expected: Partial<AppConfig> = { settings_profiles: { ...structuredClone(library), revision: 13, legacy_imported: true },
      provider_options: { 'llama.cpp': structuredClone(fallbackOptions) }, temperature: 0.45, chat_options: structuredClone(fallbackChat),
      sessions: [expectedWork, sessions[1]] };
    return { current, edit, removed, retained, fallback, activeKey, fallbackOptions, expected };
  }

  it.each([['\u00e9', 'e\u0301'], ['Exact', 'exact'], ['__proto__', 'constructor']])('preserves complete replacements while distinguishing literal ids %s and %s', (removedId, retainedId) => {
    const { current, edit, removed, retained, activeKey, fallbackOptions, expected } = removalFixture(removedId, retainedId);
    const before = structuredClone({ current, edit });
    const patch = profileLibraryConfigPatch(current, edit);
    expect(patch).toEqual(expected);
    expect(patch.settings_profiles!.entries.map(entry => entry.id)).toEqual(expected.settings_profiles!.entries.map(entry => entry.id));
    expect(Object.keys(patch.settings_profiles!.applied)).toEqual(Object.keys(expected.settings_profiles!.applied));
    expect(patch.settings_profiles!.applied['session:keep'].profile_id).toBe(retained.id);
    expect(patch.sessions![1]).toBe(current.sessions![1]);
    expect(patch.sessions![0]).not.toBe(current.sessions![0]);
    expect(patch.settings_profiles!.entries).not.toBe(edit.library.entries);
    expect(patch.settings_profiles!.applied[activeKey].settings).not.toBe(edit.library.applied[activeKey].settings);
    const sessionOptions = patch.sessions![0].execution!.provider_options!['llama.cpp'] as typeof fallbackOptions;
    expect(sessionOptions).not.toBe(patch.settings_profiles!.applied['session:work'].settings.provider_options!['llama.cpp']);
    sessionOptions.synthetic_unknown.items.push('output-only');
    expect(patch.provider_options!['llama.cpp']).toEqual(fallbackOptions);
    expect(patch.settings_profiles!.applied['session:work'].settings.provider_options!['llama.cpp']).toEqual(fallbackOptions);
    expect({ current, edit }).toEqual(before);

    edit.library.entries.push(structuredClone(removed));
    const fresh = profileLibraryConfigPatch(current, edit);
    expect(fresh).toEqual({ settings_profiles: { ...structuredClone(edit.library), revision: 13, legacy_imported: true }, sessions: expected.sessions });
    expect(fresh).not.toHaveProperty('temperature');
    expect(current).toEqual(before.current);
  });

  it.each(['missing', 'empty'] as const)('returns only the merged library when prior entries are %s', prior => {
    const library = ensureProfileLibrary(emptyProfileLibrary());
    const current: AppConfig = { ...structuredClone(testConfig), ...(prior === 'empty' ? { settings_profiles: emptyProfileLibrary() } : {}) };
    const edit: ProfileEditorResult = { baseRevision: 0, library,
      application: materializeProfileApplication(current, '', library.entries[0]) };
    const before = structuredClone({ current, edit });
    const patch = profileLibraryConfigPatch(current, edit);
    expect(patch).toEqual({ settings_profiles: { ...structuredClone(library), revision: 1, legacy_imported: true } });
    expect(patch.settings_profiles!.entries).not.toBe(library.entries);
    expect({ current, edit }).toEqual(before);
  });

  it('uses the completed rebase result when a concurrent writer retained an added profile', () => {
    const { current, edit, retained, expected } = removalFixture('synthetic-removed', 'synthetic-kept');
    const background = { ...structuredClone(retained), id: 'synthetic-background', name: 'Background' };
    current.settings_profiles!.entries.push(background);
    current.settings_profiles!.revision = 13;
    const before = structuredClone({ current, edit });
    const patch = profileLibraryConfigPatch(current, edit);
    expect(patch).toEqual({ ...expected, settings_profiles: { ...expected.settings_profiles!,
      entries: [...expected.settings_profiles!.entries, background], revision: 14 } });
    expect({ current, edit }).toEqual(before);
  });

  it('leaves a named session unchanged when its replacement belongs to a different model', () => {
    const { current, edit, expected } = removalFixture('synthetic-removed', 'synthetic-kept');
    edit.library.applied['session:work'].model = '/synthetic/Different.gguf';
    const before = structuredClone({ current, edit });
    const wanted = { ...expected, settings_profiles: { ...structuredClone(edit.library), revision: 13, legacy_imported: true } };
    delete wanted.sessions;
    expect(profileLibraryConfigPatch(current, edit)).toEqual(wanted);
    expect({ current, edit }).toEqual(before);
  });

  it('retains upstream merge and malformed-data error priority before removal membership is computed', () => {
    type Data = ReturnType<typeof removalFixture>;
    const cases: Array<{ mutate: (data: Data) => void; error: string | typeof TypeError }> = [
      { mutate: ({ edit }) => { edit.baseRevision = 11; edit.baseLibrary = undefined; edit.library.entries = []; }, error: 'Profiles changed elsewhere. Reopen settings to review the latest profiles.' },
      { mutate: ({ edit }) => { edit.library.entries = []; }, error: 'At least one profile must remain.' },
      { mutate: ({ edit }) => {
        const saved = { ...edit.application, model: '/synthetic/Case.gguf' };
        edit.library.applied['model:/synthetic/case.gguf'] = saved;
        edit.library.applied['model:/synthetic/Case.gguf'] = { ...saved, system_prompt: 'Conflicting prompt' };
        edit.saveMode = 'all'; edit.application.profile_id = 'missing';
      }, error: 'Conflicting saved settings for the same model path.' },
      { mutate: ({ edit }) => { edit.saveMode = 'all'; edit.application.profile_id = 'missing'; }, error: 'This profile is no longer available.' },
      { mutate: ({ edit, retained }) => { edit.library.entries = edit.library.entries.filter(entry => entry.id !== retained.id); }, error: 'Every model must reference an available profile.' },
      { mutate: ({ edit }) => { edit.library.entries[0].settings = null as unknown as SettingsProfileLibrary['entries'][number]['settings'];
        edit.saveMode = 'all'; edit.application.profile_id = 'missing'; }, error: TypeError },
    ];
    for (const scenario of cases) {
      const data = removalFixture('synthetic-removed', 'synthetic-kept');
      scenario.mutate(data);
      const before = structuredClone({ current: data.current, edit: data.edit });
      expect(() => profileLibraryConfigPatch(data.current, data.edit)).toThrow(scenario.error);
      expect({ current: data.current, edit: data.edit }).toEqual(before);
    }
  });
});

describe('applied profile name refresh boundaries', () => {
  it('preserves first literal-id matches and full snapshots across independent name and entry-order changes', () => {
    for (const [firstProvider, secondProvider, firstName, secondName] of [
      ['vllm', 'llama.cpp', 'First name', 'Later duplicate'],
      ['llama.cpp', 'vllm', 'Fresh first name', 'Earlier duplicate'],
    ] as const) {
      const { current, edit } = fixture();
      const original = edit.library.entries[0];
      const literal = { ...structuredClone(original), id: '__proto__', name: 'Literal key' };
      edit.library.entries = [
        { ...structuredClone(original), provider: firstProvider, name: firstName },
        { ...structuredClone(original), provider: secondProvider, name: secondName },
        literal, edit.library.entries[1],
      ];
      edit.library.applied['session:literal'] = { ...structuredClone(edit.application), model: 'literal.gguf',
        profile_id: literal.id, profile_name: 'Old literal name', profile_revision: 0, system_prompt: ' Keep literal prompt\n' };
      const before = structuredClone({ current, edit });
      const expected = structuredClone(ensureProfileLibrary(edit.library));
      expected.applied[profileTargetKey(current.active_model)].profile_name = firstName;
      expected.applied[profileTargetKey('other.gguf')].profile_name = firstName;
      expected.applied['session:literal'].profile_name = 'Literal key';
      expected.revision = current.settings_profiles.revision + 1;
      expected.legacy_imported = true;
      const next = mergeProfileEditor(current, edit);
      expect(next).toEqual(expected);
      expect({ current, edit }).toEqual(before);
    }
  });

  it('preserves edit and target isolation while retaining the latest-only application settings boundary', () => {
    const { current, edit, other } = fixture();
    const activeKey = profileTargetKey(current.active_model);
    const latestKey = profileTargetKey('latest.gguf');
    const latestOnly = { ...structuredClone(other), model: 'latest.gguf', profile_revision: 0, system_prompt: 'Latest-only prompt\n' };
    current.settings_profiles.applied[latestKey] = latestOnly;
    edit.library.applied[activeKey].system_prompt = 'Edit takes precedence\n';
    edit.library.applied[activeKey].settings.provider_options = {
      'custom.engine': { synthetic_unknown: { order: [' second ', '\n', 'first'], enabled: false } },
    };
    edit.application = { ...edit.application, profile_revision: 0, system_prompt: 'Target prompt\n', settings: {
      ...edit.application.settings, chat_options: { stop: [' target ', '\n'] },
      provider_options: { 'custom.engine': { synthetic_unknown: { order: ['two', 'one'] } } },
    } };
    const before = structuredClone({ current, edit });
    const expected = structuredClone(ensureProfileLibrary(edit.library));
    expected.applied = { ...expected.applied, [latestKey]: structuredClone(latestOnly), 'session:work': structuredClone(edit.application) };
    for (const application of Object.values(expected.applied)) application.profile_name = 'Shared';
    expected.revision = current.settings_profiles.revision + 1;
    expected.legacy_imported = true;
    const next = mergeProfileEditor(current, edit, 'work');
    expect(next).toEqual(expected);
    expect(next.applied[activeKey]).not.toBe(edit.library.applied[activeKey]);
    expect(next.applied[activeKey].settings).not.toBe(edit.library.applied[activeKey].settings);
    expect(next.applied['session:work'].settings).not.toBe(edit.application.settings);
    expect(next.applied[latestKey]).not.toBe(latestOnly);
    expect(next.applied[latestKey].settings).toBe(latestOnly.settings);
    expect(next.entries[0]).not.toBe(edit.library.entries[0]);
    next.entries[0].settings.temperature = 1.75;
    (next.applied['session:work'].settings.chat_options!.stop as string[]).push('output only');
    expect({ current, edit }).toEqual(before);
  });

  it('preserves ordered errors, invalid final references and an unused invalid selected application', () => {
    const priorities: Array<{ mutate: (edit: ProfileEditorResult) => void; error: string }> = [
      { mutate: edit => { edit.baseRevision = 3; edit.library.entries = []; edit.saveMode = 'all'; edit.application.profile_id = 'missing'; },
        error: 'Profiles changed elsewhere. Reopen settings to review the latest profiles.' },
      { mutate: edit => { edit.library.entries = []; edit.saveMode = 'all'; edit.application.profile_id = 'missing'; },
        error: 'At least one profile must remain.' },
      { mutate: edit => { edit.saveMode = 'all'; edit.application.profile_id = 'missing'; edit.library.applied[profileTargetKey(testConfig.active_model)].profile_id = 'also-missing'; },
        error: 'This profile is no longer available.' },
    ];
    for (const { mutate, error } of priorities) {
      const { current, edit } = fixture();
      mutate(edit);
      const before = structuredClone({ current, edit });
      expect(() => mergeProfileEditor(current, edit, 'work')).toThrow(error);
      expect({ current, edit }).toEqual(before);
    }
    for (const id of [undefined, null, '', 'missing']) {
      const { current, edit } = fixture();
      if (id === '') edit.library.entries.push({ ...structuredClone(edit.library.entries[0]), id: '', name: 'Empty id' });
      edit.library.applied[profileTargetKey(current.active_model)].profile_id = id as typeof edit.application.profile_id;
      const before = structuredClone({ current, edit });
      expect(() => mergeProfileEditor(current, edit)).toThrow('Every model must reference an available profile.');
      expect({ current, edit }).toEqual(before);
    }
    const { current, edit } = fixture();
    edit.application.profile_id = 'unused-missing';
    const before = structuredClone({ current, edit });
    const expected = structuredClone(ensureProfileLibrary(edit.library));
    expected.revision = current.settings_profiles.revision + 1;
    expected.legacy_imported = true;
    expect(mergeProfileEditor(current, edit)).toEqual(expected);
    expect(() => mergeProfileEditor(current, edit, 'work')).toThrow('Every model must reference an available profile.');
    expect({ current, edit }).toEqual(before);
  });
});

describe('profile library read normalization', () => {
  function corpus() {
    const shared = { ...captureProfile(testConfig, 'Shared', 'global', 'Shared prompt'), id: 'shared' };
    const application = materializeProfileApplication(testConfig, 'Shared prompt', shared);
    const library = (overrides: Partial<SettingsProfileLibrary>): SettingsProfileLibrary => ({ ...emptyProfileLibrary(), revision: 3, legacy_imported: true,
      entries: [structuredClone(shared)], applied: {}, ...overrides });
    const saved = { ...testConfig, settings_profiles: library({ entries: [structuredClone(shared), defaultSettingsProfile()], default_profile_id: 'profile-default',
      applied: { [profileTargetKey(testConfig.active_model)]: structuredClone(application) } }) };
    const legacyEntry = { ...structuredClone(shared), id: 'legacy', scope: 'model' as const, model_key: 'model:model.gguf', source_id: 'preset-1', source_scope: 'preset' as const,
      settings: { ...shared.settings, active_backend: 'cuda', active_build: 'b9' }, coverage: [...(shared.coverage ?? []), 'active_backend'] };
    const posix = '/Models/Example.gguf';
    const posixApplication = { ...structuredClone(application), model: posix };
    return {
      missing: { ...testConfig } as AppConfig,
      empty: { ...testConfig, settings_profiles: emptyProfileLibrary() },
      saved,
      normalized: { ...testConfig, settings_profiles: profileLibrary(saved) },
      legacy: { ...testConfig, settings_profiles: library({ entries: [legacyEntry],
        applied: { [profileTargetKey(testConfig.active_model)]: { ...structuredClone(application), profile_id: 'legacy', settings: { ...application.settings, active_runtime: 'runtime-1' } } } }) },
      providers: { ...testConfig, active_provider: 'custom.synthetic' as const, settings_profiles: library({
        entries: [structuredClone(shared), { ...defaultSettingsProfile(), id: 'profile-default-vllm' }, { ...structuredClone(shared), id: 'vllm-old', provider: 'vllm' as const }],
        provider_defaults: { 'llama.cpp': 'shared', vllm: 'missing' }, provider_recent: { vllm: 'vllm-old', 'mlx-vlm': 'missing', 'llama.cpp': 'vllm-old' } }) },
      paths: { ...testConfig, settings_profiles: library({ applied: { 'model:/models/example.gguf': posixApplication,
        'model:remote-model': { ...structuredClone(application), provider: 'vllm' as const, model: 'remote-model' } } }) },
      sessions: { ...testConfig, sessions: [
        { id: 'first', name: 'First', enabled: true, models: { primary_model: 'first.gguf', mmproj: '', draft_model: '' }, gpu: emptyGpuPlacement(), execution: { temperature: 0.2 } },
        { id: 'moved', name: 'Moved', enabled: true, models: { primary_model: 'moved.gguf', mmproj: '', draft_model: '' }, gpu: emptyGpuPlacement() },
      ], settings_profiles: library({ applied: {
        [profileTargetKey(testConfig.active_model)]: { model: testConfig.active_model, settings: { temperature: 1.7 }, system_prompt: 'Anonymous' },
        'session:moved': { ...structuredClone(application), model: 'previous.gguf' },
      } }) },
      conflict: { ...testConfig, settings_profiles: library({ applied: { 'model:/models/example.gguf': posixApplication,
        [profileTargetKey(posix)]: { ...posixApplication, system_prompt: 'Different prompt' } } }) },
    } satisfies Record<string, AppConfig>;
  }
  const readable = Object.entries(corpus()).filter(([name]) => name !== 'conflict').map(([name]) => name as Exclude<keyof ReturnType<typeof corpus>, 'conflict'>);

  it.each(readable)('%s: reads without changing its source, returns owned data and stays stable after it is persisted', name => {
    const cfg = corpus()[name];
    const before = structuredClone(cfg);
    const read = profileLibrary(cfg);
    const bytes = JSON.stringify(read);
    expect(cfg).toEqual(before);
    const source = cfg.settings_profiles ?? migrateProfileLibrary(cfg);
    const once = ensureProfileLibrary(source, providerOf(cfg));
    expect(ensureProfileLibrary(once, providerOf(cfg))).toBe(once);
    expect(JSON.stringify(profileLibrary({ ...cfg, settings_profiles: JSON.parse(bytes) as SettingsProfileLibrary }))).toBe(bytes);
    const again = profileLibrary(cfg);
    expect(again).not.toBe(read);
    for (const entry of read.entries) { entry.settings.temperature = 9; entry.name = 'Changed'; }
    for (const value of Object.values(read.applied)) { value.settings.temperature = 9; value.system_prompt = 'Changed'; }
    read.provider_defaults = {};
    expect(cfg).toEqual(before);
    expect(JSON.stringify(again)).toBe(bytes);
    expect(JSON.stringify(profileLibrary(cfg))).toBe(bytes);
  });

  it('normalizes legacy scope, runtime selections, provider selections, model paths and session recovery', () => {
    const cases = corpus();
    const missing = profileLibrary(cases.missing);
    expect(missing.default_profile_id).toBe('profile-default');
    const current = missing.applied[profileTargetKey(testConfig.active_model)];
    expect(missing.entries.find(item => item.id === current.profile_id)).toMatchObject({ name: 'Recovered profile', provider: 'llama.cpp', system_prompt: '' });
    expect(profileLibrary(cases.empty).provider_defaults).toEqual({ 'llama.cpp': 'profile-default', vllm: 'profile-default-vllm', 'mlx-vlm': 'profile-default-mlx-vlm' });

    const legacy = profileLibrary(cases.legacy);
    const entry = legacy.entries.find(item => item.id === 'legacy')!;
    expect(entry).toMatchObject({ scope: 'global', legacy: true, legacy_runtime: { active_backend: 'cuda', active_build: 'b9' } });
    expect(entry).not.toHaveProperty('model_key');
    expect(entry).not.toHaveProperty('source_id');
    expect(entry).not.toHaveProperty('source_scope');
    expect(entry.settings).not.toHaveProperty('active_backend');
    expect(entry.coverage).not.toContain('active_backend');
    expect(legacy.default_profile_id).toBe('legacy');
    expect(legacy.applied[profileTargetKey(testConfig.active_model)].settings).not.toHaveProperty('active_runtime');

    const providers = profileLibrary(cases.providers);
    expect(providers.provider_defaults).toMatchObject({ 'llama.cpp': 'shared', vllm: 'profile-default-vllm-2', 'custom.synthetic': 'profile-default-custom.synthetic' });
    expect(providers.provider_recent).toEqual({ vllm: 'vllm-old' });
    expect(providers.applied[profileTargetKey(testConfig.active_model, 'default', 'custom.synthetic')]).toMatchObject({ provider: 'custom.synthetic' });

    const paths = profileLibrary(cases.paths);
    expect(Object.keys(paths.applied)).toEqual(expect.arrayContaining(['model:/Models/Example.gguf', 'provider:vllm:model:remote-model']));
    expect(paths.applied).not.toHaveProperty('model:/models/example.gguf');
    expect(paths.applied).not.toHaveProperty('model:remote-model');
    expect(paths.applied['model:/Models/Example.gguf']).toMatchObject({ model: '/Models/Example.gguf', profile_id: 'shared', system_prompt: 'Shared prompt' });

    const sessions = profileLibrary(cases.sessions);
    const recovered = sessions.entries.find(item => item.name === 'Recovered profile' && item.id.startsWith('profile-recovered-'));
    expect(sessions.applied[profileTargetKey(testConfig.active_model)]).toMatchObject({ profile_id: recovered?.id, system_prompt: 'Anonymous', settings: { temperature: 1.7 } });
    expect(sessions.applied['session:first']).toMatchObject({ model: 'first.gguf' });
    expect(sessions.applied['session:first'].profile_id).toBeTruthy();
    expect(sessions.applied['session:moved']).toMatchObject({ model: 'moved.gguf' });
  });

  it('rejects conflicting model path snapshots with the same error and without changing the source', () => {
    const cfg = corpus().conflict;
    const before = structuredClone(cfg);
    expect(() => profileLibrary(cfg)).toThrowError(/^Conflicting saved settings for the same model path\.$/);
    expect(() => appliedProfile(cfg)).toThrowError(/^Conflicting saved settings for the same model path\.$/);
    expect(cfg).toEqual(before);
  });
});
