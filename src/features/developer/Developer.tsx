import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import { useEffect, useMemo, useState } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { buildCurlSnippet, endpointUrl } from "./developerUtils";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import StatusBadge from "../../shared/ui/StatusBadge";
import { useI18n } from "../../shared/i18n/i18n";
import { modelDisplayName, normalizeDisplayPath, normalizeDisplayText } from "../../shared/lib/displayPaths";


const ENDPOINTS = [
  { method: "GET", path: "/models", description: "endpointModels" },
  { method: "POST", path: "/responses", description: "endpointResponses" },
  { method: "POST", path: "/chat/completions", description: "endpointChat" },
  { method: "POST", path: "/completions", description: "endpointCompletions" },
  { method: "POST", path: "/embeddings", description: "endpointEmbeddings" },
] as const;

function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export default function DeveloperPanel({ store, section = "api" }: { store: AppStore; section?: "api" | "gateways" | "diagnostics" }) {
  const { t } = useI18n();

  const [models, setModels] = useState<api.LocalModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateway, setGateway] = useState<{ running: boolean; url?: string }>({ running: false });
  const [copied, setCopied] = useState<string | null>(null);
  const serverReady = store.status.state === "running" && !!store.status.url && !!store.status.api_key;
  const baseUrl = serverReady ? store.status.url ?? "" : "";
  const displayUrl = baseUrl || `http://127.0.0.1:${store.cfg?.port ?? 8080}/v1`;
  const rootUrl = displayUrl.replace(/\/v1\/?$/, "");

  useEffect(() => {
    void api.anthropicGatewayStatus().then(setGateway).catch(() => setGateway({ running: false }));
  }, [serverReady]);

  const toggleGateway = async () => {
    setError(null);
    try {
      if (gateway.running) {
        await api.stopAnthropicGateway();
        setGateway({ running: false });
      } else {
        const url = await api.startAnthropicGateway();
        setGateway({ running: true, url });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const refreshModels = async () => {
    if (!serverReady) return;
    setLoadingModels(true);
    setError(null);
    try {
      const loaded = await api.localModels(baseUrl, store.status.api_key ?? "");
      setModels(loaded);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    if (serverReady) void refreshModels();
    else setModels([]);
    // Refresh only when the server transitions between ready/offline states.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverReady, baseUrl]);

  const pythonSnippet = useMemo(() => `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${displayUrl}",\n    api_key="<LOCAL_API_KEY>",\n)\n\nresponse = client.chat.completions.create(\n    model="<MODEL_ID>",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(response.choices[0].message.content)`, [displayUrl]);
  const jsSnippet = useMemo(() => `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${displayUrl}",\n  apiKey: "<LOCAL_API_KEY>",\n  dangerouslyAllowBrowser: true,\n});`, [displayUrl]);

  const copy = async (id: string, text: string) => {
    try {
      await copyText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((current) => current === id ? null : current), 1800);
    } catch (caught) {
      setError(`${t("error.wrong")}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  // The sidebar swaps which section is visible, so the page heading has to
  // follow it instead of always describing the API section.
  const sectionHeading = section === "gateways"
    ? { title: t("section.gateways"), description: t("ui.gatewaysDescription") }
    : section === "diagnostics"
    ? { title: t("section.diagnostics"), description: t("ui.diagnosticsDescription") }
      : { title: t("section.api"), description: "" };

  return (
    <div className="app-page-scroll developer-panel relative flex h-full min-h-0 flex-col overflow-auto p-4" tabIndex={0} data-developer-section={section}>
      <div className="developer-header mb-4 flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="developer-header-copy min-w-0"><div className="app-eyebrow">{t("section.developer")}</div><h2 className="mt-1 text-[18px] font-semibold tracking-tight ui-color-ink" >{sectionHeading.title}</h2>{sectionHeading.description && <p className="mt-1 max-w-2xl text-xs leading-relaxed ui-color-muted" >{sectionHeading.description}</p>}</div>
        <StatusBadge labels={[t("panel.apiReady"), t("panel.startServer")]} label={serverReady ? t("panel.apiReady") : t("panel.startServer")} tone={serverReady ? "success" : "warning"} />
      </div>
      <PanelFeedback>{error && <FeedbackBanner tone="error" title={t("error.wrong")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}</PanelFeedback>
      <PanelFeedback>{!serverReady && !error && <div className="developer-api-status" role="status" aria-live="polite">
        <span className="developer-api-status__dot" aria-hidden="true" />
        <span className="developer-api-status__title">{t("panel.apiUnavailable")}</span>
        <span className="developer-api-status__message">{t("panel.startLocalServer")}</span>
      </div>}</PanelFeedback>
      {section === "api" && <div className="developer-summary-grid mb-4 grid gap-3 app-summary-grid" role="group" aria-label={t("panel.ariaDeveloperSummary")} aria-live="polite">
        <div className="flex flex-col justify-center rounded-lg border p-3.5 ui-border-color-border ui-background-panel" ><div className="app-eyebrow ui-font-size-12px" >{t("ui.localApi")}</div><div className="mt-1 text-sm font-medium ui-color-ink" >{serverReady ? t("panel.ready") : t("panel.offline")}</div><div className="mt-1 app-text-wrap font-mono text-xs tabular-nums ui-color-faint"  title={baseUrl || t("ui.startServerForUrl")}>{baseUrl || t("ui.startServerForUrl")}</div></div>
        <div className="flex flex-col justify-center rounded-lg border p-3.5 ui-border-color-border ui-background-panel" ><div className="app-eyebrow ui-font-size-12px" >{t("ui.loadedModels")}</div><div className="mt-1 text-sm font-medium ui-color-ink" >{models.length || "—"}</div><div className="mt-1 text-xs ui-color-faint" >{t("ui.fromModelsEndpoint")}</div></div>
        <div className="flex flex-col justify-center rounded-lg border p-3.5 ui-border-color-border ui-background-panel" ><div className="app-eyebrow ui-font-size-12px" >{t("ui.gateway")}</div><div className="mt-1 text-sm font-medium ui-color-ink" >{gateway.running ? t("ui.running") : t("ui.stopped")}</div><div className="mt-1 text-xs ui-color-faint" >{t("ui.localhostOnly")}</div></div>
      </div>}

      {section === "api" && <section className="developer-section developer-section--connection grid items-start gap-3 app-balanced-columns">
        <div className="rounded-xl border p-4 ui-border-color-border ui-background-panel" tabIndex={0}>
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="app-section-title">{t("ui.connection")}</h3><p className="app-section-hint">{t("ui.apiDescription")}</p><p className="app-section-hint mt-1">{t("ui.connectionHint")}</p></div><button type="button" onClick={() => void refreshModels()} disabled={!serverReady || loadingModels} className="app-button app-button--secondary app-button--sm"><StableLabel value={loadingModels ? t("ui.checking") : t("ui.checkModels")} labels={[t("ui.checking"), t("ui.checkModels")]} /></button></div>
          <div className="mt-3.5 grid gap-3 app-form-grid"><div className="flex flex-col justify-between rounded-lg border p-3 ui-border-color-border ui-background-mono-bg" ><div className="app-eyebrow ui-font-size-12px" >{t("ui.baseUrl")}</div><div className="mt-1 break-all font-mono text-xs ui-color-accent" >{displayUrl}</div><button type="button" onClick={() => void copy("base-url", baseUrl)} disabled={!baseUrl} className="app-button app-button--secondary app-button--sm mt-2.5 self-start"><StableLabel value={copied === "base-url" ? t("panel.copied") : t("ui.copyUrl")} labels={[t("panel.copied"), t("ui.copyUrl")]} /></button></div><div className="flex flex-col justify-between rounded-lg border p-3 ui-border-color-border ui-background-mono-bg" ><div className="app-eyebrow ui-font-size-12px" >{t("ui.authorization")}</div><div className="mt-1 font-mono text-xs ui-color-ink" >Bearer &lt;LOCAL_API_KEY&gt;</div><div className="mt-2 text-xs ui-color-faint" >{t("ui.keyInMemory")}</div></div></div>
          <details className="developer-runtime-details mt-3"><summary>{t("section.diagnostics")}</summary><div className="developer-runtime-details-content flex flex-wrap gap-1.5 text-xs ui-color-faint"><span className="rounded-full border px-2.5 py-1 text-xs ui-border-color-border ui-background-surface-muted" >state: {store.status.state}</span>{store.status.pid && <span className="rounded-full border px-2.5 py-1 text-xs ui-border-color-border ui-background-surface-muted" >PID: {store.status.pid}</span>}{store.status.model && <span className="max-w-full app-text-wrap rounded-full border px-2.5 py-1 text-xs ui-border-color-border ui-background-surface-muted"  title={normalizeDisplayPath(store.status.model)}>effective: {modelDisplayName(store.status.model)}</span>}<span className="rounded-full border px-2.5 py-1 text-xs ui-border-color-border ui-background-surface-muted" >{t("ui.authLocalBearer")}</span></div></details>
        </div>
        <div className="developer-loaded-models rounded-xl border p-4 ui-border-color-border ui-background-panel" tabIndex={0}><h3 className="app-section-title">{t("ui.loadedModels")}</h3><p className="app-section-hint">{t("ui.loadedModelsHint")}</p><div className="developer-loaded-models-list"><div className="developer-model-status text-xs ui-color-faint">{!serverReady ? t("ui.serverOffline") : models.length === 0 && !loadingModels ? t("ui.noModelResponse") : ""}</div>{models.map((model) => { const displayModelId = normalizeDisplayPath(model.id); return <div key={model.id} className="mt-3 rounded-lg border p-2.5 ui-border-color-border ui-background-mono-bg" ><div className="app-text-wrap font-mono text-xs ui-color-ink"  title={displayModelId}>{displayModelId}</div><div className="mt-1 text-xs ui-color-faint" >{model.owned_by || "llama.cpp"}</div></div>; })}</div></div>
      </section>}

      {section === "api" && <section className="developer-section developer-section--endpoints mt-4 rounded-xl border p-4 ui-border-color-border ui-background-panel" ><div className="flex items-start justify-between gap-3"><div><h3 className="app-section-title">{t("ui.endpointsTitle")}</h3><p className="app-section-hint">{t("ui.endpointsHint")}</p></div><span className="rounded-full border px-2.5 py-1 text-xs tabular-nums ui-border-color-border ui-background-surface-muted ui-color-faint" >/v1</span></div><div className="mt-3.5 grid gap-2.5 app-form-grid">{ENDPOINTS.map((endpoint) => { const id = `${endpoint.method}-${endpoint.path}`; const snippet = buildCurlSnippet(displayUrl, endpoint.path); return <div key={id} className="rounded-lg border p-3 ui-border-color-border ui-background-mono-bg" ><div className="flex items-center gap-2"><span className="rounded px-1.5 py-0.5 font-mono text-xs font-semibold tracking-wide ui-background-accent-soft ui-color-accent" >{endpoint.method}</span><code className="font-mono text-xs ui-color-ink" >/v1{endpoint.path}</code></div><p className="mt-2 text-xs leading-relaxed ui-color-muted" >{t(`ui.${endpoint.description}`)}</p><button type="button" onClick={() => void copy(id, snippet)} aria-label={`${t("ui.copyCurl")}: ${endpoint.method} /v1${endpoint.path}`} className="app-button app-button--secondary app-button--sm mt-2.5"><StableLabel value={copied === id ? t("ui.copiedCurl") : t("ui.copyCurl")} labels={[t("ui.copiedCurl"), t("ui.copyCurl")]} /></button></div>; })}</div></section>}

      {section === "api" && <section className="developer-section developer-section--compatibility mt-4 grid gap-3 app-form-grid">
        <div className="rounded-xl border p-4 ui-border-color-border ui-background-panel" tabIndex={0}>
          <h3 className="app-section-title">{t("ui.lmStudioTitle")}</h3>
          <p className="app-section-hint">{t("ui.lmStudioHint")}</p>
          <code className="mt-3 block break-all rounded-lg p-3 font-mono text-xs ui-background-mono-bg ui-color-accent" >{rootUrl}/api/v1/chat</code>
          <div className="mt-2.5 flex flex-wrap gap-1.5 text-xs ui-color-faint" ><span className="rounded-full border px-2.5 py-1 ui-border-color-border ui-background-surface-muted" >stateful chat</span><span className="rounded-full border px-2.5 py-1 ui-border-color-border ui-background-surface-muted" >load/unload</span><span className="rounded-full border px-2.5 py-1 ui-border-color-border ui-background-surface-muted" >download status</span></div>
          <button type="button" onClick={() => void copy("native-chat", `curl ${rootUrl}/api/v1/chat \\\n  -H "Authorization: Bearer <LOCAL_API_KEY>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"<MODEL_ID>","input":"Hello","stream":true}'`)} aria-label={`${t("ui.copyNativeCurl")}: LM Studio /api/v1/chat`} className="app-button app-button--secondary app-button--sm mt-3"><StableLabel value={copied === "native-chat" ? t("ui.copiedCurl") : t("ui.copyNativeCurl")} labels={[t("ui.copiedCurl"), t("ui.copyNativeCurl")]} /></button>
        </div>
        <div className="rounded-xl border p-4 ui-border-color-border ui-background-panel" tabIndex={0}>
          <h3 className="app-section-title">{t("ui.anthropicTitle")}</h3>
          <p className="app-section-hint">{t("ui.anthropicHint")}</p>
          <code className="mt-3 block break-all rounded-lg p-3 font-mono text-xs ui-background-mono-bg ui-color-accent" >{rootUrl}/v1/messages</code>
          <div className="mt-2.5 flex flex-wrap gap-1.5 text-xs ui-color-faint" ><span className="rounded-full border px-2.5 py-1 ui-border-color-border ui-background-surface-muted" >thinking blocks</span><span className="rounded-full border px-2.5 py-1 ui-border-color-border ui-background-surface-muted" >tool use</span><span className="rounded-full border px-2.5 py-1 ui-border-color-border ui-background-surface-muted" >SSE translation</span></div>
          <button type="button" onClick={() => void copy("anthropic-messages", `curl ${rootUrl}/v1/messages \\\n  -H "x-api-key: <LOCAL_API_KEY>" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json"`)} aria-label={`${t("ui.copyMessagesCurl")}: Anthropic /v1/messages`} className="app-button app-button--secondary app-button--sm mt-3"><StableLabel value={copied === "anthropic-messages" ? t("ui.copiedCurl") : t("ui.copyMessagesCurl")} labels={[t("ui.copiedCurl"), t("ui.copyMessagesCurl")]} /></button>
        </div>
      </section>}

      {section === "gateways" && <section className="developer-section developer-section--gateway mt-4 rounded-xl border p-4 ui-border-color-border ui-background-panel" ><div className="developer-section-header flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="developer-section-copy min-w-0"><h3 className="app-section-title">{t("ui.gatewayTitle")}</h3><p className="app-section-hint max-w-2xl">{t("ui.gatewayHint")}</p></div><button type="button" onClick={() => void toggleGateway()} disabled={!serverReady} className="developer-section-action app-button app-button--primary app-button--sm"><StableLabel value={gateway.running ? t("ui.stopGateway") : t("ui.startGateway")} labels={[t("ui.stopGateway"), t("ui.startGateway")]} /></button></div>{gateway.running && <div className="developer-section-status mt-3 flex min-w-0 flex-wrap items-center gap-2 text-xs ui-color-muted" ><span className="rounded-full border px-2 py-1 text-xs font-medium ui-border-color-success-border ui-background-success-bg ui-color-success-ink" >{t("ui.running")}</span><code className="developer-code-block min-w-0 break-all font-mono text-xs ui-color-accent" >{gateway.url}</code></div>}<div className="mt-2 text-xs ui-color-faint" >{t("ui.gatewayBindHint")}</div></section>}

      {section === "gateways" && <section className="developer-section developer-section--responses mt-4 rounded-xl border p-4 ui-border-color-border ui-background-panel" ><div className="developer-section-header flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="developer-section-copy min-w-0"><h3 className="app-section-title">{t("ui.responsesTitle")}</h3><p className="app-section-hint max-w-2xl">{t("ui.responsesHint")}</p></div><span className="developer-section-status rounded-full border px-2.5 py-1 text-xs ui-border-color-border ui-background-surface-muted ui-color-faint" >{gateway.running ? t("ui.responsesAvailable") : t("ui.responsesStartGateway")}</span></div><div className="developer-responses-grid mt-3.5 grid min-w-0 gap-3 app-form-grid"><code className="developer-code-block min-w-0 break-all rounded-lg p-3 font-mono text-xs ui-background-mono-bg ui-color-accent" >{gateway.url ? gateway.url.replace(/\/v1\/messages\/?$/, "") + "/v1/responses" : "http://127.0.0.1:8081/v1/responses"}</code><code className="developer-code-block min-w-0 break-all rounded-lg p-3 font-mono text-xs ui-background-mono-bg ui-color-accent" >GET/DELETE /v1/responses/&lt;id&gt;</code></div><button type="button" onClick={() => void copy("responses", `curl ${gateway.url ? gateway.url.replace(/\/v1\/messages\/?$/, "") + "/v1/responses" : "http://127.0.0.1:8081/v1/responses"} \\\n  -H "Authorization: Bearer ***" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"<MODEL_ID>","input":"Hello","previous_response_id":null,"stream":false}'`)} disabled={!gateway.running} aria-label={`${t("ui.copyResponsesCurl")}: Responses`} className="app-button app-button--secondary app-button--sm mt-3"><StableLabel value={copied === "responses" ? t("ui.copiedCurl") : t("ui.copyResponsesCurl")} labels={[t("ui.copiedCurl"), t("ui.copyResponsesCurl")]} /></button></section>}

      {section === "api" && <section className="developer-section developer-section--snippets mt-4 grid gap-3 app-form-grid"><div className="rounded-xl border p-4 ui-border-color-border ui-background-panel" tabIndex={0}><div className="flex items-center justify-between gap-3"><h3 className="app-section-title">Python</h3><button type="button" onClick={() => void copy("python", pythonSnippet)} aria-label={`${t("ui.copy")}: Python snippet`} className="app-button app-button--secondary app-button--sm"><StableLabel value={copied === "python" ? t("panel.copied") : t("ui.copy")} labels={[t("panel.copied"), t("ui.copy")]} /></button></div><pre tabIndex={0} aria-label="Python code snippet" className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg p-3 font-mono text-xs leading-relaxed ui-background-mono-bg ui-color-mono-ink" >{pythonSnippet}</pre></div><div className="rounded-xl border p-4 ui-border-color-border ui-background-panel" tabIndex={0}><div className="flex items-center justify-between gap-3"><h3 className="app-section-title">JavaScript</h3><button type="button" onClick={() => void copy("javascript", jsSnippet)} aria-label={`${t("ui.copy")}: JavaScript snippet`} className="app-button app-button--secondary app-button--sm"><StableLabel value={copied === "javascript" ? t("panel.copied") : t("ui.copy")} labels={[t("panel.copied"), t("ui.copy")]} /></button></div><pre tabIndex={0} aria-label="JavaScript code snippet" className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg p-3 font-mono text-xs leading-relaxed ui-background-mono-bg ui-color-mono-ink" >{jsSnippet}</pre></div></section>}

      {section === "diagnostics" && <section className="developer-section developer-section--diagnostics mt-4 rounded-xl border p-4 ui-border-color-border ui-background-panel" ><h3 className="app-section-title">{t("ui.diagnosticsTitle")}</h3><pre tabIndex={0} aria-label={t("ui.diagnosticsTitle")} className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg p-3 font-mono text-xs leading-relaxed ui-background-mono-bg ui-color-mono-ink" >{normalizeDisplayText(store.status.log_tail || store.status.error || t("ui.noDiagnostics"))}</pre></section>}

      {section === "api" && serverReady && <div className="developer-api-footer mt-4 text-xs ui-color-faint" >{t("ui.exampleEndpoint")}: <span className="font-mono ui-color-muted" >{endpointUrl(baseUrl, "/models")}</span>. {t("ui.keyNeverRendered")}</div>}
    </div>
  );
}
