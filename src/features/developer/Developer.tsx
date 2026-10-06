import { useContext, useEffect, useRef, useState } from 'react';
import * as api from '../../shared/api/index';
import type { AppStore } from '../../shared/state/store';
import type { ViewId } from '../../shared/types/navigation';
import { useSessionPolling } from '../../shared/hooks/useSessionPolling';
import { useI18n } from '../../shared/i18n/i18n';
import { modelStatusKey } from '../../shared/lib/serverLifecycle';
import { modelDisplayName, normalizeDisplayPath, normalizeDisplayText } from '../../shared/lib/displayPaths';
import PanelFeedback, { ActivePanelContext } from '../../shared/ui/PanelFeedback';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import ModelIcon from '../../shared/ui/ModelIcon';
import StableLabel from '../../shared/ui/StableLabel';
import StatusBadge from '../../shared/ui/StatusBadge';
import Badge from '../../shared/ui/Badge';
import ApiPortControl from './ApiPortControl';
import ApiExamples, { type ApiFormat } from './ApiExamples';
import { apiServerCopy } from './apiServerCopy';
import { useApiServer } from './useApiServer';
import './api-server.css';
import RuntimeSelectionLabel from '../../shared/ui/RuntimeSelectionLabel';

type Props = { store: AppStore; section?: 'api' | 'diagnostics'; onNavigate?: (view: ViewId) => void };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function DeveloperPanel({ store, section = 'api', onNavigate }: Props) {
  return section === 'diagnostics' ? <ModelDiagnostics store={store} /> : <ApiServerPanel store={store} onNavigate={onNavigate} />;
}

function ModelDiagnostics({ store }: { store: AppStore }) {
  const { t } = useI18n();
  return <div className="app-page-scroll developer-panel api-server-page" data-developer-section="diagnostics">
    <div className="api-server-content">
      <header className="api-page-heading"><h2>{t('section.diagnostics')}</h2><p>{t('ui.diagnosticsDescription')}</p></header>
      <section className="developer-section--diagnostics api-section">
        <h3>{t('ui.diagnosticsTitle')}</h3>
        <p className="api-hint">{t('ui.modelState')}: {t(modelStatusKey(store.status.state))}
          {store.status.model && <> · <span title={normalizeDisplayPath(store.status.model)}>{modelDisplayName(store.status.model)}</span></>}
        </p>
        <p className="api-hint"><RuntimeSelectionLabel config={store.status.engine ? { ...store.cfg, active_provider: store.status.engine.provider, active_runtime: store.status.engine.runtime_id } : store.cfg} /></p>
        <pre tabIndex={0} aria-label={t('ui.diagnosticsTitle')} data-empty={!store.status.log_tail && !store.status.error} data-error={Boolean(store.status.error)} className="api-code">{normalizeDisplayText(store.status.log_tail || store.status.error || t('ui.noDiagnostics'))}</pre>
      </section>
    </div>
  </div>;
}

function ApiServerPanel({ store, onNavigate }: Omit<Props, 'section'>) {
  const { t, locale } = useI18n();
  const copy = apiServerCopy[locale];
  const [models, setModels] = useState<api.LocalModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsFetched, setModelsFetched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [format, setFormat] = useState<ApiFormat>('openai');
  const configuredPort = store.cfg?.port ?? 8080;
  const panelActive = useContext(ActivePanelContext);
  const apiServer = useApiServer(configuredPort, panelActive);
  const apiRunning = apiServer.status.running;
  const apiPending = apiServer.pending;
  const baseUrl = apiRunning ? apiServer.status.url ?? '' : '';
  const apiKey = apiRunning ? apiServer.status.api_key ?? '' : '';
  const canQueryModels = !!baseUrl && !!apiKey;
  const displayUrl = baseUrl || `http://127.0.0.1:${configuredPort}/v1`;
  const connectionUrl = format === 'anthropic' ? displayUrl.replace(/\/v1\/?$/, '') : displayUrl;
  const modelsRequest = useRef(0);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => { window.clearTimeout(copyTimer.current); }, []);

  const refreshModels = async (background = false) => {
    if (!canQueryModels) return;
    const request = ++modelsRequest.current;
    if (!background) { setLoadingModels(true); setError(null); }
    try {
      const loaded = await api.localModels(baseUrl, apiKey);
      if (request === modelsRequest.current) { setModels(loaded); setModelsFetched(true); }
    } catch (caught) {
      if (request === modelsRequest.current && !background) setError(errorMessage(caught));
    } finally {
      if (request === modelsRequest.current) setLoadingModels(false);
    }
  };

  useEffect(() => {
    if (canQueryModels && panelActive) void refreshModels();
    else if (!canQueryModels) { modelsRequest.current += 1; setModels([]); setModelsFetched(false); setLoadingModels(false); }
    // Default model changes and returning to the page refresh its public model IDs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canQueryModels, baseUrl, apiKey, panelActive, store.status.state, store.status.model]);

  const sessionSignature = useRef<string | null>(null);
  useSessionPolling({
    active: panelActive && canQueryModels,
    details: false,
    onData: sessions => {
      const signature = sessions.map(session => `${session.id}:${session.state}:${session.model ?? ''}`).sort().join('|');
      const changed = sessionSignature.current !== null && sessionSignature.current !== signature;
      sessionSignature.current = signature;
      if (changed) void refreshModels(true);
    },
  });

  const applyPort = async (port: number): Promise<boolean> => {
    setError(null);
    try { await store.updateConfig({ port }); }
    catch (caught) { setError(errorMessage(caught)); return false; }
    if (apiRunning) await apiServer.restart();
    return true;
  };

  const copyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      window.clearTimeout(copyTimer.current);
      setCopied(id);
      copyTimer.current = window.setTimeout(() => setCopied(null), 1800);
    } catch (caught) { setError(errorMessage(caught)); }
  };
  const copyButton = (id: string, value: string, label: string, disabled = false) =>
    <button type="button" className="app-button app-button--secondary app-button--sm" disabled={disabled} data-icon="copy" onClick={() => void copyText(id, value)}>
      <StableLabel value={copied === id ? t('panel.copied') : label} labels={[t('panel.copied'), label]} />
    </button>;

  const pendingLabels = { starting: t('ui.apiStarting'), stopping: t('ui.apiStopping'), restarting: t('ui.apiRestarting') };
  const apiStatusLabel = apiPending ? pendingLabels[apiPending] : apiRunning ? t('ui.apiRunning') : t('ui.apiStopped');
  const modelsMessage = !apiRunning ? copy.modelsOff : loadingModels && !modelsFetched ? copy.modelsChecking
    : !modelsFetched ? copy.modelsUnavailable : models.length ? ''
      : store.status.state === 'starting' ? copy.modelsLoading : copy.modelsEmpty;

  return <div className="app-page-scroll developer-panel api-server-page" data-developer-section="api">
    <div className="api-server-content">
      <header className="api-page-heading"><h2>{t('section.api')}</h2><p>{copy.intro}</p></header>
      <ol className="api-steps">{copy.steps.map((step, index) => <li key={step}><span aria-hidden="true">{index + 1}</span>{step}</li>)}</ol>
      <PanelFeedback>
        {apiServer.error && <FeedbackBanner tone="error" title={t('ui.apiFailedTitle')} onDismiss={apiServer.clearError}>{apiServer.error}</FeedbackBanner>}
        {error && <FeedbackBanner tone="error" title={t('error.wrong')} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
      </PanelFeedback>
      <section className="api-server-control">
        <div className="developer-api-status" role="status" aria-live="polite">
          <StatusBadge tone={apiPending ? 'warning' : apiRunning ? 'success' : 'neutral'} label={apiStatusLabel} />
          <p>{apiRunning ? copy.running : copy.stopped}</p>
        </div>
        <button type="button" onClick={() => void (apiRunning ? apiServer.stop() : apiServer.start())} disabled={!apiServer.checked || apiPending !== null}
          aria-busy={apiPending !== null} className={`app-button ${apiRunning ? 'app-button--secondary' : 'app-button--primary'}`}>
          <StableLabel value={apiPending ? apiStatusLabel : apiRunning ? t('ui.stopApi') : t('ui.startApi')} labels={[t('ui.startApi'), t('ui.stopApi'), ...Object.values(pendingLabels)]} />
        </button>
      </section>
      <span className="sr-only" role="status" aria-live="polite">{copied ? t('panel.copied') : ''}</span>

      <section className="api-section api-models">
        <div className="api-section-heading">
          <h3>{copy.models}{apiRunning && modelsFetched && <Badge className="api-model-count">{models.length}</Badge>}</h3>
          <div className="api-inline-actions">
            {canQueryModels && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={loadingModels} data-icon="refresh" onClick={() => void refreshModels()}>{loadingModels ? t('ui.checking') : copy.refresh}</button>}
            {onNavigate && <button type="button" className="app-button app-button--secondary app-button--sm" data-icon="open" onClick={() => onNavigate('models')}>{copy.openModels}</button>}
          </div>
        </div>
        {modelsMessage && <p className="api-hint">{modelsMessage}</p>}
        {models.length > 0 && <>
          <p className="api-hint">{copy.modelHint}</p>
          <ul className="api-model-list">{models.map(model => <li key={model.id}>
            <code title={normalizeDisplayPath(model.id)}><ModelIcon model={model.id} />{normalizeDisplayPath(model.id)}</code>
            {copyButton(`model:${model.id}`, model.id, copy.copyModel)}
          </li>)}</ul>
        </>}
      </section>

      <section className="api-section api-connection">
        <h3>{copy.connection}</h3><p className="api-hint">{copy.connectionHint}</p>
        <div className="api-format-field">
          <label htmlFor="api-connection-format">{copy.format}</label>
          <CustomSelect<ApiFormat> id="api-connection-format" ariaDescribedBy="api-format-hint" value={format} onChange={value => { setFormat(value); setCopied(null); }}
            options={[{ value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }]} />
          <p id="api-format-hint" className="api-hint">{copy.formatHint}</p>
        </div>
        <dl className="api-connection-values">
          <div><dt>{t('ui.baseUrl')}</dt><dd><code>{connectionUrl}</code>{copyButton('base-url', connectionUrl, t('ui.copyUrl'), !baseUrl)}</dd></div>
          <div><dt>{copy.key}</dt><dd><code aria-hidden="true">••••••••••••••••</code>{copyButton('api-key', apiKey, t('ui.copyApiKey'), !apiKey)}</dd></div>
        </dl>
        <p className="api-hint api-key-hint">{copy.keyHint}</p>
      </section>

      <details className="api-disclosure">
        <summary>{copy.settings}</summary>
        <div className="api-disclosure-content">
          {store.cfg && <ApiPortControl savedPort={configuredPort} running={apiRunning} runningPort={apiServer.status.port}
            disabled={!apiServer.checked || apiPending !== null} onApply={applyPort} onRestart={() => void apiServer.restart()} />}
          {onNavigate && <button type="button" className="app-button app-button--ghost app-button--sm" data-icon="open" onClick={() => onNavigate('diagnostics')}>{copy.diagnostics}</button>}
        </div>
      </details>
      <ApiExamples baseUrl={displayUrl} format={format} onCopy={text => void copyText('example', text)} copied={copied === 'example'} />
    </div>
  </div>;
}
