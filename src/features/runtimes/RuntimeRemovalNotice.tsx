import { buildNumber } from "../../shared/runtime/runtimeUtils";
import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import type { UiTextKey } from "../../shared/i18n/uiI18n";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import type { RuntimeReference, RuntimeReferenceKind } from "./runtimeReferences";

const referenceText: Record<RuntimeReferenceKind, UiTextKey> = {
  default: "runtimeRefDefault",
  profile: "runtimeRefProfile",
  session: "runtimeRefSession",
  model: "runtimeRefModel",
};

/**
 * What the user is agreeing to. Removing a build clears it from everything that
 * named it rather than repointing them at a surviving build, so the targets
 * that lose their runtime are named here instead of failing at the next launch.
 */
export default function RuntimeRemovalNotice({ t, backend, build, references }: {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  backend: string;
  build: string;
  references: RuntimeReference[];
}) {
  return (
    <div className="runtime-removal-notice">
      <p>{t("ui.removeRuntimeBody", { backend, build: buildNumber(build) })}</p>
      {references.length === 0
        ? <p className="app-section-hint">{t("ui.removeRuntimeUnused")}</p>
        : <>
            <p className="app-section-hint">{t("ui.removeRuntimeAffected")}</p>
            <ul className="runtime-removal-targets">
              {references.map(reference => <li key={`${reference.kind}:${reference.name}`}>
                {normalizeDisplayText(t(`ui.${referenceText[reference.kind]}`, { name: reference.name }))}
              </li>)}
            </ul>
            <p className="app-section-hint">{t("ui.removeRuntimeAffectedNote")}</p>
          </>}
    </div>
  );
}
