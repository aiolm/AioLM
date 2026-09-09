import { lazy, Suspense, useEffect, useState } from "react";
import { applyTheme, persistThemeMode, subscribeToSystemTheme } from "./theme";
import "./App.css";


import { useAppStore } from "./store";
import EmptyState from "./components/EmptyState";
import FeedbackBanner from "./components/FeedbackBanner";
import TaskStrip from "./components/TaskStrip";
import { useTasks, type AppTask } from "./taskRegistry";
import { PanelBoundary } from "./components/ErrorBoundary";
import { BoardMark, ChatIcon, DeveloperIcon, ModelsIcon, SettingsIcon, TuningIcon } from "./components/AppIcons";
import TabNav, { type TabNavItem } from "./components/TabNav";

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

type Tab = "chat" | "models" | "tuning" | "developer" | "settings";
type ModelsSection = "library" | "sessions" | "discover" | "runtimes";
type TuningSection = "controls" | "profiles" | "benchmark" | "lora";
type ChatSection = "conversations" | "projects";
type DeveloperSection = "api" | "gateways" | "mcp" | "diagnostics";

function PanelLoading() {
  const { t } = useI18n();
  return <div className="app-page-scroll panel-loading" role="status" aria-label={t("extra.loading")}><span className="panel-spinner" aria-hidden="true" /></div>;
}

function LazyPanel({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PanelLoading />}>{children}</Suspense>;
}

/** Load on first visit, then retain drafts and active work across navigation. */
function VisitedPanel({ active, children, id, labelledBy }: { active: boolean; children: React.ReactNode; id?: string; labelledBy?: string }) {
  const [visited, setVisited] = useState(active);
  useEffect(() => { if (active) setVisited(true); }, [active]);
  return <div id={id} role={labelledBy ? "tabpanel" : undefined} aria-labelledby={labelledBy} hidden={!active} className="app-workspace-content h-full">
    {(visited || active) && children}
  </div>;
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

function PageShell<T extends string>({
  scope,
  items,
  active,
  onSelect,
  title,
  children,
}: {
  /** Namespaces the tab/panel ids so several shells can coexist in the DOM. */
  scope: string;
  items: TabNavItem<T>[];
  active: T;
  onSelect: (section: T) => void;
  title: string;
  children: React.ReactNode;
}) {
  const panelId = `${scope}-section-panel`;
  return (
    <div className="app-page-shell">
      <div className="app-side-nav">
        <div className="app-side-label" aria-hidden="true">{title}</div>
        <TabNav
          items={items}
          active={active}
          onSelect={onSelect}
          label={title}
          orientation="vertical"
          tabId={(id) => `${scope}-section-${id}`}
          panelId={() => panelId}
          className="app-side-tablist"
          tabClassName={(isActive) => `app-side-link ${isActive ? "is-active" : ""}`}
        />
      </div>
      <div
        className="app-page-content"
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${scope}-section-${active}`}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const [preferences, setPreferences] = useState<AppPreferences>(() => loadPreferences());
  const store = useAppStore({ pollIntervalMs: preferences.server.pollIntervalMs, autoStart: preferences.server.autoStart });
  const { t, locale, setLocale } = useI18n();
  const [tab, setTab] = useState<Tab>("chat");
  const [modelsSection, setModelsSection] = useState<ModelsSection>("library");
  const [tuningSection, setTuningSection] = useState<TuningSection>("controls");
  const [chatSection, setChatSection] = useState<ChatSection>("conversations");

  const [developerSection, setDeveloperSection] = useState<DeveloperSection>("api");
  const [mountedTabs, setMountedTabs] = useState<Set<Tab>>(() => new Set(["chat"]));
  const tasks = useTasks();
  const tabs: TabNavItem<Tab>[] = [
    { id: "chat", label: t("tab.chat"), icon: <ChatIcon /> },
    { id: "models", label: t("tab.models"), icon: <ModelsIcon /> },
    { id: "tuning", label: t("tab.tuning"), icon: <TuningIcon /> },
    { id: "developer", label: t("tab.developer"), icon: <DeveloperIcon /> },
    { id: "settings", label: t("tab.settings"), icon: <SettingsIcon /> },
  ];
  const modelSections: TabNavItem<ModelsSection>[] = [
    { id: "library", label: t("section.library") }, { id: "discover", label: t("section.discover") }, { id: "sessions", label: t("ui.sessionsTitle") }, { id: "runtimes", label: t("section.runtimes") },
  ];
  const tuningSections: TabNavItem<TuningSection>[] = [
    { id: "controls", label: t("ui.tuningControls") }, { id: "profiles", label: t("ui.executionProfiles") },
    { id: "benchmark", label: t("section.benchmark") }, { id: "lora", label: t("section.lora") },
  ];
  const chatSections: TabNavItem<ChatSection>[] = [
    { id: "conversations", label: t("chat.conversations") }, { id: "projects", label: t("section.projects") },
  ];
  const developerSections: TabNavItem<DeveloperSection>[] = [
    { id: "api", label: t("section.api") }, { id: "gateways", label: t("section.gateways") }, { id: "mcp", label: t("section.mcp") }, { id: "diagnostics", label: t("section.diagnostics") },
  ];
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

  const selectTab = (next: Tab): boolean => {
    const blocking = findTaskBlockingTabLeave(tasks);
    if (blocking && next !== tab && !window.confirm(t("ui.taskLeaveConfirm", { task: blocking.label }))) return false;
    setMountedTabs((current) => current.has(next) ? current : new Set([...current, next]));
    setTab(next);
    return true;
  };

  const openModels = () => { if (selectTab("models")) setModelsSection("library"); };
  const openDiagnostics = () => { if (selectTab("developer")) setDeveloperSection("diagnostics"); };
  const openTuning = () => { if (selectTab("tuning")) setTuningSection("controls"); };
  const openProfiles = () => { if (selectTab("tuning")) setTuningSection("profiles"); };

  const toggleServer = async () => {
    try {
      if (serverState === "running" || serverState === "starting") await store.stop();
      else await store.start();
    } catch {
      // The store publishes an actionable error banner; keep the shell mounted.
    }
  };

  const statusTone = serverState === "running" ? "is-ready" : serverState === "failed" || serverState === "crashed" ? "is-error" : "is-idle";
  const statusDetail = serverState === "running"
    ? `${store.status.active_requests ?? 0} ${t("load.requests")}`
    : "";
  const contextTitle = tab === "models"
    ? modelSections.find((item) => item.id === modelsSection)?.label ?? t("tab.models")
    : tab === "developer"
      ? developerSections.find((item) => item.id === developerSection)?.label ?? t("tab.developer")
      : tab === "chat" ? t("tab.chat") : tab === "tuning" ? t("tab.tuning") : t("tab.settings");
  const backendLabel = store.cfg?.active_backend
    ? `${store.cfg.active_backend}${store.cfg.active_build ? ` · ${buildNumber(store.cfg.active_build)}` : ""}`
    : t("load.pathRuntime");

  return (
    <div className="app-shell">
      <a href="#main-content" className="app-skip-link">{t("app.skip")}</a>

      <nav className="app-rail" aria-label={t("app.primary")}>
        <span className="app-brand-mark" aria-hidden="true"><BoardMark /></span>
        <TabNav
          items={tabs}
          active={tab}
          onSelect={selectTab}
          label={t("app.primary")}
          orientation="vertical"
          tabId={(id) => `tab-${id}`}
          panelId={(id) => `panel-${id}`}
          className="app-rail-tablist"
          tabClassName={(isActive) => `app-rail-link ${isActive ? "is-active" : ""}`}
          tabTitle={(id) => tabs.find((item) => item.id === id)?.label}
        />
        <div className="app-rail-version" aria-hidden="true">0.1.5</div>
      </nav>

      <div className="app-main-column">
        <header className="app-topbar">
          <h1 className="app-context-title">{contextTitle}</h1>
          <div className="app-status-bar">
            <span className={`app-status-chip ${statusTone}`} role="status" aria-live="polite">
              <span className="app-status-dot" aria-hidden="true" />
              {serverState === "running" ? t("status.ready") : serverState === "stopped" ? t("status.stopped") : serverState}
            </span>
            <span className="app-status-detail">{statusDetail}</span>
            <button type="button" onClick={() => void toggleServer()} disabled={!store.cfg || (serverBusy && serverState !== "starting") || (!store.cfg.active_model && serverState !== "running" && serverState !== "starting")} className={`app-server-button ${serverState === "running" || serverState === "starting" ? "is-stop" : "is-start"}`}>
              {serverState === "running" || serverState === "starting" ? t("action.stop") : serverBusy ? t("status.working") : t("action.start")}
            </button>
          </div>
        </header>

        <div className="app-loadbar">
          <span className="app-load-label">{t("load.label")}</span>
          <button type="button" className="app-load-select app-load-model" onClick={openModels} title={store.cfg?.active_model ? normalizeDisplayPath(store.cfg.active_model) : t("load.noModel")}>
            {shortModel(store.cfg?.active_model, t("load.noModel"))}
          </button>
          <button type="button" className="app-load-select app-load-backend" onClick={() => { if (selectTab("models")) setModelsSection("runtimes"); }}>
            {backendLabel}
          </button>
          <span className="app-load-metric app-load-metric--memory" aria-hidden={!store.status.memory}><b>mem</b> {store.status.memory ? `${store.status.memory.total_mb.toLocaleString()} MB` : "—"}</span>
          <span className="app-load-spacer" />
          <span className="app-load-warning-slot">
            {store.actionError && <span className="app-load-warning" title={normalizeDisplayText(store.actionError)}>● {t("load.failed")}</span>}
          </span>
          {tab !== "tuning" && <button type="button" className="app-apply-button" onClick={openTuning}>
            {t("ui.tuningControls")}
          </button>}
        </div>

        <div className="app-main-area">
          <div className="app-feedback-layer" aria-live="polite">
            {store.bootState === "native-unavailable" && (tab !== "chat" || chatSection !== "conversations") && (
              <FeedbackBanner tone="warning" title={t("native.unavailable")} action={{ label: t("native.openDiagnostics"), onClick: openDiagnostics }}>
                {t("native.message")}
              </FeedbackBanner>
            )}
            {hasError && store.bootState !== "native-unavailable" && (
              <FeedbackBanner tone="error" title={t("error.attention")} onDismiss={store.clearErrors} action={store.status.state === "failed" || store.status.state === "crashed" ? { label: t("native.openDiagnostics"), onClick: openDiagnostics } : undefined}>
                {store.bootError ?? store.actionError ?? store.statusPollError ?? store.status.error}
              </FeedbackBanner>
            )}
          </div>
          <TaskStrip />

          <main id="main-content" className="app-main" tabIndex={-1}>
          {mountedTabs.has("chat") && (
            <section id="panel-chat" role="tabpanel" aria-labelledby="tab-chat" hidden={tab !== "chat"} className="app-panel-host">
              <TabNav items={chatSections} active={chatSection} onSelect={setChatSection} label={t("tab.chat")} tabId={(id) => `chat-workspace-${id}`} panelId={(id) => `chat-workspace-panel-${id}`} className="app-workspace-tabs" tabClassName={(active) => active ? "is-active" : ""} />
              <div id="chat-workspace-panel-conversations" role="tabpanel" aria-labelledby="chat-workspace-conversations" hidden={chatSection !== "conversations"} className="app-workspace-content">
              {store.bootState === "native-unavailable" ? (
                <div className="app-page-scroll app-runtime-empty"><EmptyState title={t("native.unavailable")} description={t("native.message")} action={{ label: t("native.openDiagnostics"), onClick: openDiagnostics }} /></div>
              ) : <PanelBoundary label="Chat"><LazyPanel><ChatPanel store={store} preferences={preferences} onOpenModels={openModels} onOpenDiagnostics={openDiagnostics} active={tab === "chat" && chatSection === "conversations"} /></LazyPanel></PanelBoundary>}
              </div>
              <VisitedPanel id="chat-workspace-panel-projects" labelledBy="chat-workspace-projects" active={chatSection === "projects"}>
                <PanelBoundary label={t("section.projects")}><LazyPanel>{store.cfg ? <ProjectsPanel store={store} onOpenTuning={openTuning} /> : <PanelLoading />}</LazyPanel></PanelBoundary>
              </VisitedPanel>
            </section>
          )}

          {mountedTabs.has("models") && (
            <section id="panel-models" role="tabpanel" aria-labelledby="tab-models" hidden={tab !== "models"} className="app-panel-host">
              <PageShell scope="models" items={modelSections} active={modelsSection} onSelect={setModelsSection} title={t("section.models")}>
                <PanelBoundary label={t("section.models")}><LazyPanel>
                  <VisitedPanel active={modelsSection === "library"}><ModelsPanel store={store} focus="library" /></VisitedPanel>
                  <VisitedPanel active={modelsSection === "sessions"}>
                    <SessionsPanel store={store} active={tab === "models" && modelsSection === "sessions"} />
                  </VisitedPanel>
                  <VisitedPanel active={modelsSection === "discover"}><DiscoverPanel store={store} active={tab === "models" && modelsSection === "discover"} /></VisitedPanel>
                  <VisitedPanel active={modelsSection === "runtimes"}>
                    <RuntimesPanel store={store} active={tab === "models" && modelsSection === "runtimes"} onOpenProfiles={openProfiles} />
                  </VisitedPanel>
                </LazyPanel></PanelBoundary>
              </PageShell>
            </section>
          )}

          {mountedTabs.has("tuning") && (
            <section id="panel-tuning" role="tabpanel" aria-labelledby="tab-tuning" hidden={tab !== "tuning"} className="app-panel-host">
              <TabNav items={tuningSections} active={tuningSection} onSelect={setTuningSection} label={t("tab.tuning")} tabId={(id) => `tuning-workspace-${id}`} panelId={(id) => `tuning-workspace-panel-${id}`} className="app-workspace-tabs" tabClassName={(active) => active ? "is-active" : ""} />
              {tuningSections.map(({ id }) => <VisitedPanel key={id} id={`tuning-workspace-panel-${id}`} labelledBy={`tuning-workspace-${id}`} active={tuningSection === id}>
                <PanelBoundary label={t("section.tuning")}><LazyPanel>
                  {id === "controls" && <TuningPanel store={store} />}
                  {id === "profiles" && <div className="app-page-scroll p-4"><ProfilesPanel store={store} modelPath={store.cfg?.active_model ?? ""} onOpenTuning={openTuning} /></div>}
                  {id === "benchmark" && <BenchPanel store={store} />}
                  {id === "lora" && <ModelsPanel store={store} focus="lora" />}
                </LazyPanel></PanelBoundary>
              </VisitedPanel>)}
            </section>
          )}

          {mountedTabs.has("developer") && (
            <section id="panel-developer" role="tabpanel" aria-labelledby="tab-developer" hidden={tab !== "developer"} className="app-panel-host">
              <PageShell scope="developer" items={developerSections} active={developerSection} onSelect={setDeveloperSection} title={t("section.developer")}>
                <PanelBoundary label={t("section.developer")}><LazyPanel>{developerSection === "mcp" ? <McpPanel store={store} /> : <DeveloperPanel store={store} section={developerSection} />}</LazyPanel></PanelBoundary>
              </PageShell>
            </section>
          )}
          {mountedTabs.has("settings") && (
            <section id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" hidden={tab !== "settings"} className="app-panel-host">
              <PanelBoundary label={t("section.settings")}><LazyPanel><SettingsPanel preferences={preferences} update={updatePreferences} reset={resetAllPreferences} /></LazyPanel></PanelBoundary>
            </section>
          )}
          </main>
        </div>
      </div>
    </div>
  );
}
