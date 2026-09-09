import { useRef, useState } from "react";
import type { AppConfig } from "../api";
import type { AppStore } from "../store";
import { useI18n } from "../i18n";
import ConfirmDialog from "../components/ConfirmDialog";
import FeedbackBanner from "../components/FeedbackBanner";
import { isServerBusy } from "../lifecycleUtils";
import {
  createModelProfile, createServerProfile, deleteModelProfile, deleteServerProfile,
  duplicateModelProfile, duplicateServerProfile, loadProfiles, modelProfilePatch,
  profileDirtyFields, saveModelProfile, saveProfileSelection, saveServerProfile, serverProfilePatch,
} from "../modelProfiles";
import { REQUEST_DEFAULT_KEYS } from "../tuningDefaults";
import RuntimeLoadingProfiles from "./RuntimeLoadingProfiles";

type Props = { store: AppStore; modelPath: string; onOpenTuning?: () => void };
type Kind = "server" | "model";

/** Presets capture the canonical tuning form; they never host a second editor. */
export default function ExecutionProfiles(props: Props) {
  if (!props.store.cfg) return null;
  return <ProfileManager key={props.modelPath} {...props} cfg={props.store.cfg} />;
}

function ProfileManager({ store, modelPath, onOpenTuning, cfg }: Props & { cfg: AppConfig }) {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState(() => loadProfiles(cfg, modelPath));
  const [serverId, setServerId] = useState(profiles.activeServerId);
  const [modelId, setModelId] = useState(profiles.activeModelId);
  const [nameDraft, setNameDraft] = useState("");
  const [editing, setEditing] = useState<{ kind: Kind; action: "create" | "rename" } | null>(null);
  const [pending, setPending] = useState<{ kind: Kind; action: "save" | "delete" } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const inFlight = useRef(false);
  const server = profiles.server.find((item) => item.id === serverId) ?? profiles.server[0];
  const model = profiles.model.find((item) => item.id === modelId) ?? profiles.model[0];
  const disabled = store.busy || applying || store.status.state === "starting" || store.status.state === "stopping";

  const refresh = () => setProfiles(loadProfiles(cfg, modelPath));
  const select = (kind: Kind, id: string) => {
    // Choosing a preset previews it. Only Load changes config or future model selection.
    if (kind === "server") setServerId(id); else setModelId(id);
    setEditing(null);
    setNotice(null);
  };
  const capture = (kind: Kind, name: string, id?: string) => {
    if (kind === "server") {
      const next = { ...createServerProfile(cfg, name), ...(id ? { id } : {}) };
      saveServerProfile(next);
      setServerId(next.id);
      saveProfileSelection(next.id, modelPath, profiles.activeModelId);
    } else {
      const next = { ...createModelProfile(cfg, name), ...(id ? { id } : {}), system_prompt: model.system_prompt };
      saveModelProfile(next);
      setModelId(next.id);
      saveProfileSelection(profiles.activeServerId, modelPath, next.id);
    }
    refresh();
    setNotice(t(kind === "server" ? "ui.profileServerSaved" : "ui.profileModelSaved"));
  };
  const saveName = () => {
    if (!editing || !nameDraft.trim()) return;
    const { kind, action } = editing;
    if (action === "create") capture(kind, nameDraft.trim());
    else {
      if (kind === "server") saveServerProfile({ ...server, name: nameDraft.trim() });
      else saveModelProfile({ ...model, name: nameDraft.trim() });
      refresh();
    }
    setEditing(null);
  };
  const apply = async (kind: Kind) => {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setApplying(true);
    setError(null);
    try {
      await store.updateConfig((current) => ({
        ...(kind === "server" ? serverProfilePatch(server) : modelProfilePatch(model)),
        runtime_defaults: [
          ...(current.runtime_defaults ?? []).filter((key) => REQUEST_DEFAULT_KEYS.includes(key) === (kind === "server")),
          ...((kind === "server" ? server : model).runtime_defaults ?? []),
        ],
      }));
      saveProfileSelection(kind === "server" ? server.id : profiles.activeServerId, modelPath, kind === "model" ? model.id : profiles.activeModelId);
      refresh();
      setNotice(t("ui.profileAppliedNotice"));
    } catch (cause) {
      setError(t("ui.profileApplyFailedNotice", { message: cause instanceof Error ? cause.message : String(cause) }));
    } finally { inFlight.current = false; setApplying(false); }
  };
  const confirm = () => {
    if (!pending) return;
    const { kind, action } = pending;
    const profile = kind === "server" ? server : model;
    if (action === "save") capture(kind, profile.name, profile.id);
    else {
      if (kind === "server") deleteServerProfile(server.id);
      else deleteModelProfile(model.id);
      refresh();
    }
    setPending(null);
  };

  return <section className="profiles-page" data-testid="execution-profiles-section">
    <header className="workspace-page-heading">
      <div><h2>{t("ui.executionProfiles")}</h2><p>{t("ui.profilesSingleEditorHint")}</p></div>
      {onOpenTuning && <button type="button" onClick={onOpenTuning} className="app-button app-button--secondary">{t("ui.editTuning")}</button>}
    </header>
    {error && <FeedbackBanner tone="error" onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
    {notice && <FeedbackBanner tone="success" onDismiss={() => setNotice(null)}>{notice}</FeedbackBanner>}
    <div className="profile-snapshot-grid">
      {(["server", "model"] as const).map((kind) => {
        const profile = kind === "server" ? server : model;
        const items = kind === "server" ? profiles.server : profiles.model;
        const blocked = disabled;
        const differs = profileDirtyFields(profile, cfg).length > 0;
        return <section className="profile-snapshot" key={kind}>
          <h3>{t(kind === "server" ? "ui.serverProfile" : "ui.modelTuningProfile")}</h3>
          <p className="profile-snapshot-hint">{t(kind === "server" ? "ui.serverSnapshotHint" : "ui.modelSnapshotHint")}</p>
          <p className="profile-model-name">{kind === "server" ? `${server.backend} · ${server.build || "PATH"}` : t("ui.sharedAcrossModels")}</p>
          <label htmlFor={`${kind}-snapshot-picker`} className="sr-only">{t(kind === "server" ? "ui.selectServerProfile" : "ui.selectModelProfile")}</label>
          <select id={`${kind}-snapshot-picker`} value={profile.id} disabled={blocked} className="app-input app-select" onChange={(event) => select(kind, event.target.value)}>
            {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <span className="profile-snapshot-status">{t(differs ? "ui.profileDiffers" : "ui.profileMatches")}</span>
          <div className="profile-snapshot-actions">
            <button type="button" disabled={blocked} className="app-button app-button--primary" onClick={() => void apply(kind)}>{t("ui.loadSavedProfile")}</button>
            <button type="button" disabled={blocked || !differs} className="app-button app-button--secondary" onClick={() => setPending({ kind, action: "save" })}>{t("ui.saveCurrent")}</button>
          </div>
          <div className="profile-snapshot-actions">
            <button type="button" disabled={blocked} className="app-button app-button--ghost app-button--sm" onClick={() => { setEditing({ kind, action: "create" }); setNameDraft(""); }}>{t("ui.newProfile")}</button>
            <details className="profile-manage">
              <summary className="app-button app-button--ghost app-button--sm">{t("ui.manageProfile")}</summary>
              <div className="profile-snapshot-actions">
                <button type="button" disabled={blocked} className="app-button app-button--secondary app-button--sm" onClick={() => { setEditing({ kind, action: "rename" }); setNameDraft(profile.name); }}>{t("ui.renameProfile")}</button>
                <button type="button" disabled={blocked} className="app-button app-button--secondary app-button--sm" onClick={() => { select(kind, kind === "server" ? duplicateServerProfile(server).id : duplicateModelProfile(model).id); refresh(); }}>{t("ui.duplicateProfile")}</button>
                <button type="button" disabled={blocked || items.length <= 1} className="app-button app-button--danger app-button--sm" onClick={() => setPending({ kind, action: "delete" })}>{t("ui.deleteProfile")}</button>
              </div>
            </details>
          </div>
          {editing?.kind === kind && <form className="profile-name-form" onSubmit={(event) => { event.preventDefault(); saveName(); }}>
            <label htmlFor={`${kind}-snapshot-name`}>{t("ui.profileNamePlaceholder")}</label>
            <input id={`${kind}-snapshot-name`} className="app-input" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} required maxLength={120} />
            <div className="profile-snapshot-actions"><button type="submit" disabled={blocked || !nameDraft.trim()} className="app-button app-button--primary">{t("ui.saveProfile")}</button><button type="button" onClick={() => setEditing(null)} className="app-button app-button--secondary">{t("common.cancel")}</button></div>
          </form>}
          {kind === "model" && <details className="profile-default-prompt"><summary>{t("ui.modelDefaultPrompt")}</summary><label htmlFor="profile-default-prompt" className="sr-only">{t("ui.modelDefaultPrompt")}</label><textarea id="profile-default-prompt" key={model.id} defaultValue={model.system_prompt} disabled={blocked} rows={3} className="app-textarea" onBlur={(event) => { if (event.target.value !== model.system_prompt) { saveModelProfile({ ...model, system_prompt: event.target.value }); refresh(); setNotice(t("ui.profileModelSaved")); } }} /><p>{t("ui.modelDefaultPromptHint")}</p></details>}
        </section>;
      })}
    </div>
    <RuntimeLoadingProfiles store={store} disabled={disabled || isServerBusy(store.status.state)} />
    <ConfirmDialog open={pending !== null} title={t(pending?.action === "save" ? "ui.replaceProfileTitle" : "ui.profileDeleteTitle")} description={t(pending?.action === "save" ? "ui.replaceProfileBody" : "ui.profileDeleteBody")} confirmLabel={t(pending?.action === "save" ? "ui.saveCurrent" : "ui.deleteProfile")} tone={pending?.action === "save" ? "primary" : "danger"} busy={disabled} onConfirm={confirm} onCancel={() => setPending(null)} />
  </section>;
}
