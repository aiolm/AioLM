import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import { cloneElement, createContext, isValidElement, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import Switch from "../../shared/ui/Switch";
import TabNav, { type TabNavItem } from "../../shared/ui/TabNav";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import { isNativeRuntimeAvailable } from "../../shared/api/index";
import { localeOptions, useI18n } from "../../shared/i18n/i18n";
import { clearChatWorkspace } from "../chat/chatHistory";
import { clearDocumentIndex } from "../chat/documentIndex";
import { defaultPreferences, exportPreferences, importPreferences, type AppPreferences } from "../../shared/config/preferences";
import type { AppStore } from "../../shared/state/store";
import AppUpdateSettings from "../updates/AppUpdateSettings";

interface Props { preferences: AppPreferences; update: (patch: Partial<AppPreferences>) => void; reset: () => void; store?: AppStore; updateRequest?: number; }

type Section = "general" | "appearance" | "chat" | "server" | "advanced";
const SearchContext = createContext("");
const searchText = {
  en: { label: "Search settings", empty: "No settings match your search." },
  ko: { label: "설정 검색", empty: "검색어에 맞는 설정이 없습니다." },
  ja: { label: "設定を検索", empty: "一致する設定はありません。" },
  zh: { label: "搜索设置", empty: "没有匹配的设置。" },
};
const serverPortText = {
  en: { label: "Default server port", description: "Used the next time the default server starts. Saving keeps the current server running at its existing address.", invalid: "Enter a whole number from 1 to 65535.", current: "Current server", conflict: "The port changed elsewhere. Cancel this edit to reload the saved value." },
  ko: { label: "기본 서버 포트", description: "기본 서버를 다음에 시작할 때 적용됩니다. 저장해도 현재 서버는 기존 주소에서 계속 실행됩니다.", invalid: "1부터 65535 사이의 정수를 입력하세요.", current: "현재 서버", conflict: "다른 곳에서 포트가 변경되었습니다. 편집을 취소하여 저장된 값을 다시 불러오세요." },
  ja: { label: "既定サーバーのポート", description: "既定サーバーの次回起動時に適用します。保存しても現在のサーバーは同じアドレスで動作します。", invalid: "1から65535までの整数を入力してください。", current: "現在のサーバー", conflict: "ポートが別の場所で変更されました。編集をキャンセルして保存値を読み直してください。" },
  zh: { label: "默认服务器端口", description: "在默认服务器下次启动时应用。保存后，当前服务器仍使用原地址运行。", invalid: "请输入1到65535之间的整数。", current: "当前服务器", conflict: "端口已在其他位置更改。请取消编辑以重新加载已保存的值。" },
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
  const portCopy = serverPortText[locale];
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [portSaving, setPortSaving] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);
  const trayCopy = closeToTrayText[locale];
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
  const portBase = useRef<number | undefined>(undefined);
  const portLock = useRef(false);
  const portValue = portDraft ?? String(store?.cfg?.port ?? "");
  const portValid = /^\d+$/.test(portValue) && Number(portValue) >= 1 && Number(portValue) <= 65535;
  const savePort = async () => {
    if (!store || !portValid || portDraft === null || portLock.current) return;
    const value = Number(portValue);
    const latest = store.getConfig();
    if (!latest) return;
    if (latest.port !== portBase.current && latest.port !== value) { setPortError(portCopy.conflict); return; }
    portLock.current = true; setPortSaving(true); setPortError(null);
    try {
      await store.updateConfig({ port: value });
      setPortDraft(null); portBase.current = undefined; setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1800);
    } catch (error) { setPortError(error instanceof Error ? error.message : String(error)); }
    finally { portLock.current = false; setPortSaving(false); }
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
    { id: "chat", label: t("settings.chat") }, { id: "server", label: t("settings.server") }, { id: "advanced", label: t("settings.advanced") },
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
    <div className="settings-header"><div><div className="app-eyebrow">AioLM</div><h2>{t("settings.title")}</h2><p>{t("settings.subtitle")}</p></div><span className={`settings-save-slot ${saveState === "saved" ? "" : "is-empty"}`} role={saveState === "saved" ? "status" : undefined} aria-live={saveState === "saved" ? "polite" : undefined}>{saveState === "saved" ? <span className="app-status-badge app-status-badge--success">{t("common.saved")}</span> : "—"}</span></div>
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
        tabClassName={(isActive) => (isActive ? "is-active" : "")}
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
        </>}
        {(normalizedQuery || section === "chat") && <>
          <h3>{t("settings.chat")}</h3>
          <Row id="settings-enter-to-send" label={t("settings.enterToSend")} description={t("settings.enterToSendDesc")}>{bool("settings-enter-to-send", preferences.chat.enterToSend, (value) => toggle("enterToSend", value))}</Row>
          <Row id="settings-timestamps" label={t("settings.timestamps")} description={t("settings.timestampsDesc")}>{bool("settings-timestamps", preferences.chat.showTimestamps, (value) => toggle("showTimestamps", value))}</Row>
          <Row id="settings-stream" label={t("settings.stream")} description={t("settings.streamDesc")}>{bool("settings-stream", preferences.chat.streamResponses, (value) => toggle("streamResponses", value))}</Row>
          <Row id="settings-compact-messages" label={t("settings.compactMessages")} description={t("settings.compactMessagesDesc")}>{bool("settings-compact-messages", preferences.chat.compactMessages, (value) => toggle("compactMessages", value))}</Row>
        </>}
        {(normalizedQuery || section === "server") && <>
          <h3>{t("settings.server")}</h3>
          {store?.cfg && <Row id="settings-server-port" label={portCopy.label} description={portCopy.description}>
            <form onSubmit={event => { event.preventDefault(); void savePort(); }}>
              <div className="flex flex-wrap items-center gap-2">
                <input id="settings-server-port" className="app-input w-28" type="number" inputMode="numeric" min={1} max={65535} step={1} value={portValue}
                  aria-labelledby="settings-server-port-label" aria-describedby="settings-server-port-description settings-server-port-feedback" aria-invalid={portDraft !== null && !portValid}
                  disabled={portSaving || store.busy} onChange={event => { if (portDraft === null) portBase.current = store.getConfig()?.port; setPortDraft(event.target.value); setPortError(null); }} />
                <button type="submit" className="app-button app-button--secondary app-button--sm" disabled={portDraft === null || !portValid || portSaving || store.busy}>{portSaving ? t("common.wait") : t("common.save")}</button>
                {portDraft !== null && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={portSaving} onClick={() => { setPortDraft(null); portBase.current = undefined; setPortError(null); }}>{t("common.cancel")}</button>}
              </div>
              <div id="settings-server-port-feedback" className="mt-2 text-xs ui-color-muted">
                {portDraft !== null && !portValid && <p role="alert">{portCopy.invalid}</p>}
                {portError && <p role="alert" className="ui-color-error-ink">{normalizeDisplayText(portError)}</p>}
                {store.status.state === "running" && store.status.url && <p>{portCopy.current}: {store.status.url}</p>}
              </div>
            </form>
          </Row>}
          <Row id="settings-auto-start" label={t("settings.autoStart")} description={t("settings.autoStartDesc")}>{bool("settings-auto-start", preferences.server.autoStart, (value) => patch({ server: { ...preferences.server, autoStart: value } }))}</Row>
          {isNativeRuntimeAvailable()
            ? <div className="settings-note"><strong>{t("ui.exitCleanupTitle")}</strong><p>{t("ui.exitCleanupDescription")}</p></div>
            : <Row id="settings-auto-stop" label={t("settings.autoStop")} description={t("settings.autoStopDesc")}>{bool("settings-auto-stop", preferences.server.autoStopOnExit, (value) => patch({ server: { ...preferences.server, autoStopOnExit: value } }))}</Row>}
          {isNativeRuntimeAvailable() && store?.cfg && <Row id="settings-close-to-tray" label={trayCopy.label} description={trayCopy.description}>
            <div>
              <Switch id="settings-close-to-tray" checked={store.cfg.close_to_tray === true} disabled={traySaving || store.busy} onChange={(value) => { void saveCloseToTray(value); }} />
              {trayError && <p role="alert" className="mt-2 text-xs ui-color-error-ink">{normalizeDisplayText(trayError)}</p>}
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
          <div className="settings-danger"><strong>{t("settings.reset")}</strong><p>{t("settings.resetDesc")}</p><button type="button" className="app-button app-button--danger" onClick={() => setConfirmReset(true)}>{t("settings.resetAction")}</button></div>
          {ioError && <div className="settings-danger" role="alert"><strong>{normalizeDisplayText(ioError)}</strong></div>}
          <div className="settings-note"><strong>{t("settings.backupTitle")}</strong><p>{t("settings.backupDescription")}</p><div className="mt-3 flex flex-wrap gap-2.5"><button type="button" className="app-button app-button--secondary" onClick={downloadExport}>{t("settings.export")}</button><label className="app-button app-button--secondary cursor-pointer">{t("settings.import")}
<input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => { void importFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label><button type="button" className="app-button app-button--secondary" onClick={() => update({ chat: defaultPreferences().chat })}>{t("settings.resetChat")}</button><button type="button" className="app-button app-button--secondary" onClick={() => update({ server: defaultPreferences().server })}>{t("settings.resetServer")}</button><button type="button" className="app-button app-button--secondary" onClick={() => update({ appearance: defaultPreferences().appearance, theme: defaultPreferences().theme })}>{t("settings.resetAppearance")}</button><button type="button" className="app-button app-button--secondary" onClick={() => update({ advanced: defaultPreferences().advanced })}>{t("settings.resetAdvanced")}</button></div></div>
          <div className="settings-danger"><strong>{t("ui.wipeDataTitle")}</strong><p>{t("ui.wipeDataDescription")}</p><button type="button" className="app-button app-button--danger" disabled={wiping} onClick={() => setConfirmWipe(true)}>{t("ui.wipeDataAction")}</button></div>
          <div className="settings-note"><strong>{t("settings.nativeTitle")}</strong><p>{t("settings.nativeMessage")}</p></div>
        </>}
      </section>
      {normalizedQuery && <p className="settings-no-results" role="status">{search.empty}</p>}
      </SearchContext.Provider>
    </div>
    <div className="settings-wipe-slot">
      {wipeNotice && <div className="settings-note" role="status"><strong>{wipeNotice}</strong></div>}
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
