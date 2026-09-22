import StableLabel from "../shared/ui/StableLabel";
import { version } from '../../package.json';
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { applyTheme, persistThemeMode, subscribeToSystemTheme } from "../shared/config/theme";
import "../styles/app.css";


import * as api from "../shared/api/index";
import { verificationOverrideKey } from "../shared/lib/serverLifecycle";
import { useAppStore } from "../shared/state/store";
import EmptyState from "../shared/ui/EmptyState";
import FeedbackBanner from "../shared/ui/FeedbackBanner";
import TaskStrip from "../shared/ui/TaskStrip";
import { TaskCancellationProvider } from "../shared/ui/TaskCancellation";
import { useTasks, type AppTask } from "../shared/state/taskRegistry";
import { useModelDownloadTask } from "../shared/state/modelDownloadTask";
import { PanelBoundary } from "../shared/ui/ErrorBoundary";
import { AioMark } from "../shared/ui/AppIcons";
import { navigationGroups, navigationText, type ViewId } from "./navigation";
import InitialSurface from "../shared/ui/InitialSurface";
import PanelFeedback, { ActivePanelContext, PanelFeedbackProvider, PanelFeedbackOutlet, PanelFeedbackIndicator, PanelFeedbackActivity } from "../shared/ui/PanelFeedback";

import { useI18n } from "../shared/i18n/i18n";
import { useRuntimeVersionLabel } from "../shared/runtime/installedRuntimes";
import { loadPreferences, resetPreferences, savePreferences, type AppPreferences } from "../shared/config/preferences";
import { modelDisplayName, normalizeDisplayPath, normalizeDisplayText } from "../shared/lib/displayPaths";
import { DraftGuardProvider } from '../shared/state/draftGuard';
import { useExecutionStore } from '../features/models/useExecutionStore';
import { executionText } from '../shared/i18n/executionI18n';
import type { ExecutionSection } from '../features/models/ModelWorkspace';
import { ModelSettingsProvider, useModelSettings, MANAGE_MODEL_RUNTIMES } from '../features/model-settings/ModelSettingsProvider';
import { modelActions } from '../shared/i18n/modelActions';
import AppUpdateNotice from '../features/updates/AppUpdateNotice';

const ChatPanel = lazy(() => import("../features/chat/Chat"));
const DiscoverPanel = lazy(() => import("../features/discover/Discover"));
const DeveloperPanel = lazy(() => import("../features/developer/Developer"));
const McpPanel = lazy(() => import("../features/mcp/Mcp"));
const ModelWorkspace = lazy(() => import("../features/models/ModelWorkspace"));
const SessionsPanel = lazy(() => import("../features/sessions/Sessions"));

const BenchPanel = lazy(() => import("../features/bench/Bench"));
const RuntimesPanel = lazy(() => import("../features/runtimes/Runtimes"));
const ProjectsPanel = lazy(() => import("../features/projects/Projects"));
const SettingsPanel = lazy(() => import("../features/settings/Settings"));

function PanelLoading() {
  const { t } = useI18n();
  return <div className="app-page-scroll panel-loading" role="status" aria-label={t("extra.loading")}><span className="panel-spinner" aria-hidden="true" /></div>;
}

function LazyPanel({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PanelLoading />}><InitialSurface>{children}</InitialSurface></Suspense>;
}

/** A task blocks a tab change only while it is active and registered as
 * unable to survive navigation (`interruptible: false`); see taskRegistry.ts. */
export function findTaskBlockingTabLeave(tasks: AppTask[]): AppTask | undefined {
  return tasks.find((task) => (task.state === "running" || task.state === "cancelling") && !task.interruptible);
}

function shortModel(path: string | undefined, emptyLabel: string): string {
  if (!path) return emptyLabel;
  return modelDisplayName(path);
}

export default function App() {
  return <DraftGuardProvider><AppContent /></DraftGuardProvider>;
}

function AppContent() {
  const [preferences, setPreferences] = useState<AppPreferences>(() => loadPreferences());
  const baseStore = useAppStore({ pollIntervalMs: preferences.server.pollIntervalMs, autoStart: preferences.server.autoStart });
  const { store, selectModel } = useExecutionStore(baseStore);
  return <ModelSettingsProvider store={store}><AppShell preferences={preferences} setPreferences={setPreferences} store={store} selectModel={selectModel} /></ModelSettingsProvider>;
}

function AppShell({ preferences, setPreferences, store, selectModel }: { preferences: AppPreferences; setPreferences: React.Dispatch<React.SetStateAction<AppPreferences>>; store: ReturnType<typeof useAppStore>; selectModel: (path: string) => Promise<void> }) {
  const modelSettings = useModelSettings()!;
  const { t, locale, setLocale } = useI18n();
  const modelCopy = modelActions(locale);
  const executionCopy = executionText[locale];
  const [executionSection, setExecutionSection] = useState<{ id: ExecutionSection; revision: number }>({ id: 'setup', revision: 0 });
  const [view, setView] = useState<ViewId>("chat");
  const [visited, setVisited] = useState<Set<ViewId>>(() => new Set(["chat"]));
  const [developerSection, setDeveloperSection] = useState<"api" | "gateways" | "diagnostics">("api");
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsUpdateRequest, setSettingsUpdateRequest] = useState(0);
  const menuRef = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const tasks = useTasks();
  // Held here, not in Discover, so a download keeps reporting after the user
  // navigates away from the page that started it.
  useModelDownloadTask();
  const copy = navigationText[locale];
  const entries = navigationGroups.flatMap(group => group.items);
  useEffect(() => {
    const dialog = menuRef.current;
    if (menuOpen && dialog && !dialog.open) dialog.showModal();
    if (!menuOpen && dialog?.open) { dialog.close(); menuButton.current?.focus(); }
  }, [menuOpen]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 960px)");
    const close = () => { if (media.matches) setMenuOpen(false); };
    media.addEventListener?.("change", close);
    return () => media.removeEventListener?.("change", close);
  }, []);
  const serverBusy = store.busy || store.status.state === "starting" || store.status.state === "stopping";
  // A launch the correctness gate refused names an override key in its message,
  // and that message was the only place it existed: without somewhere to accept
  // it, being told "or start it anyway with key ..." led nowhere.
  const [overrideAccepted, setOverrideAccepted] = useState(false);
  const serverState = store.status.state;
  const stopServer = store.stop;
  const hasError = store.bootError || store.actionError || store.statusPollError || store.status.error;
  const errorText = store.bootError ?? store.actionError ?? store.statusPollError ?? store.status.error ?? "";
  const overrideKey = verificationOverrideKey(errorText);
  const acceptOverride = () => {
    void api.allowVerificationOverride(overrideKey!)
      .then(() => { setOverrideAccepted(true); store.clearErrors(); })
      .catch(() => undefined);
  };

  useEffect(() => {
    applyTheme(preferences.theme);
    persistThemeMode(preferences.theme);
    document.documentElement.lang = locale;
    document.documentElement.dataset.density = preferences.appearance.density;
    document.documentElement.classList.toggle("app-reduce-motion", preferences.appearance.reduceMotion);
    document.documentElement.classList.toggle("app-developer-mode", preferences.advanced.developerMode);
    if (preferences.theme !== "system") return undefined;
    return subscribeToSystemTheme(() => applyTheme("system"));
  }, [locale, preferences.theme, preferences.appearance.density, preferences.appearance.reduceMotion, preferences.advanced.developerMode]);

  useEffect(() => {
    if (!preferences.server.autoStopOnExit) return undefined;
    const stopOnExit = () => {
      if (serverState === "running") void stopServer().catch(() => undefined);
    };
    window.addEventListener("beforeunload", stopOnExit);
    return () => window.removeEventListener("beforeunload", stopOnExit);
  }, [preferences.server.autoStopOnExit, serverState, stopServer]);

  useEffect(() => {
    if (preferences.locale !== locale) {
      setPreferences((current) => {
        const next = { ...current, locale };
        savePreferences(next);
        return next;
      });
    }
  }, [locale, preferences.locale, setPreferences]);

  const updatePreferences = (patch: Partial<AppPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      savePreferences(next);
      return next;
    });
    if (patch.locale) setLocale(patch.locale);
  };
  const resetAllPreferences = () => {
    const next = resetPreferences();
    setPreferences(next);
    setLocale(next.locale);
  };

  const navigate = (next: ViewId): boolean => {
    if (next === 'tuning' || next === 'profiles' || next === 'lora') {
      modelSettings.open({ target: { kind: 'default' }, section: next }); setMenuOpen(false); return true;
    }
    const executionTarget = next === 'models' ? 'setup' : null;
    if (executionTarget) next = 'models';
    const blocking = findTaskBlockingTabLeave(tasks);
    if (blocking && next !== view && !window.confirm(t("ui.taskLeaveConfirm", { task: normalizeDisplayText(blocking.label) }))) return false;
    if (executionTarget) setExecutionSection(current => ({ id: executionTarget, revision: current.revision + 1 }));
    window.dispatchEvent(new Event("aiolm:navigate"));
    setVisited(current => current.has(next) ? current : new Set([...current, next]));
    if (next === "api" || next === "gateways" || next === "diagnostics") setDeveloperSection(next);
    setView(next);
    setMenuOpen(false);
    return true;
  };
  const navigateRef = useRef(navigate); navigateRef.current = navigate;
  useEffect(() => {
    const manage = () => { navigateRef.current('runtimes'); };
    window.addEventListener(MANAGE_MODEL_RUNTIMES, manage);
    return () => window.removeEventListener(MANAGE_MODEL_RUNTIMES, manage);
  }, []);
  const openModels = () => { modelSettings.open({ target: { kind: 'default' }, section: 'model' }); };
  const openDiagnostics = () => { navigate("diagnostics"); };
  const openTuning = () => { navigate("tuning"); };
  const openProfiles = () => { navigate("profiles"); };
  const stopDefaultSession = async () => {
    try {
      if (serverState === "running" || serverState === "starting") await store.stop();
    } catch {
      // The store publishes an actionable error banner; keep the shell mounted.
    }
  };

  const runtimeLabel = useRuntimeVersionLabel(store.status.execution?.active_backend ?? "", store.status.execution?.active_build ?? "");
  const labelFor = (id: ViewId) => id === 'models' ? executionCopy.title : id === 'runtimes' ? executionCopy.manageRuntime : t(entries.find(item => item.id === id)!.label);
  const title = labelFor(view);
  const showDeveloper = view === "api" || view === "gateways" || view === "diagnostics";
  const liveModel = ['running', 'starting', 'stopping'].includes(serverState) ? store.status.model : undefined;
  const backendLabel = store.status.execution?.active_backend
    ? `${store.status.execution.active_backend}${store.status.execution.active_build ? ` · ${runtimeLabel}` : ""}`
    : t("load.pathRuntime");


  const brand = <div className="aiolm-brand"><AioMark /><div><strong>AioLM</strong><span>All-In-One LM</span></div></div>;
  const navigation = <nav aria-label={t("app.primary")} className="aiolm-navigation">
    {navigationGroups.map(group => <section key={group.id} className="aiolm-nav-group">
      <h2>{copy[group.id]}</h2>
      {group.items.map(item => <button key={item.id} type="button" aria-current={view === item.id ? "page" : undefined} className="aiolm-nav-link" onClick={() => navigate(item.id)}>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={item.icon} /></svg><span>{labelFor(item.id)}</span>
      </button>)}
    </section>)}
  </nav>;
  const panel = (id: ViewId, children: React.ReactNode) => <section key={id} hidden={view !== id} aria-label={labelFor(id)} className="app-panel-host" data-view={id}>
    <ActivePanelContext.Provider value={view === id}>{visited.has(id) && <PanelBoundary label={t(entries.find(item => item.id === id)!.label)}><LazyPanel>{children}</LazyPanel></PanelBoundary>}</ActivePanelContext.Provider>
  </section>;
  return <TaskCancellationProvider><PanelFeedbackProvider><div className="app-shell" onKeyDown={event => { if (event.key !== "Escape" || event.defaultPrevented || !(event.target instanceof Element)) return; const details = event.target.closest<HTMLDetailsElement>("details[open]"); if (details) { event.preventDefault(); details.open = false; details.querySelector("summary")?.focus(); } }}>
    <a href="#main-content" className="app-skip-link">{t("app.skip")}</a>
    <aside className="aiolm-sidebar">{brand}{navigation}<div className="aiolm-sidebar-footer">{copy.local}<span>v{version}</span></div></aside>
    <dialog ref={menuRef} className="aiolm-drawer" aria-label={t("app.primary")} onCancel={event => { event.preventDefault(); setMenuOpen(false); }} onClick={event => { if (event.target === event.currentTarget) setMenuOpen(false); }}>
      <div className="aiolm-drawer-sheet"><div className="aiolm-drawer-heading">{brand}<button type="button" className="app-icon-button" aria-label={copy.closeMenu} onClick={() => setMenuOpen(false)}>×</button></div>{navigation}</div>
    </dialog>
    <div className="app-main-column">
      <header className="aiolm-header">
        <div className="aiolm-heading"><button ref={menuButton} type="button" className="app-icon-button aiolm-menu-trigger" aria-label={copy.openMenu} aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button><h1>{title}</h1></div>
        <div className="aiolm-runtime-context" aria-label={modelCopy.defaultScope}><button type="button" className="aiolm-context-model" aria-label={liveModel ? `${modelCopy.choose}: ${shortModel(liveModel, '')}` : modelCopy.choose} title={liveModel ? normalizeDisplayPath(liveModel) : modelCopy.choose} onClick={openModels}>{shortModel(liveModel, modelCopy.choose)}</button><button type="button" className="aiolm-context-runtime" aria-label={modelCopy.settings} onClick={() => modelSettings.open({ target: { kind: 'default' }, section: 'runtime' })}>{liveModel ? `${backendLabel} · ` : ''}⚙</button></div>
        <div className="aiolm-server"><span className={"aiolm-status is-" + serverState} role="status"><i aria-hidden="true" />{serverState === "running" ? t("status.ready") : serverState === "stopped" ? t("status.stopped") : serverState}</span>{(serverState === 'running' || serverState === 'starting' || serverBusy) && <button type="button" className="app-button app-button--secondary" disabled={!store.cfg || (serverBusy && serverState !== "starting")} onClick={() => void stopDefaultSession()}><StableLabel value={serverState === "running" || serverState === "starting" ? t("action.stop") : t("status.working")} labels={[t("action.stop"), t("status.working")]} /></button>}</div>
      </header>
      <div className="app-main-area">
        <AppUpdateNotice onOpenSettings={() => { if (navigate("settings")) setSettingsUpdateRequest(current => current + 1); }} />
        <PanelFeedbackActivity hasActivity={tasks.length > 0 || !!hasError || store.bootState === 'native-unavailable'}>
          <summary><span>{t("ui.taskStripTitle")}</span><span className="app-activity-count" aria-live="polite">{tasks.filter(task => task.state === "running" || task.state === "cancelling").length}</span><PanelFeedbackIndicator message={t("error.attention")} globalError={!!hasError} /></summary>
          <div className="app-activity-content">
        <PanelFeedback>
          {store.bootState === "native-unavailable" && view !== "chat" && <FeedbackBanner tone="warning" title={t("native.unavailable")} action={view === "diagnostics" ? undefined : { label: t("native.openDiagnostics"), onClick: openDiagnostics }}>{t("native.message")}</FeedbackBanner>}
          {hasError && store.bootState !== "native-unavailable" && <FeedbackBanner tone="error" title={t("error.attention")} onDismiss={store.clearErrors}
            action={overrideKey ? { label: t("ui.verificationOverride"), onClick: acceptOverride } : view === "diagnostics" ? undefined : { label: t("native.openDiagnostics"), onClick: openDiagnostics }}>{normalizeDisplayText(errorText)}</FeedbackBanner>}
          {overrideAccepted && !hasError && <FeedbackBanner tone="success" onDismiss={() => setOverrideAccepted(false)}>{t("ui.verificationOverrideDone")}</FeedbackBanner>}
        </PanelFeedback>
        <TaskStrip />
        <PanelFeedbackOutlet />
          </div>
        </PanelFeedbackActivity>
        <main id="main-content" className="app-main" tabIndex={-1}>
          {panel("chat", store.bootState === "native-unavailable" ? <div className="app-page-scroll app-runtime-empty"><EmptyState title={t("native.unavailable")} description={t("native.message")} action={{ label: t("native.openDiagnostics"), onClick: openDiagnostics }} /></div> : <ChatPanel store={store} preferences={preferences} active={view === "chat"} onOpenModels={openModels} onOpenDiagnostics={openDiagnostics} />)}
          {panel("projects", store.cfg ? <ProjectsPanel store={store} onOpenTuning={openTuning} /> : <PanelLoading />)}
          {panel("models", <ModelWorkspace store={store} active={view === 'models'} section={executionSection} onNavigate={navigate} onSelectModel={selectModel} />)}
          {panel("discover", <DiscoverPanel store={store} active={view === "discover"} onSelectModel={selectModel} onOpenModels={openModels} />)}
          {panel("sessions", <SessionsPanel store={store} active={view === "sessions"} />)}
          {panel("runtimes", <>{modelSettings.suspended && <div className="runtime-return"><button type="button" className="app-button app-button--secondary app-button--sm" onClick={modelSettings.resume}>{modelCopy.resume}</button></div>}<RuntimesPanel store={store} active={view === "runtimes"} onOpenProfiles={openProfiles} /></>)}
          {panel("benchmark", <BenchPanel store={store} active={view === "benchmark"} />)}
          <section hidden={!showDeveloper} aria-label={t(entries.find(item => item.id === developerSection)!.label)} className="app-panel-host" data-view={developerSection}>
            <ActivePanelContext.Provider value={showDeveloper}>{(visited.has("api") || visited.has("gateways") || visited.has("diagnostics")) && <PanelBoundary label={t("section.developer")}><LazyPanel><DeveloperPanel store={store} section={developerSection} /></LazyPanel></PanelBoundary>}</ActivePanelContext.Provider>
          </section>
          {panel("mcp", <McpPanel store={store} />)}
          {panel("settings", <SettingsPanel preferences={preferences} update={updatePreferences} reset={resetAllPreferences} store={store} updateRequest={settingsUpdateRequest} />)}
        </main>
      </div>
    </div>
  </div></PanelFeedbackProvider></TaskCancellationProvider>;
}
