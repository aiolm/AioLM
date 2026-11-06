import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import { formatBytes } from "../../shared/lib/units";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import type * as api from "../../shared/api/types";
import type { UiTextKey } from "../../shared/i18n/uiI18n";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import type { Locale } from '../../shared/i18n/i18n';
import { pullRequestStateText } from '../../shared/i18n/statusDisplayCopy';

/**
 * What the user is agreeing to. Building a pull request compiles and runs code
 * written by whoever opened it, so the dialog names them, the repository the
 * code actually comes from, the branch, and the exact commit — rather than
 * only the PR number the user typed, which says nothing about any of that.
 */
export default function PullRequestProvenance({ t, locale = 'en', preview, backend }: { t: (key: UnifiedKey, vars?: TranslationVars) => string; locale?: Locale; preview: api.PullRequestPreview; backend: string }) {
  const state = pullRequestStateText(preview.state, locale);
  const rows: [string, string][] = [
    [t("ui.prFieldTitle"), preview.title || "—"],
    [t("ui.prFieldAuthor"), preview.author || "—"],
    [t("ui.prFieldRepository"), preview.repository],
    [t("ui.prFieldHeadRef"), preview.head_ref || "—"],
    [t("ui.prFieldCommit"), preview.commit],
    [t("ui.prFieldState"), preview.draft ? t("ui.prStateDraft", { state }) : state],
    [t("ui.prFieldUpdated"), preview.updated_at || "—"],
    [t("ui.prFieldBackend"), backend],
  ];
  // The backend decides which of these apply; the frontend only translates
  // them, so a new state never silently renders as nothing.
  const advisoryText: Record<api.PrAdvisory, UiTextKey> = {
    draft: "prAdvisoryDraft",
    closed: "prAdvisoryClosed",
    merged: "prAdvisoryMerged",
    // Rendered with the repository name and its own emphasis, below.
    fork: "prForkWarning",
    "no-head-ref": "prAdvisoryNoHeadRef",
  };
  return (
    <div className="runtime-provenance">
      <p>{t("ui.prConfirmBody", { pr: preview.pull_request })}</p>
      {/* Defensive: a preview from an older backend carries no advisories, and
          a crashed dialog would be a worse failure than a missing warning. */}
      {(preview.advisories ?? []).map((advisory) => (
        <FeedbackBanner key={advisory} tone={advisory === "fork" ? "warning" : "info"}>
          {normalizeDisplayText(advisory === "fork" ? t("ui.prForkWarning", { repository: preview.repository }) : t(`ui.${advisoryText[advisory] ?? "prAdvisoryUnknown"}`, { advisory }))}
        </FeedbackBanner>
      ))}
      <dl className="runtime-provenance__facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{normalizeDisplayText(value)}</dd>
          </div>
        ))}
      </dl>
      {/* L5: say exactly what the build produces, so "build this PR" is not an
          open-ended promise. Mirrors SOURCE_BUILD_TARGETS in runtime.rs. */}
      <div className="runtime-provenance__plan">
        <p className="runtime-provenance__plan-title">{t("ui.prBuildPlanTitle")}</p>
        <ul>
          <li>{t("ui.prBuildPlanTargets")}</li>
          <li>{t("ui.prBuildPlanWebui")}</li>
          <li>{t("ui.prBuildPlanOffline")}</li>
          {backend === "cuda" && <li>{t("ui.prBuildPlanCuda", { variable: "AIOLM_CUDA_ARCHITECTURES" })}</li>}
        </ul>
      </div>
      {preview.artifact ? (
        <FeedbackBanner tone="success">
          {t("ui.prPrebuiltAvailable", {
            name: normalizeDisplayText(preview.artifact.name),
            size: formatBytes(preview.artifact.bytes),
          })}
          <span className="runtime-provenance__digest">SHA-256: {preview.artifact.sha256}</span>
        </FeedbackBanner>
      ) : (
        <FeedbackBanner tone="info">{t("ui.prLocalBuildRequired")}</FeedbackBanner>
      )}
      {preview.artifact_error && <FeedbackBanner tone="warning">{t("ui.prArtifactLookupFailed", { error: normalizeDisplayText(preview.artifact_error) })}</FeedbackBanner>}
      <p className="app-section-hint">{t("ui.prReplaceNote", { pr: preview.pull_request, backend })}</p>
      {backend === "rocm" && <FeedbackBanner tone="warning">{t("ui.prRocmLocalOnly")}</FeedbackBanner>}
      <p className="app-section-hint">{t("ui.prIntegrityNote")}</p>
    </div>
  );
}
