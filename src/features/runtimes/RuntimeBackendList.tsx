import type * as api from "../../shared/api/types";
import type { Locale } from "../../shared/i18n/i18nCatalog";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import type { BackendRow } from "./runtimesHelpers";
import RuntimeBackendRow from "./RuntimeBackendRow";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  locale: Locale;
  visibleRows: BackendRow[];
  device: api.DeviceReport | null;
  serverRunning: boolean;
  prBusy: boolean;
  bundleBusy: boolean;
  cancelBusy: boolean;
  probeBusy: boolean;
  probeTarget: { backend: string; build: string } | null;
  onBlockedAction?: (message: string) => void;
  onCancelInstall: () => void;
  onInstall: (backend: string) => void;
  onProbe: (backend: string, build: string) => void;
  onUninstall: (backend: string, build: string) => void;
}

/** Installed and available backends as flat groups under two section headings.
 * An empty section is a single line rather than an empty box. */
export default function RuntimeBackendList({ visibleRows, ...rowProps }: Props) {
  const { t } = rowProps;
  const installedRows = visibleRows.filter((row) => row.installed.length > 0);
  const availableRows = visibleRows.filter((row) => row.installed.length === 0);
  const renderRow = (row: BackendRow) => <RuntimeBackendRow key={row.backend} row={row} {...rowProps} />;

  return <div className="runtime-list">
    <section className="runtime-section" aria-labelledby="runtime-installed-heading">
      <div className="runtime-section__heading">
        <h2 id="runtime-installed-heading">{t("ui.runtimeInstalledHeading")}</h2>
        {installedRows.length === 0 && <span className="runtime-section__empty">{t("ui.none")}</span>}
      </div>
      {installedRows.length > 0 && <div className="runtime-groups">{installedRows.map(renderRow)}</div>}
    </section>
    <section className="runtime-section" aria-labelledby="runtime-available-heading">
      <div className="runtime-section__heading">
        <h2 id="runtime-available-heading">{t("ui.runtimeAvailableHeading")}</h2>
        {availableRows.length === 0 && <span className="runtime-section__empty">{t("ui.none")}</span>}
      </div>
      {availableRows.length > 0 && <div className="runtime-groups">{availableRows.map(renderRow)}</div>}
    </section>
  </div>;
}
