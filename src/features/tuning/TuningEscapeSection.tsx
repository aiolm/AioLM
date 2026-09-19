import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import { normalizeDisplayPathLines, normalizeDisplayText } from "../../shared/lib/displayPaths";
import TuningRawDefaults from "./TuningRawDefaults";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  disabled: boolean;
  advancedError: string | null;
  serverArgsDraft: string;
  onServerArgsChange: (value: string) => void;
  serverArgsDirty: boolean;
  onSaveServerArgs: () => void;
  chatOptionsDraft: string;
  onChatOptionsChange: (value: string) => void;
  chatOptionsDirty: boolean;
  onSaveChatOptions: () => void;
}

export default function TuningEscapeSection({
  t, disabled, advancedError, serverArgsDraft, onServerArgsChange, serverArgsDirty, onSaveServerArgs,
  chatOptionsDraft, onChatOptionsChange, chatOptionsDirty, onSaveChatOptions,
}: Props) {
  return (
    <section className="tuning-section tuning-section--escape min-w-0 app-card app-card--muted">
      <h2 className="app-section-title">{t("section.escape")}</h2>
      <p className="app-section-hint mb-4">{t("ui.escapeHint")}</p>
      <div className="tuning-advanced-error-slot mb-3">
        {advancedError && <div className="break-words rounded-lg border border-error-line bg-error-soft/50 px-3 py-2 text-sm text-error" role="alert">{normalizeDisplayText(advancedError)}</div>}
      </div>
      <div className="grid gap-5 app-form-grid">
        <div className="min-w-0">
          <label htmlFor="tuning-server-args" className="text-sm font-medium text-ink">{t("ui.serverArgsLabel")}</label>
          <textarea
            id="tuning-server-args"
            aria-label={t("ui.serverArgsLabel")}
            aria-describedby="tuning-server-args-hint"
            value={normalizeDisplayPathLines(serverArgsDraft)}
            onChange={(event) => onServerArgsChange(event.target.value)}
            disabled={disabled}
            rows={12}
            spellCheck={false}
            className="app-textarea min-h-48 font-mono text-xs"
            placeholder={'--min-p\n0.05\n--chat-template\nqwen'}
          />
          <p id="tuning-server-args-hint" className="app-section-hint">{t("ui.serverArgsHint")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onSaveServerArgs}
              disabled={!serverArgsDirty || disabled}
              className="app-button app-button--primary app-button--sm"
            >
              {t("extra.saveServerArguments")}
            </button>
            <span className="text-xs text-warning">{t("ui.restartRequiredShort")}</span>
          </div>
        </div>
        <div className="min-w-0">
          <label htmlFor="tuning-chat-options" className="text-sm font-medium text-ink">{t("ui.chatOptionsLabel")}</label>
          <textarea
            id="tuning-chat-options"
            aria-label={t("ui.chatOptionsLabel")}
            aria-describedby="tuning-chat-options-hint"
            value={chatOptionsDraft}
            onChange={(event) => onChatOptionsChange(event.target.value)}
            disabled={disabled}
            rows={12}
            spellCheck={false}
            className="app-textarea min-h-48 font-mono text-xs"
            placeholder={'{\n  "dry_sequence_breakers": ["\\n", ":"],\n  "samplers": ["dry", "top_k", "top_p", "temperature"]\n}'}
          />
          <p id="tuning-chat-options-hint" className="app-section-hint">{t("ui.chatOptionsHint")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onSaveChatOptions}
              disabled={!chatOptionsDirty || disabled}
              className="app-button app-button--primary app-button--sm"
            >
              {t("extra.saveChatOptions")}
            </button>
            <span className="text-xs text-success">{t("ui.nextMessageShort")}</span>
          </div>
        </div>
      </div>
      <TuningRawDefaults />
    </section>
  );
}
