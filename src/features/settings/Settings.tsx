import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import { cloneElement, createContext, isValidElement, useContext, useEffect, useState, type ReactNode } from "react";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import Switch from "../../shared/ui/Switch";
import StatusBadge from "../../shared/ui/StatusBadge";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import TabNav, { type TabNavItem } from "../../shared/ui/TabNav";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import { isNativeRuntimeAvailable } from "../../shared/api/index";
import { localeOptions, useI18n } from "../../shared/i18n/i18n";
import { clearChatWorkspace } from "../chat/chatHistory";
import { clearDocumentIndex } from "../chat/documentIndex";
import { defaultPreferences, exportPreferences, importPreferences, type AppFontFamily, type AppPreferences, type ChatLineSpacing, type CodeFontFamily, type NotificationPreferences } from "../../shared/config/preferences";
import { appFontFamilyValue, chatLineHeights, codeFontFamilyValue } from "../../shared/config/typography";
import { preferenceText } from "../../shared/i18n/preferenceText";
import { getNotificationPermission, requestNotificationPermission, sendTestNotification, type NotificationPermission } from "../../shared/lib/notifications";
import type { AppStore } from "../../shared/state/store";
import AppUpdateSettings from "../updates/AppUpdateSettings";
import PersonalizationSettings, { usePersonalizationEditor } from "./PersonalizationSettings";
import { personalizationText } from "../../shared/i18n/personalizationText";

interface Props { preferences: AppPreferences; update: (patch: Partial<AppPreferences>) => void; reset: () => void; store?: AppStore; updateRequest?: number; }

type Section = "general" | "appearance" | "chat" | "personalization" | "notifications" | "server" | "advanced";
const SearchContext = createContext("");
const searchText = {
  en: { label: "Search settings", empty: "No settings match your search." },
  ko: { label: "설정 검색", empty: "검색어에 맞는 설정이 없습니다." },
  ja: { label: "設定を検索", empty: "一致する設定はありません。" },
  zh: { label: "搜索设置", empty: "没有匹配的设置。" },
};
const closeToTrayText = {
  en: { label: "Close to system tray", description: "Closing the window hides AioLM in the system tray and leaves running servers up. Use the tray icon to bring the window back or to quit.", failed: "The system tray is unavailable, so this setting was not changed." },
  ko: { label: "닫을 때 시스템 트레이로 이동", description: "창을 닫으면 AioLM이 시스템 트레이로 숨고 실행 중인 서버는 계속 동작합니다. 트레이 아이콘에서 창을 다시 열거나 종료할 수 있습니다.", failed: "시스템 트레이를 사용할 수 없어 설정을 변경하지 못했습니다." },
  ja: { label: "閉じるときにシステムトレイへ", description: "ウィンドウを閉じるとAioLMはシステムトレイに隠れ、実行中のサーバーはそのまま動きます。トレイアイコンからウィンドウを戻すか終了できます。", failed: "システムトレイを利用できないため、設定を変更できませんでした。" },
  zh: { label: "关闭时最小化到系统托盘", description: "关闭窗口后AioLM会隐藏到系统托盘，正在运行的服务器继续运行。可通过托盘图标恢复窗口或退出。", failed: "系统托盘不可用，设置未更改。" },
};

function Row({ id, label, description, children }: { id: string; label: string; description: string; children: ReactNode }) {
  const query = useContext(SearchContext);
  if (query && !`${label} ${description}`.toLocaleLowerCase().includes(query)) return null;
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  const control = isValidElement<{ "aria-describedby"?: string; "aria-labelledby"?: string }>(children)
    ? cloneElement(children, { "aria-describedby": descriptionId, "aria-labelledby": labelId })
    : children;
  return <div className="settings-row"><div className="settings-copy"><label id={labelId} htmlFor={id}>{label}</label><p id={descriptionId}>{description}</p></div><div className="settings-control">{control}</div></div>;
}

type NotificationFeedback = { tone: "success" | "warning" | "error"; message: string };
const permissionTone = { granted: "success", denied: "danger", default: "neutral", unavailable: "neutral" } as const;

/**
 * Permission is only read here; the operating system is asked solely from the
 * Allow button, never on startup or in the background. Categories stay
 * editable even where notifications are unavailable, so the choice is kept
 * for the desktop app.
 */
function NotificationSettings({ preferences, patch }: { preferences: AppPreferences; patch: (next: Partial<AppPreferences>) => void }) {
  const { locale } = useI18n();
  const query = useContext(SearchContext);
  const copy = preferenceText[locale];
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<NotificationFeedback | null>(null);
  useEffect(() => {
    let live = true;
    getNotificationPermission().then((next) => { if (live) setPermission(next); }, () => { if (live) setPermission("unavailable"); });
    return () => { live = false; };
  }, []);
  const run = async (action: () => Promise<void>, failure: string) => {
    setBusy(true); setFeedback(null);
    try { await action(); } catch { setFeedback({ tone: "error", message: failure }); } finally { setBusy(false); }
  };
  const request = () => run(async () => { setPermission(await requestNotificationPermission()); }, copy.requestFailed);
  const recheck = () => run(async () => { setPermission(await getNotificationPermission()); }, copy.requestFailed);
  const sendTest = () => run(async () => {
    const sent = await sendTestNotification();
    setFeedback(sent ? { tone: "success", message: copy.testSent } : { tone: "warning", message: copy.testNotAllowed });
  }, copy.testFailed);
  const statusLabel = permission === null ? copy.statusChecking : { granted: copy.statusGranted, denied: copy.statusDenied, default: copy.statusDefault, unavailable: copy.statusUnavailable }[permission];
  const help = permission === "denied" ? copy.deniedHelp : permission === "unavailable" ? copy.unavailableHelp : null;
  // Desktop alerts on Windows need the app identity an installation registers.
  const windowsHelp = permission !== null && permission !== "unavailable" && /Windows/i.test(navigator.userAgent) ? copy.windowsHelp : null;
  const setCategory = (key: keyof NotificationPreferences, value: boolean) => patch({ notifications: { ...preferences.notifications, [key]: value } });
  const showPermission = !query || `${copy.permission} ${copy.permissionDesc}`.toLocaleLowerCase().includes(query);
  return <>
    {showPermission && <div className="settings-row settings-notification-permission">
      <div className="settings-copy">
        <strong id="settings-notification-permission-label">{copy.permission}</strong>
        <p>{copy.permissionDesc}</p>
        {help && <p>{help}</p>}
        {windowsHelp && <p>{windowsHelp}</p>}
      </div>
      <div className="settings-control settings-notification-actions" role="group" aria-labelledby="settings-notification-permission-label">
        <StatusBadge role="status" label={statusLabel} tone={permission ? permissionTone[permission] : "neutral"} />
        {permission === "default" && <button type="button" className="app-button app-button--primary" disabled={busy} onClick={() => { void request(); }}>{copy.allow}</button>}
        {permission === "denied" && <button type="button" className="app-button app-button--secondary" disabled={busy} onClick={() => { void recheck(); }}>{copy.checkAgain}</button>}
        <button type="button" className="app-button app-button--secondary" disabled={busy || permission !== "granted"} onClick={() => { void sendTest(); }}>{copy.sendTest}</button>
      </div>
      {feedback && <FeedbackBanner tone={feedback.tone} className="settings-notification-feedback" onDismiss={() => setFeedback(null)}>{feedback.message}</FeedbackBanner>}
    </div>}
    <Row id="settings-notify-chat" label={copy.chatCategory} description={copy.chatCategoryDesc}><Switch id="settings-notify-chat" checked={preferences.notifications.chat} onChange={(value) => setCategory("chat", value)} /></Row>
    <Row id="settings-notify-downloads" label={copy.downloadsCategory} description={copy.downloadsCategoryDesc}><Switch id="settings-notify-downloads" checked={preferences.notifications.downloads} onChange={(value) => setCategory("downloads", value)} /></Row>
    <Row id="settings-notify-benchmark" label={copy.benchmarkCategory} description={copy.benchmarkCategoryDesc}><Switch id="settings-notify-benchmark" checked={preferences.notifications.benchmark} onChange={(value) => setCategory("benchmark", value)} /></Row>
  </>;
}

export default function SettingsPanel({ preferences, update, reset, store, updateRequest = 0 }: Props) {
  const { t, locale, setLocale } = useI18n();
  const [section, setSection] = useState<Section>("general");
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!updateRequest) return;
    setSection("general");
    setQuery("");
    const frame = window.requestAnimationFrame(() => document.getElementById("settings-check-update")?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [updateRequest]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const search = searchText[locale];
  const [confirmReset, setConfirmReset] = useState(false);
  const [ioError, setIoError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saved">("idle");
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeNotice, setWipeNotice] = useState<string | null>(null);
  const trayCopy = closeToTrayText[locale];
  const prefCopy = preferenceText[locale];
  const personalizationCopy = personalizationText[locale];
  const personalization = usePersonalizationEditor();
  const [trayError, setTrayError] = useState<string | null>(null);
  const [traySaving, setTraySaving] = useState(false);
  // The backend puts the tray icon on screen before it writes the setting, so a
  // machine with no usable tray keeps the saved value it already had.
  const saveCloseToTray = async (value: boolean) => {
    if (!store) return;
    setTraySaving(true); setTrayError(null);
    try {
      await store.updateConfig({ close_to_tray: value });
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1800);
    } catch (error) { setTrayError(error instanceof Error ? error.message : trayCopy.failed); }
    finally { setTraySaving(false); }
  };

  const wipeConversationData = async () => {
    setWiping(true);
    try {
      // Both stores hold readable content: the workspace keeps message text,
      // the index keeps the extracted document chunks it embedded.
      await clearChatWorkspace();
      await clearDocumentIndex();
      setWipeNotice(t("ui.wipeDataDone"));
      setIoError(null);
    } catch (error) {
      setIoError(`${t("ui.wipeDataFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setWiping(false);
      setConfirmWipe(false);
    }
  };
  const sections: TabNavItem<Section>[] = [
    { id: "general", label: t("settings.general") }, { id: "appearance", label: t("settings.appearance") },
    { id: "chat", label: t("settings.chat") }, { id: "personalization", label: personalizationCopy.title }, { id: "notifications", label: prefCopy.notifications }, { id: "server", label: t("settings.server") }, { id: "advanced", label: t("settings.advanced") },
  ];
  const patch = (next: Partial<AppPreferences>) => {
    update(next);
    setSaveState("saved");
    window.setTimeout(() => setSaveState("idle"), 1800);
  };
  const toggle = (key: "enterToSend" | "showTimestamps" | "streamResponses" | "compactMessages", value: boolean) => patch({ chat: { ...preferences.chat, [key]: value } });
  const bool = (id: string, checked: boolean, onChange: (value: boolean) => void) => <Switch id={id} checked={checked} onChange={onChange} />;
  const downloadExport = () => {
    const blob = new Blob([exportPreferences(preferences)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "aiolm-settings.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const next = importPreferences(await file.text());
      update(next);
      setLocale(next.locale);
      setIoError(null);
    } catch (error) {
      setIoError(error instanceof Error ? error.message : String(error));
    }
  };


  return <div className="app-page-scroll settings-page">
    <div className="settings-header"><div><h2>{t("settings.title")}</h2><p>{t("settings.subtitle")}</p></div><span className={`settings-save-slot ${saveState === "saved" ? "" : "is-empty"}`} role={saveState === "saved" ? "status" : undefined} aria-live={saveState === "saved" ? "polite" : undefined}>{saveState === "saved" ? <StatusBadge label={t("common.saved")} tone="success" /> : "—"}</span></div>
    <div className="settings-layout">
      <input type="search" className="app-input settings-search" aria-label={search.label} placeholder={search.label} value={query} onChange={event => setQuery(event.target.value)} />
      <TabNav
        items={sections}
        active={section}
        onSelect={setSection}
        label={t("settings.title")}
        orientation="horizontal"
        tabId={(id) => `settings-tab-${id}`}
        panelId={() => "settings-tabpanel"}
        className="settings-nav"
      />
      <SearchContext.Provider value={normalizedQuery}>
      <section className={`settings-content${normalizedQuery ? " is-searching" : ""}`} role="tabpanel" id="settings-tabpanel" aria-labelledby={normalizedQuery ? undefined : `settings-tab-${section}`} aria-label={normalizedQuery ? search.label : undefined} tabIndex={-1}>
        {(normalizedQuery || section === "general") && <>
          <h3>{t("settings.general")}</h3>
          <Row id="settings-language" label={t("settings.language")} description={t("settings.languageDesc")}>
            <CustomSelect id="settings-language" value={locale} options={localeOptions} onChange={(next) => { setLocale(next); patch({ locale: next }); }} triggerClassName="w-[180px]" />
          </Row>
          <Row id="settings-density" label={t("settings.density")} description={t("settings.densityDesc")}>
            <CustomSelect id="settings-density" value={preferences.appearance.density} options={[{ value: "comfortable", label: t("settings.comfortable") }, { value: "compact", label: t("settings.compact") }]} onChange={(density) => patch({ appearance: { ...preferences.appearance, density } })} triggerClassName="w-[180px]" />
          </Row>
          <AppUpdateSettings query={normalizedQuery} />
        </>}
        {(normalizedQuery || section === "appearance") && <>
          <h3>{t("settings.appearance")}</h3>
          <Row id="settings-reduce-motion" label={t("settings.reduceMotion")} description={t("settings.reduceMotionDesc")}>{bool("settings-reduce-motion", preferences.appearance.reduceMotion, (value) => patch({ appearance: { ...preferences.appearance, reduceMotion: value } }))}</Row>
          <Row id="settings-theme" label={t("settings.theme")} description={t("settings.themeDesc")}>
            <CustomSelect id="settings-theme" value={preferences.theme} options={[{ value: "light", label: t("theme.light") }, { value: "dark", label: t("theme.dark") }, { value: "system", label: t("theme.system") }]} onChange={(theme) => patch({ theme })} triggerClassName="w-[180px]" />
          </Row>
          <Row id="settings-font-family" label={prefCopy.appFont} description={prefCopy.appFontDesc}>
            <CustomSelect<AppFontFamily> id="settings-font-family" value={preferences.appearance.fontFamily} options={[{ value: "default", label: prefCopy.fontDefault }, { value: "system", label: prefCopy.fontSystem }, { value: "serif", label: prefCopy.fontSerif }]} onChange={(fontFamily) => patch({ appearance: { ...preferences.appearance, fontFamily } })} triggerClassName="w-[180px]" />
          </Row>
          <Row id="settings-code-font" label={prefCopy.codeFont} description={prefCopy.codeFontDesc}>
            <CustomSelect<CodeFontFamily> id="settings-code-font" value={preferences.appearance.codeFontFamily} options={[{ value: "default", label: prefCopy.codeFontDefault }, { value: "system", label: prefCopy.codeFontSystem }]} onChange={(codeFontFamily) => patch({ appearance: { ...preferences.appearance, codeFontFamily } })} triggerClassName="w-[180px]" />
          </Row>
          {!normalizedQuery && <figure className="settings-preview" aria-label={prefCopy.fontPreview}>
            <p style={{ fontFamily: appFontFamilyValue(preferences.appearance.fontFamily) }}>{prefCopy.fontPreviewText}</p>
            <pre className="settings-preview-code"><code style={{ fontFamily: codeFontFamilyValue(preferences.appearance.codeFontFamily) }}>{"const reply = await model.generate(prompt);\nconsole.log(reply.text); // 0O 1lI"}</code></pre>
          </figure>}
        </>}
        {(normalizedQuery || section === "chat") && <>
          <h3>{t("settings.chat")}</h3>
          <Row id="settings-enter-to-send" label={t("settings.enterToSend")} description={t("settings.enterToSendDesc")}>{bool("settings-enter-to-send", preferences.chat.enterToSend, (value) => toggle("enterToSend", value))}</Row>
          <Row id="settings-timestamps" label={t("settings.timestamps")} description={t("settings.timestampsDesc")}>{bool("settings-timestamps", preferences.chat.showTimestamps, (value) => toggle("showTimestamps", value))}</Row>
          <Row id="settings-stream" label={t("settings.stream")} description={t("settings.streamDesc")}>{bool("settings-stream", preferences.chat.streamResponses, (value) => toggle("streamResponses", value))}</Row>
          <Row id="settings-compact-messages" label={t("settings.compactMessages")} description={t("settings.compactMessagesDesc")}>{bool("settings-compact-messages", preferences.chat.compactMessages, (value) => toggle("compactMessages", value))}</Row>
          <Row id="settings-chat-line-spacing" label={prefCopy.lineSpacing} description={prefCopy.lineSpacingDesc}>
            <CustomSelect<ChatLineSpacing> id="settings-chat-line-spacing" value={preferences.chat.lineSpacing} options={[{ value: "compact", label: prefCopy.lineSpacingCompact }, { value: "normal", label: prefCopy.lineSpacingNormal }, { value: "relaxed", label: prefCopy.lineSpacingRelaxed }]} onChange={(lineSpacing) => patch({ chat: { ...preferences.chat, lineSpacing } })} triggerClassName="w-[180px]" />
          </Row>
          {!normalizedQuery && <figure className="settings-preview" aria-label={prefCopy.lineSpacingPreview}>
            <p style={{ lineHeight: chatLineHeights[preferences.chat.lineSpacing].prose }}>{prefCopy.lineSpacingPreviewText}</p>
          </figure>}
        </>}
        {(normalizedQuery || section === "personalization") && <>
          <h3>{personalizationCopy.title}</h3>
          <PersonalizationSettings editor={personalization} query={normalizedQuery} />
        </>}
        {(normalizedQuery || section === "notifications") && <>
          <h3>{prefCopy.notifications}</h3>
          <NotificationSettings preferences={preferences} patch={patch} />
        </>}
        {(normalizedQuery || section === "server") && <>
          <h3>{t("settings.server")}</h3>
          <Row id="settings-auto-start" label={t("settings.autoStart")} description={t("settings.autoStartDesc")}>{bool("settings-auto-start", preferences.server.autoStart, (value) => patch({ server: { ...preferences.server, autoStart: value } }))}</Row>
          {isNativeRuntimeAvailable()
            ? <div className="settings-note app-card app-card--muted app-card--tight"><strong>{t("ui.exitCleanupTitle")}</strong><p>{t("ui.exitCleanupDescription")}</p></div>
            : <Row id="settings-auto-stop" label={t("settings.autoStop")} description={t("settings.autoStopDesc")}>{bool("settings-auto-stop", preferences.server.autoStopOnExit, (value) => patch({ server: { ...preferences.server, autoStopOnExit: value } }))}</Row>}
          {isNativeRuntimeAvailable() && store?.cfg && <Row id="settings-close-to-tray" label={trayCopy.label} description={trayCopy.description}>
            <div>
              <Switch id="settings-close-to-tray" checked={store.cfg.close_to_tray === true} disabled={traySaving || store.busy} onChange={(value) => { void saveCloseToTray(value); }} />
              {trayError && <FeedbackBanner tone="error" className="mt-2">{normalizeDisplayText(trayError)}</FeedbackBanner>}
            </div>
          </Row>}
          <Row id="settings-polling" label={t("settings.polling")} description={t("settings.pollingDesc")}>
            <CustomSelect id="settings-polling" value={preferences.server.pollIntervalMs} options={[{ value: 500, label: "500 ms" }, { value: 1000, label: "1 s" }, { value: 2000, label: "2 s" }, { value: 5000, label: "5 s" }]} onChange={(pollIntervalMs) => patch({ server: { ...preferences.server, pollIntervalMs } })} triggerClassName="w-[180px]" />
          </Row>
        </>}
        {(normalizedQuery || section === "advanced") && <>
          <h3>{t("settings.advanced")}</h3>
          <Row id="settings-developer-mode" label={t("settings.developerMode")} description={t("settings.developerModeDesc")}>{bool("settings-developer-mode", preferences.advanced.developerMode, (value) => patch({ advanced: { ...preferences.advanced, developerMode: value } }))}</Row>
          <Row id="settings-confirm-destructive" label={t("settings.confirmDestructive")} description={t("settings.confirmDestructiveDesc")}>{bool("settings-confirm-destructive", preferences.advanced.confirmDestructiveActions, (value) => patch({ advanced: { ...preferences.advanced, confirmDestructiveActions: value } }))}</Row>
          <div className="settings-danger app-card app-card--tight"><strong>{t("settings.reset")}</strong><p>{t("settings.resetDesc")}</p><button type="button" className="app-button app-button--danger" data-icon="reset" onClick={() => setConfirmReset(true)}>{t("settings.resetAction")}</button></div>
          {ioError && !normalizedQuery && <FeedbackBanner tone="error" className="m-3">{normalizeDisplayText(ioError)}</FeedbackBanner>}
          <div className="settings-note app-card app-card--muted app-card--tight"><strong>{t("settings.backupTitle")}</strong><p>{t("settings.backupDescription")}</p><div className="mt-3 flex flex-wrap gap-2.5"><button type="button" className="app-button app-button--secondary" data-icon="upload" onClick={downloadExport}>{t("settings.export")}</button><label data-icon="upload" className="app-button app-button--secondary cursor-pointer">{t("settings.import")}
<input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => { void importFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label><button type="button" className="app-button app-button--warning" data-icon="reset" onClick={() => update({ chat: defaultPreferences().chat })}>{t("settings.resetChat")}</button><button type="button" className="app-button app-button--warning" data-icon="reset" onClick={() => update({ server: defaultPreferences().server })}>{t("settings.resetServer")}</button><button type="button" className="app-button app-button--warning" data-icon="reset" onClick={() => update({ appearance: defaultPreferences().appearance, theme: defaultPreferences().theme })}>{t("settings.resetAppearance")}</button><button type="button" className="app-button app-button--warning" data-icon="reset" onClick={() => update({ advanced: defaultPreferences().advanced })}>{t("settings.resetAdvanced")}</button><button type="button" className="app-button app-button--warning" data-icon="reset" onClick={() => update({ notifications: defaultPreferences().notifications })}>{prefCopy.resetNotifications}</button></div></div>
          <div className="settings-danger app-card app-card--tight"><strong>{t("ui.wipeDataTitle")}</strong><p>{t("ui.wipeDataDescription")}</p><button type="button" className="app-button app-button--danger" data-icon="delete" disabled={wiping} onClick={() => setConfirmWipe(true)}>{t("ui.wipeDataAction")}</button></div>
          <div className="settings-note app-card app-card--muted app-card--tight"><strong>{t("settings.nativeTitle")}</strong><p>{t("settings.nativeMessage")}</p></div>
        </>}
      </section>
      {normalizedQuery && <p className="settings-no-results" role="status">{search.empty}</p>}
      </SearchContext.Provider>
    </div>
    <div className="settings-wipe-slot">
      {wipeNotice && <FeedbackBanner tone="success">{wipeNotice}</FeedbackBanner>}
    </div>
    <ConfirmDialog
      open={confirmWipe}
      title={t("ui.wipeDataConfirmTitle")}
      description={t("ui.wipeDataConfirmBody")}
      confirmLabel={t("ui.wipeDataAction")}
      cancelLabel={t("common.cancel")}
      busy={wiping}
      onConfirm={() => void wipeConversationData()}
      onCancel={() => { if (!wiping) setConfirmWipe(false); }}
    />
    <ConfirmDialog open={confirmReset} title={t("settings.resetTitle")} description={t("settings.resetMessage")} confirmLabel={t("settings.resetAction")} onConfirm={() => { reset(); setConfirmReset(false); }} onCancel={() => setConfirmReset(false)} />
  </div>;
}
