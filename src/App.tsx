import StableLabel from "./components/StableLabel";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { applyTheme, persistThemeMode, subscribeToSystemTheme } from "./theme";
import "./App.css";


import { useAppStore } from "./store";
import EmptyState from "./components/EmptyState";
import FeedbackBanner from "./components/FeedbackBanner";
import TaskStrip from "./components/TaskStrip";
import { useTasks, type AppTask } from "./taskRegistry";
import { PanelBoundary } from "./components/ErrorBoundary";
import { AioMark } from "./components/AppIcons";
import { navigationGroups, navigationText, type ViewId } from "./navigation";
import InitialSurface from "./components/InitialSurface";
import { ActivePanelContext, PanelFeedbackProvider, PanelFeedbackOutlet, PanelFeedbackIndicator } from "./components/PanelFeedback";

import { useI18n } from "./i18n";
import { buildNumber } from "./runtimeUtils";
import { loadPreferences, resetPreferences, savePreferences, type AppPreferences } from "./preferences";
import { normalizeDisplayPath, normalizeDisplayText } from "./lifecycleUtils";

const ChatPanel = lazy(() => import("./panels/Chat"));
const DiscoverPanel = lazy(() => import("./panels/Discover"));
const DeveloperPanel = lazy(() => import("./panels/Developer"));
const McpPanel = lazy(() => import("./panels/Mcp"));
const ModelsPanel = lazy(() => import("./panels/Models"));
const SessionsPanel = lazy(() => import("./panels/Sessions"));

const BenchPanel = lazy(() => import("./panels/Bench"));
const RuntimesPanel = lazy(() => import("./panels/Runtimes"));
const ProjectsPanel = lazy(() => import("./panels/Projects"));
const TuningPanel = lazy(() => import("./panels/Tuning"));
const SettingsPanel = lazy(() => import("./panels/Settings"));
const ProfilesPanel = lazy(() => import("./panels/ExecutionProfiles"));

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
  const displayPath = normalizeDisplayPath(path);
  return displayPath.split(/[\\/]/).pop() || displayPath;
}

export default function App() {
  const [preferences, setPreferences] = useState<AppPreferences>(() => loadPreferences());
  const store = useAppStore({ pollIntervalMs: preferences.server.pollIntervalMs, autoStart: preferences.server.autoStart });
  const { t, locale, setLocale } = useI18n();
  const [view, setView] = useState<ViewId>("chat");
  const [visited, setVisited] = useState<Set<ViewId>>(() => new Set(["chat"]));
  const [developerSection, setDeveloperSection] = useState<"api" | "gateways" | "diagnostics">("api");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const tasks = useTasks();
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
  const serverState = store.status.state;
  const stopServer = store.stop;
  const hasError = store.bootError || store.actionError || store.statusPollError || store.status.error;

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
  }, [locale, preferences.locale]);

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
    const blocking = findTaskBlockingTabLeave(tasks);
    if (blocking && next !== view && !window.confirm(t("ui.taskLeaveConfirm", { task: blocking.label }))) return false;
    window.dispatchEvent(new Event("aiolm:navigate"));
    setVisited(current => current.has(next) ? current : new Set([...current, next]));
    if (next === "api" || next === "gateways" || next === "diagnostics") setDeveloperSection(next);
    setView(next);
    setMenuOpen(false);
    return true;
  };
  const openModels = () => { navigate("models"); };
  const openDiagnostics = () => { navigate("diagnostics"); };
  const openTuning = () => { navigate("tuning"); };
  const openProfiles = () => { navigate("profiles"); };
  const toggleServer = async () => {
    try {
      if (serverState === "running" || serverState === "starting") await store.stop();
      else await store.start();
    } catch {
      // The store publishes an actionable error banner; keep the shell mounted.
    }
  };

  const title = t(entries.find(item => item.id === view)!.label);
  const showDeveloper = view === "api" || view === "gateways" || view === "diagnostics";
  const backendLabel = store.cfg?.active_backend
    ? `${store.cfg.active_backend}${store.cfg.active_build ? ` · ${buildNumber(store.cfg.active_build)}` : ""}`
    : t("load.pathRuntime");


  const brand = <div className="aiolm-brand"><AioMark /><div><strong>AioLM</strong><span>All-In-One LM</span></div></div>;
  const navigation = <nav aria-label={t("app.primary")} className="aiolm-navigation">
    {navigationGroups.map(group => <section key={group.id} className="aiolm-nav-group">
      <h2>{copy[group.id]}</h2>
      {group.items.map(item => <button key={item.id} type="button" aria-current={view === item.id ? "page" : undefined} className="aiolm-nav-link" onClick={() => navigate(item.id)}>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={item.icon} /></svg><span>{t(item.label)}</span>
      </button>)}
    </section>)}
  </nav>;
  const panel = (id: ViewId, children: React.ReactNode) => <section key={id} hidden={view !== id} aria-label={t(entries.find(item => item.id === id)!.label)} className="app-panel-host" data-view={id}>
    <ActivePanelContext.Provider value={view === id}>{visited.has(id) && <PanelBoundary label={t(entries.find(item => item.id === id)!.label)}><LazyPanel>{children}</LazyPanel></PanelBoundary>}</ActivePanelContext.Provider>
  </section>;
  return <PanelFeedbackProvider><div className="app-shell" onKeyDown={event => { if (event.key !== "Escape" || event.defaultPrevented || !(event.target instanceof Element)) return; const details = event.target.closest<HTMLDetailsElement>("details[open]"); if (details) { event.preventDefault(); details.open = false; details.querySelector("summary")?.focus(); } }}>
    <a href="#main-content" className="app-skip-link">{t("app.skip")}</a>
    <aside className="aiolm-sidebar">{brand}{navigation}<div className="aiolm-sidebar-footer">{copy.local}<span>v0.1.6</span></div></aside>
    <dialog ref={menuRef} className="aiolm-drawer" aria-label={t("app.primary")} onCancel={event => { event.preventDefault(); setMenuOpen(false); }} onClick={event => { if (event.target === event.currentTarget) setMenuOpen(false); }}>
      <div className="aiolm-drawer-sheet"><div className="aiolm-drawer-heading">{brand}<button type="button" className="app-icon-button" aria-label={copy.closeMenu} onClick={() => setMenuOpen(false)}>×</button></div>{navigation}</div>
    </dialog>
    <div className="app-main-column">
      <header className="aiolm-header">
        <div className="aiolm-heading"><button ref={menuButton} type="button" className="app-icon-button aiolm-menu-trigger" aria-label={copy.openMenu} aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button><h1>{title}</h1></div>
        <div className="aiolm-runtime-context"><button type="button" className="aiolm-context-model" title={store.cfg?.active_model ? normalizeDisplayPath(store.cfg.active_model) : t("load.noModel")} onClick={openModels}>{shortModel(store.cfg?.active_model, t("load.noModel"))}</button><button type="button" className="aiolm-context-runtime" onClick={() => navigate("runtimes")}>{backendLabel}</button></div>
        <div className="aiolm-server"><span className={"aiolm-status is-" + serverState} role="status"><i aria-hidden="true" />{serverState === "running" ? t("status.ready") : serverState === "stopped" ? t("status.stopped") : serverState}</span><button type="button" className={"app-button app-button--" + (serverState === "running" || serverState === "starting" ? "secondary" : "primary")} disabled={!store.cfg || (serverBusy && serverState !== "starting") || (!store.cfg.active_model && serverState !== "running" && serverState !== "starting")} onClick={() => void toggleServer()}><StableLabel value={serverState === "running" || serverState === "starting" ? t("action.stop") : serverBusy ? t("status.working") : t("action.start")} labels={[t("action.stop"), t("status.working"), t("action.start")]} /></button></div>
      </header>
      <div className="app-main-area">
        <details className="app-activity">
          <summary><span>{t("ui.taskStripTitle")}</span><span className="app-activity-count" aria-live="polite">{tasks.filter(task => task.state === "running" || task.state === "cancelling").length}</span><PanelFeedbackIndicator message={t("error.attention")} globalError={!!hasError} /></summary>
          <div className="app-activity-content">
        <div className="app-feedback-layer" aria-live="polite">
          {store.bootState === "native-unavailable" && view !== "chat" && <FeedbackBanner tone="warning" title={t("native.unavailable")} action={{ label: t("native.openDiagnostics"), onClick: openDiagnostics }}>{t("native.message")}</FeedbackBanner>}
          {hasError && store.bootState !== "native-unavailable" && <FeedbackBanner tone="error" title={t("error.attention")} onDismiss={store.clearErrors} action={{ label: t("native.openDiagnostics"), onClick: openDiagnostics }}>{normalizeDisplayText(store.bootError ?? store.actionError ?? store.statusPollError ?? store.status.error ?? "")}</FeedbackBanner>}
        </div>
        <TaskStrip />
        <PanelFeedbackOutlet />
          </div>
        </details>
        <main id="main-content" className="app-main" tabIndex={-1}>
          {panel("chat", store.bootState === "native-unavailable" ? <div className="app-page-scroll app-runtime-empty"><EmptyState title={t("native.unavailable")} description={t("native.message")} action={{ label: t("native.openDiagnostics"), onClick: openDiagnostics }} /></div> : <ChatPanel store={store} preferences={preferences} active={view === "chat"} onOpenModels={openModels} onOpenDiagnostics={openDiagnostics} />)}
          {panel("projects", store.cfg ? <ProjectsPanel store={store} onOpenTuning={openTuning} /> : <PanelLoading />)}
          {panel("models", <ModelsPanel store={store} focus="library" />)}
          {panel("discover", <DiscoverPanel store={store} active={view === "discover"} />)}
          {panel("lora", <ModelsPanel store={store} focus="lora" />)}
          {panel("sessions", <SessionsPanel store={store} active={view === "sessions"} />)}
          {panel("runtimes", <RuntimesPanel store={store} active={view === "runtimes"} onOpenProfiles={openProfiles} />)}
          {panel("tuning", <TuningPanel store={store} onNavigate={navigate} />)}
          {panel("profiles", <div className="app-page-scroll"><ProfilesPanel store={store} modelPath={store.cfg?.active_model ?? ""} onOpenTuning={openTuning} /></div>)}
          {panel("benchmark", <BenchPanel store={store} />)}
          <section hidden={!showDeveloper} aria-label={t(entries.find(item => item.id === developerSection)!.label)} className="app-panel-host" data-view={developerSection}>
            <ActivePanelContext.Provider value={showDeveloper}>{(visited.has("api") || visited.has("gateways") || visited.has("diagnostics")) && <PanelBoundary label={t("section.developer")}><LazyPanel><DeveloperPanel store={store} section={developerSection} /></LazyPanel></PanelBoundary>}</ActivePanelContext.Provider>
          </section>
          {panel("mcp", <McpPanel store={store} />)}
          {panel("settings", <SettingsPanel preferences={preferences} update={updatePreferences} reset={resetAllPreferences} />)}
        </main>
      </div>
    </div>
  </div></PanelFeedbackProvider>;
}
