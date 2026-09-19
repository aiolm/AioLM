import { useRef, useState } from 'react';
import type { AppConfig } from '../../shared/api/types';
import { defaultSettingsProfileEntry, deleteSettingsProfile, materializeProfileApplication, profileDeletionIds, profileTargetKey, setDefaultSettingsProfile, settingsEqual, type ProfileApplication, type SettingsProfile } from '../../shared/config/settingsProfiles';
import { applyDefaultProfile, resolveProfileApplication, resolveProfileApplicationOrDefault, resolveProfileForExecution } from '../../shared/config/profileAssignments';
import { executionConfig } from '../../shared/config/executionSettings';
import { profileLibrary, type ProfileEditorResult } from './profileEditor';
import { applyProfile, profileForChoice, newProfile, overwriteWorkingProfile, type ProfileChoice } from './profileWorkspaceState';

/** Preview belongs to the view; mutations are prepared here and adopted only after persistence succeeds. */
export function useProfileEditor(initial: AppConfig, cfg: AppConfig, initialApplication: ProfileApplication | undefined, benchmark: boolean,
  displayName: (profile: SettingsProfile) => string = profile => profile.name) {
  const [resolved] = useState(() => resolveProfileApplicationOrDefault(cfg, profileLibrary(initial),
    initialApplication && profileTargetKey(initialApplication.model) === profileTargetKey(cfg.active_model) ? initialApplication : undefined));
  const [library, setLibrary] = useState(resolved.library);
  const original = useRef(resolved.application);
  const savedSettings = useRef(cfg);
  const [systemPrompt, setPrompt] = useState(resolved.application.system_prompt);
  const working = !settingsEqual(cfg, savedSettings.current) || systemPrompt !== original.current.system_prompt;
  const selected = library.entries.find(entry => entry.id === original.current.profile_id) ?? resolved.profile;
  const available = library.entries.filter(entry => entry.scope === 'global' || entry.model_key === profileTargetKey(cfg.active_model));
  const setSystemPrompt = setPrompt;
  const prepared = (nextLibrary = library, next = cfg, profile: SettingsProfile = selected, prompt = systemPrompt, applyTarget = true, saveMode?: ProfileEditorResult['saveMode']): { config: AppConfig; applyTarget: boolean; edit: ProfileEditorResult } => ({
    config: next, applyTarget, edit: { baseRevision: library.revision, baseLibrary: structuredClone(library), library: nextLibrary,
      application: materializeProfileApplication(next, prompt, profile), ...(saveMode ? { saveMode } : {}) },
  });
  const prepareApply = (choice: ProfileChoice) => {
    const nextLibrary = structuredClone(library);
    const profile = profileForChoice(nextLibrary, choice);
    const next = applyProfile(cfg, profile, benchmark);
    return prepared(nextLibrary, next, profile, benchmark ? systemPrompt : profile.system_prompt ?? systemPrompt);
  };
  const prepareSaveAs = (name: string, scope: SettingsProfile['scope']) => {
    if (available.some(entry => (entry.scope === scope || scope === 'global' && entry.scope === 'model')
      && (entry.name === name.trim() || displayName(entry) === name.trim()))) throw new Error('A profile with this name already exists.');
    const entry = newProfile(cfg, name, scope, systemPrompt, benchmark);
    const nextLibrary = structuredClone(library); nextLibrary.entries.push(entry);
    return prepared(nextLibrary, cfg, entry, systemPrompt, true, benchmark ? 'benchmark' : 'all');
  };
  const prepareUpdate = (id: string) => {
    if (id === selected.id) return { config: cfg, applyTarget: true, edit: result() };
    const nextLibrary = structuredClone(library);
    const entry = nextLibrary.entries.find(item => item.id === id);
    if (!entry) throw new Error('This profile is no longer available.');
    nextLibrary.entries = nextLibrary.entries.map(item => item.id === id ? overwriteWorkingProfile(item, cfg, systemPrompt, benchmark) : item);
    return prepared(nextLibrary, cfg, selected, systemPrompt, false);
  };
  const prepareRename = (id: string, name: string) => {
    const nextLibrary = structuredClone(library);
    const entry = nextLibrary.entries.find(item => item.id === id);
    if (!entry || !name.trim()) throw new Error('A profile name is required.');
    const renamedIds = new Set(nextLibrary.entries.filter(item => item.id === id || item.source_id === id && item.name === entry.name).map(item => item.id));
    nextLibrary.entries = nextLibrary.entries.map(item => renamedIds.has(item.id)
      ? { ...item, name: name.trim(), revision: item.revision + 1 } : item);
    if (nextLibrary.entries.some(item => renamedIds.has(item.id) && nextLibrary.entries.some(other => other.id !== item.id
      && other.scope === item.scope && other.model_key === item.model_key && (other.name === item.name || displayName(other) === item.name)))) {
      throw new Error('A profile with this name already exists.');
    }
    return prepared(nextLibrary, cfg, selected, systemPrompt, false);
  };
  const prepareDelete = (id: string) => {
    const nextLibrary = deleteSettingsProfile(library, id);
    if (profileDeletionIds(library, id).has(selected.id)) {
      const fallback = defaultSettingsProfileEntry(nextLibrary);
      return prepared(nextLibrary, applyProfile(cfg, fallback, benchmark), fallback, benchmark ? systemPrompt : fallback.system_prompt ?? '', false);
    }
    return prepared(nextLibrary, cfg, selected, systemPrompt, false);
  };
  const prepareSetDefault = (id: string) => prepared(setDefaultSettingsProfile(library, id), cfg, selected, systemPrompt, false);
  const resetModel = (next: AppConfig, sessionId = 'default') => {
    const key = profileTargetKey(next.active_model, sessionId);
    const previous = library.applied[key];
    const application = previous && profileTargetKey(previous.model) === profileTargetKey(next.active_model) ? previous
      : applyDefaultProfile(next, library).application;
    const assignment = resolveProfileForExecution(next, library,
      application, key);
    original.current = assignment.application;
    savedSettings.current = executionConfig(next, assignment.application.settings);
    setLibrary(assignment.library); setPrompt(assignment.application.system_prompt);
    return executionConfig(next, assignment.application.settings);
  };
  const result = (): ProfileEditorResult => {
    const nextLibrary = structuredClone(library);
    const profile = overwriteWorkingProfile(selected, cfg, systemPrompt, benchmark);
    nextLibrary.entries = nextLibrary.entries.map(item => item.id === profile.id ? profile : item);
    return { baseRevision: library.revision, baseLibrary: structuredClone(library), library: nextLibrary, application: materializeProfileApplication(cfg, systemPrompt, profile), saveMode: benchmark ? 'benchmark' : 'all' };
  };
  const acceptSaved = (saved: AppConfig, application: ProfileApplication) => {
    savedSettings.current = saved;
    const assignment = resolveProfileApplication(saved, profileLibrary(saved), application);
    setLibrary(assignment.library); original.current = assignment.application;
    setPrompt(assignment.application.system_prompt);
  };
  const acceptMetadata = (saved: AppConfig, application: ProfileApplication) => {
    savedSettings.current = saved;
    const assignment = resolveProfileApplication(saved, profileLibrary(saved), application);
    setLibrary(assignment.library); original.current = assignment.application;
  };
  return { library, selected, available, systemPrompt, setSystemPrompt, working, savedApplication: original.current,
    prepareApply, prepareSaveAs, prepareUpdate, prepareRename, prepareDelete, prepareSetDefault, resetModel, result, acceptSaved, acceptMetadata };
}
