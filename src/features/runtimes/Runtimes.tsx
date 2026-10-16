import ExternalRuntimeRegistration from './ExternalRuntimeRegistration';
import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import { LocalTaskCancelButton } from "../../shared/ui/TaskCancellation";
import type { AppStore } from "../../shared/state/store";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import Switch from "../../shared/ui/Switch";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import { useI18n } from "../../shared/i18n/i18n";
import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import { executionText } from "../../shared/i18n/executionI18n";
import { adapterCatalogCopy, fillAdapterCopy } from '../../shared/i18n/adapterCatalogCopy';
import { useRuntimesController } from "./useRuntimesController";
import { computeVisibleRows, deviceSummaryOf } from "./runtimeRowPresentation";
import RuntimeDeviceCard from "./RuntimeDeviceCard";
import RuntimeCapabilitiesCard from "./RuntimeCapabilitiesCard";
import RuntimePullRequestCard from "./RuntimePullRequestCard";
import RuntimePortableBundle from "./RuntimePortableBundle";
import RuntimeBackendList from "./RuntimeBackendList";
import PullRequestProvenance from "./RuntimePullRequestProvenance";
import RuntimeRemovalNotice from "./RuntimeRemovalNotice";
import { runtimeReferences } from "./runtimeReferences";
import { useDeepVerification } from "./useDeepVerification";
import ProviderEnvironments from './ProviderEnvironments';
import AdapterCatalogList from './AdapterCatalogList';
import EntrypointRegistration from './EntrypointRegistration';
import { providerCatalog, providerRuntimes } from '../../shared/api/index';
import { isExternalProvider, providerDisplayName, type ProviderDescription, type RuntimeInstance } from '../../shared/api/providers';
import { providerOf } from '../../shared/api/providers';
import DeepVerificationControls from './DeepVerificationControls';
import { useEffect, useId, useRef, useState } from 'react';
import type { ProviderId } from '../../shared/api/providers';
import RuntimeSelectionLabel from '../../shared/ui/RuntimeSelectionLabel';
import { modelSettingsCopy } from '../model-settings/modelSettingsCopy';
import { notifyRuntimeInventoryChanged, useRuntimeInventoryRevision } from '../../shared/runtime/runtimeInventoryEvents';

export type { BackendRow } from "./runtimesHelpers";

type View = { kind: 'inventory' } | { kind: 'add' } | { kind: 'adapter'; id: ProviderId };
type FocusTarget = 'context' | 'wizard' | 'add' | { adapter: ProviderId };

function BackIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4 6 10l6 6" /></svg>;
}

/** Opens on a neutral inventory of every adapter. Browsing an adapter does
 * not change execution selection; only an explicit request (a model's
 * "manage runtimes" action) opens one adapter directly, and ordinary
 * navigation back to this page returns to the inventory. */
export default function RuntimesPanel({ store, active = true, onOpenProfiles, engineRequest }: { store: AppStore; active?: boolean; onOpenProfiles?: () => void; engineRequest?: { provider: ProviderId; revision: number } }) {
  const { t, locale } = useI18n();
  const copy = adapterCatalogCopy[locale];
  const addHeadingId = useId();
  const [view, setView] = useState<View>(() => engineRequest ? { kind: 'adapter', id: engineRequest.provider } : { kind: 'inventory' });
  const handledRequest = useRef(engineRequest?.revision);
  const wasActive = useRef(active);
  const pendingInventoryReturn = useRef(false);
  const focusTarget = useRef<FocusTarget | null>(null);
  const contextHeading = useRef<HTMLHeadingElement>(null);
  const wizardHeading = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const inventoryRef = useRef<HTMLDivElement>(null);
  const [providerRevision, setProviderRevision] = useState(0);
  const [providerBusy, setProviderBusy] = useState(false);
  const [adapterBusy, setAdapterBusy] = useState(false);
  const [wizardOpened, setWizardOpened] = useState(false);
  const [wizardKey, setWizardKey] = useState(0);
  const [registered, setRegistered] = useState<{ engine: ProviderId; name: string; runtime: string } | null>(null);
  const wizardFinished = useRef(false);
  const selected = view.kind === 'adapter' ? view.id : null;
  const llama = selected === 'llama.cpp';
  const rt = useRuntimesController(store, active, llama);
  const { visibleRows, hiddenCount } = computeVisibleRows(rt.rows, rt.device, rt.showAll);
  const activePrProgress = rt.activePrBackend ? rt.rows.find((row) => row.backend === rt.activePrBackend)?.progress : null;
  const deviceSummary = deviceSummaryOf(locale, rt.device);
  const deepVerify = useDeepVerification(store, locale);
  const busy = rt.runtimeBusy || rt.probeBusy || providerBusy || adapterBusy || deepVerify.busy;
  const inventoryRevision = useRuntimeInventoryRevision();
  const [inventory, setInventory] = useState<{ catalog: ProviderDescription[]; runtimes: RuntimeInstance[]; loaded: boolean; error: string }>({ catalog: [], runtimes: [], loaded: false, error: '' });
  useEffect(() => {
    if (!active) return;
    let current = true;
    // After a registration the catalog must not reuse a request started before it.
    void Promise.all([providerCatalog(providerRevision > 0), providerRuntimes()]).then(([catalog, runtimes]) => {
      if (current) setInventory({ catalog, runtimes, loaded: true, error: '' });
    }).catch(cause => { if (current) setInventory(previous => ({ ...previous, loaded: true, error: cause instanceof Error ? cause.message : String(cause) })); });
    return () => { current = false; };
  }, [active, providerRevision, inventoryRevision]);

  // An explicit engine request opens that adapter; returning to the page by
  // ordinary navigation shows the inventory again. Neither interrupts an
  // operation in progress: a pending request is applied once it finishes.
  useEffect(() => {
    const returned = active && !wasActive.current;
    wasActive.current = active;
    if (returned) pendingInventoryReturn.current = true;
    if (!active || busy) return;
    if (engineRequest && engineRequest.revision !== handledRequest.current) {
      handledRequest.current = engineRequest.revision;
      pendingInventoryReturn.current = false;
      setView({ kind: 'adapter', id: engineRequest.provider });
    } else if (pendingInventoryReturn.current) {
      pendingInventoryReturn.current = false;
      setView(current => (current.kind === 'adapter' ? { kind: 'inventory' } : current));
    }
  }, [active, busy, engineRequest]);

  useEffect(() => {
    const target = focusTarget.current;
    focusTarget.current = null;
    if (!target) return;
    if (target === 'context') contextHeading.current?.focus();
    else if (target === 'wizard') wizardHeading.current?.focus();
    else if (target === 'add') addButton.current?.focus();
    else [...(inventoryRef.current?.querySelectorAll<HTMLButtonElement>('[data-adapter]') ?? [])].find(button => button.dataset.adapter === target.adapter)?.focus();
  }, [view]);

  const openAdapter = (id: ProviderId) => { if (busy) return; focusTarget.current = 'context'; setView({ kind: 'adapter', id }); };
  const openAdd = () => {
    if (wizardFinished.current) { wizardFinished.current = false; setRegistered(null); setWizardKey(value => value + 1); }
    setWizardOpened(true); focusTarget.current = 'wizard'; setView({ kind: 'add' });
  };
  const backToInventory = () => {
    if (busy) return;
    focusTarget.current = view.kind === 'adapter' ? { adapter: view.id } : 'add';
    setView({ kind: 'inventory' });
  };
  // The catalog names an engine after one of its builds, so the announcement
  // keeps the identity the registration itself returned.
  const onRegistered = (engine: ProviderId, { runtime_id, display_name }: { runtime_id: string; display_name: string }) => {
    wizardFinished.current = true; setRegistered({ engine, name: display_name, runtime: runtime_id }); setProviderRevision(value => value + 1);
  };
  const description = selected ? inventory.catalog.find(item => item.id === selected) : undefined;
  const empty = inventory.loaded && !inventory.error && inventory.runtimes.length === 0;
  const profilesLink = onOpenProfiles && <p className="runtime-profiles-link">{modelSettingsCopy[locale].title} → {modelSettingsCopy[locale].profiles} <button type="button" onClick={onOpenProfiles} className="app-link-button">{t("ui.executionProfiles")}</button></p>;
  const backButton = (disabled: boolean) => <button type="button" className="app-button app-button--ghost app-button--sm adapter-back" disabled={disabled} onClick={backToInventory}><BackIcon />{copy.back}</button>;

  return (
    <div className="app-page-scroll runtimes-page relative flex h-full min-h-0 flex-col">
      <header className="app-page-header">
        <div>
          <h2 className="app-page-title">{executionText[locale].manageRuntime}</h2>
          <p className="app-page-description">{t("ui.runtimesIntro")}</p>
        </div>
        <div className="app-page-actions">
          {llama && rt.bundleBusy
            ? <LocalTaskCancelButton taskId="runtime-operation" pending={rt.cancelBusy} onClick={() => void rt.cancelInstall()} disabled={rt.cancelBusy} className="app-button app-button--danger shrink-0"><StableLabel value={rt.cancelBusy ? t("ui.cancelling") : t("ui.cancelRuntimeBundle")} labels={[t("ui.cancelling"), t("ui.cancelRuntimeBundle")]} /></LocalTaskCancelButton>
            : <button type="button" onClick={() => { if (llama) void rt.refresh(true); else setProviderRevision(value => value + 1); }} disabled={rt.runtimeBusy || providerBusy || adapterBusy} className="app-button app-button--secondary shrink-0 runtime-refresh">
                <svg aria-hidden="true" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M16 10a6 6 0 1 1-1.76-4.24M16 4v3.5h-3.5" /></svg>
                {llama ? (rt.loadError ? t("panel.retry") : t("ui.refreshRemote")) : copy.refresh}
              </button>}
        </div>
      </header>

      {registered && view.kind !== 'adapter' && (
        <FeedbackBanner tone="success" title={fillAdapterCopy(copy.registeredTitle, { engine: `${registered.name} · ${registered.runtime}` })} className="mb-4" onDismiss={() => setRegistered(null)}>
          <p>{copy.registeredNext}</p>
          <span className="app-page-actions adapter-next">
            <button type="button" className="app-button app-button--primary app-button--sm" onClick={() => { setRegistered(null); openAdapter(registered.engine); }}>{fillAdapterCopy(copy.openEngine, { engine: registered.name })}</button>
            {onOpenProfiles && <button type="button" className="app-button app-button--secondary app-button--sm" onClick={onOpenProfiles}>{copy.openProfiles}</button>}
            <button type="button" className="app-button app-button--secondary app-button--sm" onClick={openAdd}>{copy.addAnother}</button>
          </span>
        </FeedbackBanner>
      )}

      {/* The inventory stays mounted so its search survives opening an adapter. */}
      <div ref={inventoryRef} className="runtimes-main" hidden={view.kind !== 'inventory'}>
        {inventory.error && <FeedbackBanner tone="error" className="mb-4" action={{ label: t("panel.retry"), onClick: () => setProviderRevision(value => value + 1) }}>{`${copy.loadError} ${normalizeDisplayText(inventory.error)}`}</FeedbackBanner>}
        <section className={`app-card mb-4 adapter-add${empty ? ' adapter-add--empty' : ''}`} aria-labelledby={addHeadingId}>
          <h3 id={addHeadingId} className="app-section-title">{copy.addTitle}</h3>
          <p className="app-section-hint">{empty ? copy.addEmptyHint : copy.addHint}</p>
          <ol className="adapter-journey">
            {copy.journeySteps.map(step => <li key={step}>{step}</li>)}
          </ol>
          <div className="app-page-actions">
            <button ref={addButton} type="button" className="app-button app-button--primary" onClick={openAdd}>{copy.add}</button>
          </div>
        </section>
        <AdapterCatalogList catalog={inventory.catalog} runtimes={inventory.runtimes} loading={!inventory.loaded} disabled={busy} onOpen={openAdapter} />
        {profilesLink}
      </div>

      {wizardOpened && (
        <div className="runtimes-main" hidden={view.kind !== 'add'}>
          <div className="adapter-context">{backButton(adapterBusy)}</div>
          <EntrypointRegistration key={wizardKey} titleRef={wizardHeading} cfg={store.cfg ?? undefined} locked={rt.serverRunning || rt.runtimeBusy || providerBusy}
            onRegistered={(engine, identity) => { notifyRuntimeInventoryChanged(); onRegistered(engine, identity); }} onBusyChange={setAdapterBusy} />
          <details className="runtime-advanced">
            <summary>{copy.advancedManifest}</summary>
            <div className="runtime-advanced__body">
              <ExternalRuntimeRegistration locked={rt.serverRunning || rt.runtimeBusy || providerBusy} onRegistered={onRegistered} onBusyChange={setAdapterBusy} />
            </div>
          </details>
        </div>
      )}

      {selected && (
        <>
          <div className="adapter-context">
            {backButton(busy)}
            <h3 ref={contextHeading} tabIndex={-1} className="app-section-title">{description?.engine ?? providerDisplayName(selected)}</h3>
            <p className="app-section-hint">{description?.kind === 'external-process' ? copy.customContext : copy.builtinContext}{description ? ` · ${description.managed_variant ?? description.server}` : ''}</p>
          </div>
          {inventory.loaded && !inventory.error && !description && isExternalProvider(selected)
            ? <FeedbackBanner tone="warning">{copy.missing}</FeedbackBanner>
            : <div className="runtimes-layout">
          <aside className="runtimes-aside">
            <RuntimeDeviceCard t={t} device={rt.device} deviceSummary={deviceSummary} />
            {llama && <div className="runtime-show-all">
              <Switch id="runtime-show-all" checked={rt.showAll} onChange={rt.toggleShowAll} aria-describedby={!rt.showAll && hiddenCount > 0 ? "runtime-hidden-count" : undefined} />
              <label htmlFor="runtime-show-all">{t("ui.showAllBackends")}</label>
              {!rt.showAll && hiddenCount > 0 && <span id="runtime-hidden-count" className="runtime-hidden-count">{t("ui.hiddenBackends", { count: hiddenCount })}</span>}
            </div>}
            {profilesLink}
          </aside>

          <div className="runtimes-main">
          {!llama && <ProviderEnvironments active={active} provider={selected} revision={providerRevision} resourcesInUse={rt.serverRunning || adapterBusy} onBusyChange={setProviderBusy} />}
          {selected === providerOf(store.cfg ?? {}) && <section className="app-card mb-4">
            <h2 className="app-section-title">{t('ui.deepVerify')}</h2>
            <p><RuntimeSelectionLabel config={store.cfg} /></p>
            <DeepVerificationControls t={t} state={deepVerify} provider={selected} runtimeBusy={rt.runtimeBusy || providerBusy || adapterBusy} serverRunning={rt.serverRunning} />
          </section>}
          {llama && <>
          <PanelFeedback>
            {rt.failure && <FeedbackBanner tone="error" title={t("error.wrong")} onDismiss={() => rt.setFailure(null)}>{rt.failure}</FeedbackBanner>}
            {rt.loadError && <FeedbackBanner tone="error">{`${t("ui.runtimeLookupFailed")}: ${normalizeDisplayText(rt.loadError)}`}</FeedbackBanner>}
          </PanelFeedback>
          {rt.flash && <FeedbackBanner tone="info" className="runtime-flash">{normalizeDisplayText(rt.flash)}</FeedbackBanner>}

          <RuntimeBackendList
            t={t}
            locale={locale}
            visibleRows={visibleRows}
            device={rt.device}
            serverRunning={rt.serverRunning}
            prBusy={rt.prBusy}
            bundleBusy={rt.bundleBusy}
            cancelBusy={rt.cancelBusy}
            probeBusy={rt.probeBusy}
            probeTarget={rt.probeTarget}
            onBlockedAction={(msg) => rt.setFailure(msg)}
            onCancelInstall={() => void rt.cancelInstall()}
            onInstall={(backend) => void rt.install(backend)}
            onProbe={(backend, build) => void rt.probe(backend, build)}
            onUninstall={(backend, build) => void rt.uninstall(backend, build)}
          />

          <details className="runtime-advanced">
            <summary>{t("settings.advanced")}</summary>
            <div className="runtime-advanced__body">
              <RuntimeCapabilitiesCard
                t={t}
                capabilities={rt.capabilities}
                probeBusy={rt.probeBusy}
                runtimeBusy={rt.runtimeBusy}
                serverRunning={rt.serverRunning}
                probeTarget={rt.probeTarget}
                onProbe={() => { if (rt.probeTarget) void rt.probe(rt.probeTarget.backend, rt.probeTarget.build); }}
              />
              <RuntimePullRequestCard
                t={t}
                prBackend={rt.prBackend}
                setPrBackend={rt.setPrBackend}
                prBackendTouched={rt.prBackendTouched}
                prSource={rt.prSource}
                setPrSource={rt.setPrSource}
                prBusy={rt.prBusy}
                bundleBusy={rt.bundleBusy}
                prReviewBusy={rt.prReviewBusy}
                serverRunning={rt.serverRunning}
                rows={rt.rows}
                activePrProgress={activePrProgress}
                onReview={() => void rt.reviewPullRequest()}
              />
              <RuntimePortableBundle
                t={t}
                rows={rt.rows}
                bundleBusy={rt.bundleBusy}
                bundleProgress={rt.bundleProgress}
                runtimeBusy={rt.runtimeBusy}
                serverRunning={rt.serverRunning}
                onImport={() => void rt.importRuntime()}
                onExport={(backend, build) => void rt.exportRuntime(backend, build)}
              />
            </div>
          </details>
          </>}
          </div>
          </div>}
        </>
      )}
      <ConfirmDialog
        open={rt.prPreview !== null}
        title={t("ui.prConfirmTitle")}
        description={rt.prPreview ? <PullRequestProvenance t={t} preview={rt.prPreview.preview} backend={rt.prPreview.backend} /> : ""}
        confirmLabel={t("ui.prConfirmAction")}
        tone="primary"
        busy={rt.prBusy}
        onConfirm={() => void rt.installPullRequest()}
        onCancel={() => { if (!rt.prBusy) rt.setPrPreview(null); }}
      />
      <ConfirmDialog
        open={rt.pendingUninstall !== null}
        title={t("ui.removeRuntimeTitle")}
        description={rt.pendingUninstall
          ? <RuntimeRemovalNotice t={t} backend={rt.pendingUninstall.backend} build={rt.pendingUninstall.build}
              references={runtimeReferences(store.cfg, rt.pendingUninstall.backend, rt.pendingUninstall.build)} />
          : ""}
        confirmLabel={t("ui.removeRuntime")}
        busy={rt.uninstallBusy}
        onConfirm={() => void rt.confirmUninstall()}
        onCancel={() => { if (!rt.uninstallBusy) rt.setPendingUninstall(null); }}
      />
    </div>
  );
}
