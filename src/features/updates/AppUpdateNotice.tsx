import { useEffect } from "react";
import { useI18n } from "../../shared/i18n/i18n";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import { appUpdater, useAppUpdate } from "./appUpdater";
import { updateText } from "./updateText";

export default function AppUpdateNotice({ onOpenSettings, updater = appUpdater }: { onOpenSettings: () => void; updater?: typeof appUpdater }) {
  const state = useAppUpdate(updater);
  const { locale } = useI18n();
  const copy = updateText[locale];
  useEffect(() => { void updater.checkOnStartup(); }, [updater]);
  if (!state.info?.available || state.dismissedVersion === state.info.latest_version || state.phase === "installer-started") return null;
  return <div className="app-update-notice"><FeedbackBanner tone="info" title={copy.available}
    action={{ label: copy.open, onClick: onOpenSettings }} onDismiss={updater.dismiss}>
    {`${state.info.current_version} → ${state.info.latest_version}`}
  </FeedbackBanner></div>;
}
