import ModelBadges from '../../shared/ui/ModelBadges';
import ModelIcon from '../../shared/ui/ModelIcon';
import { useRef, useState } from "react";
import type { AppStore } from "../../shared/state/store";
import { useI18n } from "../../shared/i18n/i18n";
import { readLoadingProfiles, writeLoadingProfiles, type LoadingProfile } from "../../shared/runtime/runtimeUtils";
import { modelDisplayName, normalizeDisplayText } from "../../shared/lib/displayPaths";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import { useDraftGuard } from '../../shared/state/draftGuard';

/** Existing launch presets stay usable; new presets use the shared profile manager. */
export default function RuntimeLoadingProfiles({ store, disabled }: { store: AppStore; disabled: boolean }) {
  const { t } = useI18n();
  const guard = useDraftGuard();
  const [profiles, setProfiles] = useState(readLoadingProfiles);
  const [pending, setPending] = useState<LoadingProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = async (profile: LoadingProfile) => {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const applied = await guard.run(async () => { await store.updateConfig({ active_backend: profile.backend, active_build: profile.build, active_model: profile.active_model, mmproj: profile.mmproj, ctx_size: profile.ctx_size, ngl: profile.ngl, threads: profile.threads, flash_attn: profile.flash_attn }); });
      if (!applied) return;
      setNotice(t("ui.appliedProfileNamed", { name: profile.name }));
      setError(null);
    } catch (cause) { setError(String(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  if (!profiles.length) return null;
  return <details className="legacy-profiles">
    <summary>{t("ui.legacyProfiles")} · {profiles.length}</summary>
    <p>{t("ui.legacyProfilesHint")}</p>
    {notice && <FeedbackBanner tone="success">{notice}</FeedbackBanner>}
    {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
    {profiles.map((profile) => <div key={profile.id} className="legacy-profile-row"><div><strong>{normalizeDisplayText(profile.name)}</strong><p>{normalizeDisplayText(profile.backend)} · {normalizeDisplayText(profile.build)} · <ModelIcon model={profile.active_model} />{modelDisplayName(profile.active_model)}<ModelBadges model={profile.active_model} localPath={profile.active_model} /></p></div><button type="button" className="app-button app-button--secondary" disabled={disabled || busy} onClick={() => void apply(profile)}>{t("ui.loadSavedProfile")}</button><button type="button" className="app-button app-button--ghost" disabled={busy} aria-label={`${t("panel.delete")}: ${normalizeDisplayText(profile.name)}`} onClick={() => setPending(profile)}>{t("panel.delete")}</button></div>)}
    <ConfirmDialog open={!!pending} title={t("ui.profileDeleteTitle")} description={normalizeDisplayText(pending?.name ?? "")} confirmLabel={t("panel.delete")} onConfirm={() => { const next = profiles.filter((profile) => profile.id !== pending?.id); writeLoadingProfiles(next); setProfiles(next); setPending(null); }} onCancel={() => setPending(null)} />
  </details>;
}
