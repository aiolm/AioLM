import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import { formatBytes } from "../../shared/lib/units";
import type * as api from "../../shared/api/types";
import type { UiTextKey } from "../../shared/i18n/uiI18n";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";

/**
 * What the user is agreeing to. Building a pull request compiles and runs code
 * written by whoever opened it, so the dialog names them, the repository the
 * code actually comes from, the branch, and the exact commit — rather than
 * only the PR number the user typed, which says nothing about any of that.
 */
export default function PullRequestProvenance({ t, preview, backend }: { t: (key: UnifiedKey, vars?: TranslationVars) => string; preview: api.PullRequestPreview; backend: string }) {
  const rows: [string, string][] = [
    [t("ui.prFieldTitle"), preview.title || "—"],
    [t("ui.prFieldAuthor"), preview.author || "—"],
    [t("ui.prFieldRepository"), preview.repository],
    [t("ui.prFieldHeadRef"), preview.head_ref || "—"],
    [t("ui.prFieldCommit"), preview.commit],
    [t("ui.prFieldState"), preview.draft ? t("ui.prStateDraft", { state: preview.state }) : preview.state],
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
    <div className="space-y-3">
      <p className="text-xs text-ink">{t("ui.prConfirmBody", { pr: preview.pull_request })}</p>
      {/* Defensive: a preview from an older backend carries no advisories, and
          a crashed dialog would be a worse failure than a missing warning. */}
      {(preview.advisories ?? []).map((advisory) => (
        <p key={advisory} className={`rounded-lg border px-2.5 py-2 text-xs ${advisory === "fork" ? "border-warning-line bg-warning-soft/40 text-warning" : "app-border-strongest bg-surface/60 text-ink"}`}>
          {normalizeDisplayText(advisory === "fork" ? t("ui.prForkWarning", { repository: preview.repository }) : t(`ui.${advisoryText[advisory] ?? "prAdvisoryUnknown"}`, { advisory }))}
        </p>
      ))}
      <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0 break-all font-mono text-ink">{normalizeDisplayText(value)}</dd>
          </div>
        ))}
      </dl>
      {/* L5: say exactly what the build produces, so "build this PR" is not an
          open-ended promise. Mirrors SOURCE_BUILD_TARGETS in runtime.rs. */}
      <div className="rounded-lg border border-line-strong bg-surface/50 px-2.5 py-2">
        <p className="text-xs font-medium text-ink">{t("ui.prBuildPlanTitle")}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted">
          <li>{t("ui.prBuildPlanTargets")}</li>
          <li>{t("ui.prBuildPlanWebui")}</li>
          <li>{t("ui.prBuildPlanOffline")}</li>
          {backend === "cuda" && <li>{t("ui.prBuildPlanCuda", { variable: "AIOLM_CUDA_ARCHITECTURES" })}</li>}
        </ul>
      </div>
      {preview.artifact ? (
        <p className="rounded-lg border app-border-success bg-success-soft/40 px-2.5 py-2 text-xs text-success">
          {t("ui.prPrebuiltAvailable", {
            name: normalizeDisplayText(preview.artifact.name),
            size: formatBytes(preview.artifact.bytes),
          })}
          <span className="mt-1 block break-all font-mono text-xs text-success/70">SHA-256: {preview.artifact.sha256}</span>
        </p>
      ) : (
        <p className="rounded-lg border border-line-strong bg-surface/50 px-2.5 py-2 text-xs text-muted">{t("ui.prLocalBuildRequired")}</p>
      )}
      {preview.artifact_error && <p className="rounded-lg border border-warning-line bg-warning-soft/40 px-2.5 py-2 text-xs text-warning">{t("ui.prArtifactLookupFailed", { error: normalizeDisplayText(preview.artifact_error) })}</p>}
      <p className="text-xs text-muted">{t("ui.prReplaceNote", { pr: preview.pull_request, backend })}</p>
      {backend === "rocm" && <p className="rounded-lg border border-warning-line bg-warning-soft/40 px-2.5 py-2 text-xs text-warning">{t("ui.prRocmLocalOnly")}</p>}
      <p className="text-xs text-muted">{t("ui.prIntegrityNote")}</p>
    </div>
  );
}
