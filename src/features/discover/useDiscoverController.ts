import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import * as api from '../../shared/api/index';
import { useI18n } from '../../shared/i18n/i18n';
import { modelActions } from '../../shared/i18n/modelActions';
import { useDraftGuard } from '../../shared/state/draftGuard';
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { previewExecution } from '../models/modelExecutionState';
import type { DiscoverProps, DownloadedChoice, DownloadNotice } from './discoverControllerTypes';
import { discoverTokenCopy } from './discoverTokenCopy';
import { useDiscoverCatalog } from './useDiscoverCatalog';
import { useDiscoverTransfers } from './useDiscoverTransfers';
import { usePendingDownloads } from './usePendingDownloads';

/** Composes catalog, concurrent transfers and dialog handoff without assigning an artifact an engine. */
export function useDiscoverController({ store, active = true, onSelectModel, onOpenModels }: DiscoverProps) {
  const { t, locale } = useI18n();
  const [includeCompanions, setIncludeCompanions] = useState(false);
  const [fileFilter, setFileFilter] = useState('');
  const [hfTokenConfigured, setHfTokenConfigured] = useState(false);
  const [hfTokenInput, setHfTokenInput] = useState('');
  const [hfTokenBusy, setHfTokenBusy] = useState(false);
  const [hfTokenFeedback, setHfTokenFeedback] = useState<{ tone: 'info' | 'error'; message: string } | null>(null);
  const [hfTokenOpen, setHfTokenOpen] = useState(false);
  const modelSettings = useModelSettings();
  const modelCopy = modelActions(locale);
  const tokenCopy = discoverTokenCopy[locale];
  const [downloadedChoices, setDownloadedChoices] = useState<DownloadedChoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<DownloadNotice | null>(null);
  const guard = useDraftGuard();
  const latestStore = useRef(store);
  latestStore.current = store;
  const modelsDir = store.cfg?.models_dir ?? '';

  const recordDownloadedChoice = useCallback((choice: DownloadedChoice) => {
    setDownloadedChoices((current) => [
      choice,
      ...current.filter(
        (item) =>
          !(
            item.repo === choice.repo &&
            item.destination === choice.destination &&
            (item.filePath ?? '') === (choice.filePath ?? '')
          ),
      ),
    ]);
  }, []);

  const clearDownloadedChoice = useCallback(
    (target: { repo: string; destination: string; filePath?: string }) => {
      setDownloadedChoices((current) =>
        current.filter(
          (item) =>
            !(
              item.repo === target.repo &&
              item.destination === target.destination &&
              (item.filePath ?? '') === (target.filePath ?? '')
            ),
        ),
      );
    },
    [],
  );

  const resetFeedback = useCallback(() => {
    setError(null);
    setNotice(null);
    setDownloadedChoices([]);
  }, []);

  const catalog = useDiscoverCatalog({ active, modelsDir, resetFeedback, setIncludeCompanions, setError });
  const transfers = useDiscoverTransfers({
    store,
    latestStore,
    catalog,
    includeCompanions,
    modelSettings,
    guard,
    t,
    setError,
    setNotice,
    recordDownloadedChoice,
    clearDownloadedChoice,
    onSelectModel,
    onOpenModels,
  });
  const pendingDownloads = usePendingDownloads({
    active,
    latestStore,
    setError,
    setNotice,
    recordDownloadedChoice,
    setInstalledRevision: catalog.setInstalledRevision,
    t,
  });
  const { selected } = catalog;
  const currentDownloadedChoices = downloadedChoices.filter(
    (choice) => choice.repo === selected?.id && choice.destination === modelsDir,
  );

  useEffect(() => {
    setFileFilter('');
  }, [selected?.id]);

  useEffect(() => {
    if (!active || !api.isNativeRuntimeAvailable() || typeof api.hfTokenStatus !== 'function') return;
    let cancelled = false;
    void api
      .hfTokenStatus()
      .then((status) => {
        if (!cancelled) setHfTokenConfigured(status.configured);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active]);

  const saveHfToken = async () => {
    if (hfTokenBusy || typeof api.hfSetToken !== 'function') return;
    setHfTokenBusy(true);
    setHfTokenFeedback(null);
    try {
      const status = await api.hfSetToken(hfTokenInput);
      setHfTokenConfigured(status.configured);
      setHfTokenInput('');
      setHfTokenFeedback({ tone: 'info', message: tokenCopy.tokenSaved });
      if (catalog.selected && catalog.currentInspectionError) {
        void catalog.inspect(catalog.selected);
      }
    } catch (cause) {
      setHfTokenFeedback({
        tone: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setHfTokenBusy(false);
    }
  };

  const clearHfToken = async () => {
    if (hfTokenBusy || typeof api.hfClearToken !== 'function') return;
    setHfTokenBusy(true);
    setHfTokenFeedback(null);
    try {
      const status = await api.hfClearToken();
      setHfTokenConfigured(status.configured);
      setHfTokenInput('');
      setHfTokenFeedback({ tone: 'info', message: tokenCopy.tokenCleared });
    } catch (cause) {
      setHfTokenFeedback({
        tone: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setHfTokenBusy(false);
    }
  };

  const configureDownloaded = (choice: { path: string; projector: boolean }) => {
    const cfg = latestStore.current.getConfig();
    if (!cfg) return;
    try {
      const config = choice.projector
        ? { ...cfg, mmproj: choice.path }
        : { ...cfg, ...previewExecution(cfg, choice.path), active_model: choice.path };
      if (modelSettings) {
        modelSettings.open({
          target: { kind: 'default' },
          config,
          section: choice.projector ? 'adapters' : 'model',
        });
      } else {
        void guard
          .run(async () => {
            if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state)) {
              throw new Error(t('ui.stopBeforeDownload'));
            }
            await latestStore.current.updateConfig((current) =>
              choice.projector
                ? { mmproj: choice.path }
                : { ...previewExecution(current, choice.path), active_model: choice.path },
            );
            if (onSelectModel && !choice.projector) await onSelectModel(choice.path);
            onOpenModels?.();
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openModelCard = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!selected || !api.isNativeRuntimeAvailable()) return;
    event.preventDefault();
    void api.hfOpenModelCard(selected.id).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  };

  return {
    store,
    t,
    locale,
    tokenCopy,
    includeCompanions,
    setIncludeCompanions,
    modelCopy,
    error,
    setError,
    notice,
    setNotice,
    fileFilter,
    setFileFilter,
    hfTokenConfigured,
    hfTokenInput,
    setHfTokenInput,
    hfTokenBusy,
    hfTokenFeedback,
    setHfTokenFeedback,
    hfTokenOpen,
    setHfTokenOpen,
    saveHfToken,
    clearHfToken,
    modelsDir,
    currentDownloadedChoices,
    configureDownloaded,
    ...catalog,
    ...transfers,
    ...pendingDownloads,
    openModelCard,
  };
}
