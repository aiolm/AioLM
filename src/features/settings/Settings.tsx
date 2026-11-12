import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import Switch from "../../shared/ui/Switch";
import StatusBadge from "../../shared/ui/StatusBadge";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import TabNav, { type TabNavItem } from "../../shared/ui/TabNav";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import { getLaunchAtLogin, isNativeRuntimeAvailable, setLaunchAtLogin } from "../../shared/api/index";
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
import { useFlashMessage } from "../../shared/hooks/useFlashMessage";
import { controlChoiceCopy } from '../../shared/i18n/controlChoiceCopy';

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
const launchAtLoginText = {
  en: { label: "Start when the computer starts", description: "Open AioLM automatically when you sign in to this computer.", failed: "The startup registration could not be changed." },
  ko: { label: "컴퓨터 켤 때 자동으로 시작", description: "이 컴퓨터에 로그인하면 AioLM을 자동으로 엽니다.", failed: "시작 프로그램 등록을 변경하지 못했습니다." },
  ja: { label: "コンピューター起動時に自動で開始", description: "このコンピューターにサインインするとAioLMを自動で開きます。", failed: "スタートアップ登録を変更できませんでした。" },
  zh: { label: "开机时自动启动", description: "登录此计算机时自动打开AioLM。", failed: "无法更改开机启动设置。" },
};
// Reset and data deletion sit in their own group, away from everyday preferences.
const dangerText = {
  en: { title: "Reset and delete" },
  ko: { title: "초기화 및 삭제" },
  ja: { title: "リセットと削除" },
  zh: { title: "重置和删除" },
};

const matches = (query: string, ...text: string[]) => !query || text.join(" ").toLocaleLowerCase().includes(query);

/** A settings group; searching shows every group that still contains a matching item. */
function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <div className="settings-group" role="group" aria-labelledby={`settings-group-${id}`}>
    <h2 id={`settings-group-${id}`} className="settings-group-title">{title}</h2>
    {children}
  </div>;
}

const settingAria = (id: string) => ({ "aria-labelledby": `${id}-label`, "aria-describedby": `${id}-description` });

function Row({ id, label, description, children }: { id: string; label: string; description: string; children: ReactNode }) {
  const query = useContext(SearchContext);
  if (!matches(query, label, description)) return null;
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  return <div className="settings-row" data-setting=""><div className="settings-copy"><label id={labelId} htmlFor={id}>{label}</label><p id={descriptionId}>{description}</p></div><div className="settings-control">{children}</div></div>;
}

/**
 * Launch at login reads and writes the operating system's startup entry
 * directly, so a change made in the OS startup list shows up here too.
 */
function LaunchAtLoginRow({ onSaved }: { onSaved: () => void }) {
  const { locale } = useI18n();
  const copy = launchAtLoginText[locale];
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    getLaunchAtLogin().then(value => { if (current) setEnabled(value); }, (reason: unknown) => {
      if (current) { setEnabled(false); setError(reason instanceof Error ? reason.message : String(reason)); }
    });
    return () => { current = false; };
  }, []);
  const save = async (value: boolean) => {
    setSaving(true); setError(null);
    try {
      setEnabled(await setLaunchAtLogin(value));
      onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.failed); }
    finally { setSaving(false); }
  };
  return <Row id="settings-launch-at-login" label={copy.label} description={copy.description}>
    <div className="settings-control-stack">
      <Switch id="settings-launch-at-login" {...settingAria("settings-launch-at-login")} checked={enabled === true} disabled={enabled === null || saving} onChange={(value) => { void save(value); }} />
      {error && <FeedbackBanner tone="error">{normalizeDisplayText(error)}</FeedbackBanner>}
    </div>
  </Row>;
}

/** A row whose controls are buttons that keep their own names. */
function ActionRow({ id, label, description, danger = false, children }: { id: string; label: string; description: string; danger?: boolean; children: ReactNode }) {
  const query = useContext(SearchContext);
  if (!matches(query, label, description)) return null;
  return <div className={`settings-row${danger ? " settings-row--danger" : ""}`} data-setting="">
    <div className="settings-copy"><strong id={`${id}-label`}>{label}</strong><p id={`${id}-description`}>{description}</p></div>
    <div className="settings-control settings-actions" role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`}>{children}</div>
  </div>;
}

type NotificationFeedback = { tone: "success" | "warning" | "error"; message: string };
const permissionTone = { granted: "success", denied: "danger", default: "neutral", unavailable: "neutral" } as const;

/**
 * Reading notification access does not submit an alert. The operating system
 * may also ask for permission when a test or an enabled category submits one.
 * Categories stay editable even where notifications are unavailable, so the
 * choice is kept for the desktop app.
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
  const showPermission = matches(query, copy.permission, copy.permissionDesc);
  return <>
    {showPermission && <div className="settings-row settings-notification-permission" data-setting="">
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
    <Row id="settings-notify-chat" label={copy.chatCategory} description={copy.chatCategoryDesc}><Switch id="settings-notify-chat" {...settingAria("settings-notify-chat")} checked={preferences.notifications.chat} onChange={(value) => setCategory("chat", value)} /></Row>
    <Row id="settings-notify-downloads" label={copy.downloadsCategory} description={copy.downloadsCategoryDesc}><Switch id="settings-notify-downloads" {...settingAria("settings-notify-downloads")} checked={preferences.notifications.downloads} onChange={(value) => setCategory("downloads", value)} /></Row>
    <Row id="settings-notify-benchmark" label={copy.benchmarkCategory} description={copy.benchmarkCategoryDesc}><Switch id="settings-notify-benchmark" {...settingAria("settings-notify-benchmark")} checked={preferences.notifications.benchmark} onChange={(value) => setCategory("benchmark", value)} /></Row>
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
  const [resetScope, setResetScope] = useState<'all' | 'chat' | 'server' | 'appearance' | 'advanced' | 'notifications'>('all');
  const resetCopy = controlChoiceCopy[locale];
  const [ioError, setIoError] = useState<string | null>(null);
  const [saveState, showSaved] = useFlashMessage(1800);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeResult, setWipeResult] = useState<{ tone: "success" | "error"; message: string } | null>(null);
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
      showSaved("saved");
    } catch (error) { setTrayError(error instanceof Error ? error.message : trayCopy.failed); }
    finally { setTraySaving(false); }
  };

  const wipeConversationData = async () => {
    setWiping(true);
    setWipeResult(null);
    try {
      // Both stores hold readable content: the workspace keeps message text,
      // the index keeps the extracted document chunks it embedded.
      await clearChatWorkspace(clearDocumentIndex);
      setWipeResult({ tone: "success", message: t("ui.wipeDataDone") });
    } catch (error) {
      setWipeResult({ tone: "error", message: normalizeDisplayText(`${t("ui.wipeDataFailed")}: ${error instanceof Error ? error.message : String(error)}`) });
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
    showSaved("saved");
  };
  const restorePreferences = () => {
    if (resetScope === 'all') reset();
    else {
      const defaults = defaultPreferences();
      patch(resetScope === 'appearance' ? { appearance: defaults.appearance, theme: defaults.theme } : { [resetScope]: defaults[resetScope] });
    }
    setConfirmReset(false);
  };
  const toggle = (key: "enterToSend" | "streamResponses" | "compactMessages", value: boolean) => patch({ chat: { ...preferences.chat, [key]: value } });
  const bool = (id: string, checked: boolean, onChange: (value: boolean) => void) => <Switch id={id} {...settingAria(id)} checked={checked} onChange={onChange} />;
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
    <div className="settings-header"><div><h1>{t("settings.title")}</h1><p>{t("settings.subtitle")}</p></div><span className={`settings-save-slot ${saveState === "saved" ? "" : "is-empty"}`} role={saveState === "saved" ? "status" : undefined} aria-live={saveState === "saved" ? "polite" : undefined}>{saveState === "saved" ? <StatusBadge label={t("common.saved")} tone="success" /> : "—"}</span></div>
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
        {(normalizedQuery || section === "general") && <Group id="general" title={t("settings.general")}>
          <Row id="settings-language" label={t("settings.language")} description={t("settings.languageDesc")}>
            <CustomSelect id="settings-language" {...settingAria("settings-language")} value={locale} options={localeOptions} onChange={(next) => { setLocale(next); patch({ locale: next }); }} triggerClassName="settings-select" />
          </Row>
          <Row id="settings-density" label={t("settings.density")} description={t("settings.densityDesc")}>
            <CustomSelect id="settings-density" {...settingAria("settings-density")} value={preferences.appearance.density} options={[{ value: "comfortable", label: t("settings.comfortable") }, { value: "compact", label: t("settings.compact") }]} onChange={(density) => patch({ appearance: { ...preferences.appearance, density } })} triggerClassName="settings-select" />
          </Row>
          <AppUpdateSettings query={normalizedQuery} />
        </Group>}
        {(normalizedQuery || section === "appearance") && <Group id="appearance" title={t("settings.appearance")}>
          <Row id="settings-theme" label={t("settings.theme")} description={t("settings.themeDesc")}>
            <CustomSelect id="settings-theme" {...settingAria("settings-theme")} value={preferences.theme} options={[{ value: "light", label: t("theme.light") }, { value: "dark", label: t("theme.dark") }, { value: "system", label: t("theme.system") }]} onChange={(theme) => patch({ theme })} triggerClassName="settings-select" />
          </Row>
          <Row id="settings-font-family" label={prefCopy.appFont} description={prefCopy.appFontDesc}>
            <CustomSelect<AppFontFamily> id="settings-font-family" {...settingAria("settings-font-family")} value={preferences.appearance.fontFamily} options={[{ value: "default", label: prefCopy.fontDefault }, { value: "system", label: prefCopy.fontSystem }, { value: "serif", label: prefCopy.fontSerif }]} onChange={(fontFamily) => patch({ appearance: { ...preferences.appearance, fontFamily } })} triggerClassName="settings-select" />
          </Row>
          <Row id="settings-code-font" label={prefCopy.codeFont} description={prefCopy.codeFontDesc}>
            <CustomSelect<CodeFontFamily> id="settings-code-font" {...settingAria("settings-code-font")} value={preferences.appearance.codeFontFamily} options={[{ value: "default", label: prefCopy.codeFontDefault }, { value: "system", label: prefCopy.codeFontSystem }]} onChange={(codeFontFamily) => patch({ appearance: { ...preferences.appearance, codeFontFamily } })} triggerClassName="settings-select" />
          </Row>
          {!normalizedQuery && <figure className="settings-preview" aria-label={prefCopy.fontPreview}>
            <p style={{ fontFamily: appFontFamilyValue(preferences.appearance.fontFamily) }}>{prefCopy.fontPreviewText}</p>
            <pre className="settings-preview-code"><code style={{ fontFamily: codeFontFamilyValue(preferences.appearance.codeFontFamily) }}>{"const reply = await model.generate(prompt);\nconsole.log(reply.text); // 0O 1lI"}</code></pre>
          </figure>}
          <Row id="settings-reduce-motion" label={t("settings.reduceMotion")} description={t("settings.reduceMotionDesc")}>{bool("settings-reduce-motion", preferences.appearance.reduceMotion, (value) => patch({ appearance: { ...preferences.appearance, reduceMotion: value } }))}</Row>
        </Group>}
        {(normalizedQuery || section === "chat") && <Group id="chat" title={t("settings.chat")}>
          <Row id="settings-enter-to-send" label={t("settings.enterToSend")} description={t("settings.enterToSendDesc")}>{bool("settings-enter-to-send", preferences.chat.enterToSend, (value) => toggle("enterToSend", value))}</Row>
          <Row id="settings-stream" label={t("settings.stream")} description={t("settings.streamDesc")}>{bool("settings-stream", preferences.chat.streamResponses, (value) => toggle("streamResponses", value))}</Row>
          <Row id="settings-compact-messages" label={t("settings.compactMessages")} description={t("settings.compactMessagesDesc")}>{bool("settings-compact-messages", preferences.chat.compactMessages, (value) => toggle("compactMessages", value))}</Row>
          <Row id="settings-chat-line-spacing" label={prefCopy.lineSpacing} description={prefCopy.lineSpacingDesc}>
            <CustomSelect<ChatLineSpacing> id="settings-chat-line-spacing" {...settingAria("settings-chat-line-spacing")} value={preferences.chat.lineSpacing} options={[{ value: "compact", label: prefCopy.lineSpacingCompact }, { value: "normal", label: prefCopy.lineSpacingNormal }, { value: "relaxed", label: prefCopy.lineSpacingRelaxed }]} onChange={(lineSpacing) => patch({ chat: { ...preferences.chat, lineSpacing } })} triggerClassName="settings-select" />
          </Row>
          {!normalizedQuery && <figure className="settings-preview" aria-label={prefCopy.lineSpacingPreview}>
            <p style={{ lineHeight: chatLineHeights[preferences.chat.lineSpacing].prose }}>{prefCopy.lineSpacingPreviewText}</p>
          </figure>}
        </Group>}
        {(normalizedQuery || section === "personalization") && <Group id="personalization" title={personalizationCopy.title}>
          <PersonalizationSettings editor={personalization} query={normalizedQuery} instructionSources={preferences.personalization.instructionSources}
            onInstructionSourcesChange={instructionSources => patch({ personalization: { ...preferences.personalization, instructionSources } })} />
        </Group>}
        {(normalizedQuery || section === "notifications") && <Group id="notifications" title={prefCopy.notifications}>
          <NotificationSettings preferences={preferences} patch={patch} />
        </Group>}
        {(normalizedQuery || section === "server") && <Group id="server" title={t("settings.server")}>
          {isNativeRuntimeAvailable() && <LaunchAtLoginRow onSaved={() => showSaved("saved")} />}
          <Row id="settings-auto-start" label={t("settings.autoStart")} description={t("settings.autoStartDesc")}>{bool("settings-auto-start", preferences.server.autoStart, (value) => patch({ server: { ...preferences.server, autoStart: value } }))}</Row>
          {isNativeRuntimeAvailable() && store?.cfg && <Row id="settings-close-to-tray" label={trayCopy.label} description={trayCopy.description}>
            <div className="settings-control-stack">
              <Switch id="settings-close-to-tray" {...settingAria("settings-close-to-tray")} checked={store.cfg.close_to_tray !== false} disabled={traySaving || store.busy} onChange={(value) => { void saveCloseToTray(value); }} />
              {trayError && <FeedbackBanner tone="error">{normalizeDisplayText(trayError)}</FeedbackBanner>}
            </div>
          </Row>}
          {isNativeRuntimeAvailable() && <div className="settings-note"><strong>{t("ui.exitCleanupTitle")}</strong><p>{t("ui.exitCleanupDescription")}</p></div>}
        </Group>}
        {(normalizedQuery || section === "advanced") && <Group id="advanced" title={t("settings.advanced")}>
          <Row id="settings-confirm-destructive" label={t("settings.confirmDestructive")} description={t("settings.confirmDestructiveDesc")}>{bool("settings-confirm-destructive", preferences.advanced.confirmDestructiveActions, (value) => patch({ advanced: { ...preferences.advanced, confirmDestructiveActions: value } }))}</Row>
          <ActionRow id="settings-backup" label={t("settings.backupTitle")} description={t("settings.backupDescription")}>
            <button type="button" className="app-button app-button--secondary" data-icon="upload" onClick={downloadExport}>{t("settings.export")}</button>
            <label data-icon="upload" className="app-button app-button--secondary settings-file-button">{t("settings.import")}
              <input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => { void importFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
            </label>
          </ActionRow>
          {ioError && <FeedbackBanner tone="error" className="settings-row-feedback">{normalizeDisplayText(ioError)}</FeedbackBanner>}
          <div className="settings-danger-zone" role="group" aria-labelledby="settings-danger-title">
            <h3 id="settings-danger-title">{dangerText[locale].title}</h3>
            <ActionRow id="settings-reset" label={t("settings.resetAction")} description={resetCopy.resetHint} danger>
              <button type="button" className="app-button app-button--danger" data-icon="reset" onClick={() => { setResetScope('all'); setConfirmReset(true); }}>{t("settings.resetAction")}</button>
            </ActionRow>
            <ActionRow id="settings-wipe" label={t("ui.wipeDataTitle")} description={t("ui.wipeDataDescription")} danger>
              <button type="button" className="app-button app-button--danger" data-icon="delete" disabled={wiping} onClick={() => setConfirmWipe(true)}>{t("ui.wipeDataAction")}</button>
            </ActionRow>
            {wipeResult && <FeedbackBanner tone={wipeResult.tone} className="settings-row-feedback">{wipeResult.message}</FeedbackBanner>}
          </div>
          {!isNativeRuntimeAvailable() && <div className="settings-note"><strong>{t("settings.nativeTitle")}</strong><p>{t("settings.nativeMessage")}</p></div>}
        </Group>}
      </section>
      {normalizedQuery && <p className="settings-no-results" role="status">{search.empty}</p>}
      </SearchContext.Provider>
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
    <ConfirmDialog open={confirmReset} title={t("settings.resetAction")} description={<>
      <p>{resetCopy.resetHint}</p><fieldset className="grid gap-2 mt-3"><legend>{resetCopy.scope}</legend>
        {(['all', 'chat', 'server', 'appearance', 'advanced', 'notifications'] as const).map(scope => <label key={scope} className="settings-reset-choice flex items-center gap-2">
          <input type="radio" name="settings-reset-scope" value={scope} checked={resetScope === scope} onChange={() => setResetScope(scope)} />{resetCopy[scope]}
        </label>)}
      </fieldset>
    </>} confirmLabel={t("settings.resetAction")} onConfirm={restorePreferences} onCancel={() => setConfirmReset(false)} />
  </div>;
}
