import * as api from '../../shared/api/index';
import { executionSettings, mergeExecutionChanges } from '../../shared/config/executionSettings';
import { profileSettingsSnapshot, settingsEqual, type ProfileApplication } from '../../shared/config/settingsProfiles';
import { isLifecycleCancellation } from '../../shared/lib/serverLifecycle';
import { notifySessionStatusChanged, sessionConfig } from '../../shared/runtime/sessionUtils';
import { anySessionActivity, sessionHasActivity } from '../../shared/state/sessionActivity';
import { finishTask, updateTask } from '../../shared/state/taskRegistry';
import { type ModelSettingsRequest } from './modelSettingsContext';
import { modelSettingsCopy } from './modelSettingsCopy';
import type { LaunchCancellation, ProfilePersistenceOptions, SettingsEditor } from './modelSettingsPersistence';
import { appliedProfile, mergeProfileEditor, profileLibrary, profileTargetConfigPatch } from './profileEditor';
interface LaunchOptions extends ProfilePersistenceOptions {
  owner: LaunchCancellation; capturedEditor: SettingsEditor; saved: api.AppConfig; application: ProfileApplication;
  target: ModelSettingsRequest['target']; id: string; status: api.ServerStatus | api.SessionStatus | undefined;
  stage: (value: LaunchCancellation['stage'], phase: string) => void; assertNotCancelled: () => void;
}

export async function launchModelSettings({ latest, liveProfiles, setLaunching, copy, locale, open, owner, capturedEditor, saved, application, target, id, status, stage, assertNotCancelled }: LaunchOptions) {
          try {
            await capturedEditor.request.onApply?.(saved, application);
            assertNotCancelled();
            stage('checking', modelSettingsCopy[locale].preflightChecking);
            const prepared = await api.preflightLaunch(saved, owner.id);
            assertNotCancelled();
            let launchConfig = saved;
            let launchApplication = application;
            if (!settingsEqual(executionSettings(saved), executionSettings(prepared))) {
              stage('saving', modelSettingsCopy[locale].pending);
              const canonical = await latest.current.updateConfig(latestCfg => {
                const definition = target.kind === 'session' ? latestCfg.sessions?.find(item => item.id === id) : undefined;
                if (target.kind === 'session' && !definition) throw new Error(copy.missing);
                const currentTarget = definition ? sessionConfig(latestCfg, definition) : latestCfg;
                if (!settingsEqual(executionSettings(saved), executionSettings(currentTarget))) throw new Error(copy.conflict + 'execution');
                const resolved = mergeExecutionChanges(saved, prepared, currentTarget);
                // Do not overwrite a profile edited while engine checks ran.
                const currentApplication = appliedProfile(currentTarget, id);
                if (!currentApplication || currentApplication.profile_id !== application.profile_id
                  || currentApplication.profile_revision !== application.profile_revision
                  || currentApplication.system_prompt !== application.system_prompt
                  || !settingsEqual(currentApplication.settings, application.settings)) throw new Error(copy.conflict + 'profile');
                launchApplication = { ...application, model: resolved.active_model, settings: profileSettingsSnapshot(resolved) };
                const library = profileLibrary(latestCfg);
                return profileTargetConfigPatch(latestCfg, resolved, mergeProfileEditor(latestCfg, {
                  library, baseRevision: library.revision, application: launchApplication, saveMode: 'all',
                }, id), definition ?? null);
              });
              const canonicalTarget = target.kind === 'session' ? sessionConfig(canonical, canonical.sessions!.find(item => item.id === id)!) : canonical;
              // Keep this request's policy without reverting the newer global preference.
              launchConfig = { ...canonicalTarget, stop_existing_sessions_on_load: saved.stop_existing_sessions_on_load };
              launchApplication = appliedProfile(launchConfig, id) ?? launchApplication;
            }
            updateTask(owner.id, { action: { label: modelSettingsCopy[locale].recoverLaunch, onClick: () => open({
              ...capturedEditor.request, config: launchConfig, application: launchApplication, section: 'model',
            }) } });
            assertNotCancelled();
            // Activity can start while a lengthy check is pending. Keep the
            // original stop-other-sessions policy and never interrupt a reply.
            if (launchConfig !== saved) await capturedEditor.request.onApply?.(launchConfig, launchApplication);
            assertNotCancelled();
            const list = api.normalizeSessionList(await api.sessionList());
            assertNotCancelled();
            if (sessionHasActivity(id) || (list.find(item => item.id === id)?.active_requests ?? 0) > 0
              || (launchConfig.stop_existing_sessions_on_load !== false && (anySessionActivity() || list.some(session => (session.active_requests ?? 0) > 0)))) throw new Error(copy.activity);
            stage('loading', modelSettingsCopy[locale].loadingModel);
            let readyStatus: api.ServerStatus | api.SessionStatus | undefined;
            if (target.kind === 'session') {
              readyStatus = await api.sessionStart(id, launchConfig, launchConfig.stop_existing_sessions_on_load, { persist: false, operationId: owner.id });
            } else {
              await latest.current.start(launchConfig, status?.state === 'running', { persist: false, operationId: owner.id });
              if (!owner.cancelled) readyStatus = await api.serverStatus().catch(() => undefined);
            }
            await owner.cancellation;
            if (!owner.cancelled) liveProfiles.current.set(id, { model: launchConfig.active_model, pid: readyStatus?.pid, application: structuredClone(launchApplication) });
            if (owner.cancellationError) throw new Error(owner.cancellationError);
            finishTask(owner.id, owner.cancelled ? 'cancelled' : 'completed');
          } catch (cause) {
            await owner.cancellation;
            const failure = owner.cancellationError && isLifecycleCancellation(cause) ? new Error(owner.cancellationError) : cause;
            const cancelled = isLifecycleCancellation(failure);
            finishTask(owner.id, cancelled ? 'cancelled' : 'failed', cancelled ? undefined : (failure instanceof Error ? failure.message : String(failure)));
          } finally {
            setLaunching(current => current?.id === owner.id ? null : current);
            void latest.current.refreshStatus().catch(() => undefined); notifySessionStatusChanged();
          }
}
