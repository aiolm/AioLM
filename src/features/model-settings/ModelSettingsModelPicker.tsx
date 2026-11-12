import * as api from '../../shared/api';
import { type Locale } from '../../shared/i18n/i18n';
import { normalizeDisplayPath, normalizeDisplayText } from '../../shared/lib/displayPaths';
import { formatMebibytes } from '../../shared/lib/units';
import Badge from '../../shared/ui/Badge';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import ModelBadges, { unknownFormat } from '../../shared/ui/ModelBadges';
import ModelIcon from '../../shared/ui/ModelIcon';
import './model-settings.css';
import type { ModelSettingsDialogController } from './useModelSettingsDialogController';
const modalityLabel: Record<Locale, Record<string, string>> = {
  en: { text: 'text', image: 'image', audio: 'audio', video: 'video' },
  ko: { text: '텍스트', image: '이미지', audio: '오디오', video: '비디오' },
  ja: { text: 'テキスト', image: '画像', audio: '音声', video: '動画' },
  zh: { text: '文本', image: '图像', audio: '音频', video: '视频' },
};
export default function ModelSettingsModelPicker({ controller }: { controller: ModelSettingsDialogController }) {
  const { t, locale, copy, help, id, cfg, provider, section, query, setQuery, pathDraft, setPathDraft, catalog, selectedMetadata, enteredPath, pathImeHandlers, pathPending, chooseModel, models } = controller;
  return (
            <div hidden={section !== 'model'} className="model-settings-fields">
              <div className="model-settings-section-heading"><h3>{copy.model}</h3><button type="button" className="app-button app-button--ghost app-button--sm" data-icon="refresh" onClick={catalog.refresh}>{copy.refresh}</button></div>
              <p id={`${id}-model-help`} className="app-section-hint">{help.model}</p>
              {api.isExternalProvider(provider) && <p className="app-section-hint">{catalog.selection?.source === 'runtime-bindings' ? copy.runtimeBindings : copy.unverifiedCatalog}</p>}
              {catalog.selection?.source === 'runtime-bindings' && <button type="button" className="app-button app-button--secondary" onClick={catalog.exploreLibrary}>{copy.exploreModels}</button>}
              <input type="search" className="app-input" value={query} onChange={event => setQuery(event.target.value)} placeholder={copy.search} aria-label={copy.search} />
              {catalog.error && <FeedbackBanner tone="error">{normalizeDisplayText(catalog.error)}</FeedbackBanner>}
              {catalog.loading && <p role="status">{t('extra.loading')}</p>}
              {catalog.truncated && <p role="status">{copy.truncated}</p>}
              <ul className="model-settings-models">{models.map(model => <li key={model.path}><button type="button" onKeyDown={event => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                const buttons = Array.from(event.currentTarget.closest('ul')!.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
                event.preventDefault(); buttons[next]?.focus();
              }} className={`app-list-row${cfg.active_model === model.path ? ' is-selected' : ''}`} disabled={!!model.shards?.missing.length || !!model.artifact?.incomplete || !!model.artifact?.missing.length}
                onClick={() => chooseModel(model.path)} aria-describedby={`${id}-model-help`} aria-pressed={cfg.active_model === model.path} title={normalizeDisplayPath(model.path)}><span><strong><ModelIcon model={model.name} />{normalizeDisplayText(model.name)}</strong><ModelBadges mode="compact" model={model.name} localPath={model.path === cfg.active_model ? undefined : model.path} metadata={model.path === cfg.active_model ? selectedMetadata : undefined} artifact={model.artifact} /><small>{model.artifact?.format === 'unknown' ? unknownFormat[locale] : model.artifact?.format} · {model.artifact ? Object.entries(model.artifact.modalities).filter(([, enabled]) => enabled).map(([name]) => Object.prototype.hasOwnProperty.call(modalityLabel[locale], name) ? modalityLabel[locale][name] : name).join(", ") : ""} · {model.artifact?.format === 'unknown' ? '—' : formatMebibytes(model.size_mb)}{model.shards?.missing.length ? ` · ${t('ui.modelShardsMissing', { count: model.shards.missing.length, total: model.shards.total })}` : ''}</small>{api.isExternalProvider(provider) && !api.modelLoadable(model, provider) && <small>{copy.unverifiedModel}</small>}</span>{cfg.active_model === model.path && <Badge tone="info">{copy.selected}</Badge>}</button></li>)}</ul>
              {!catalog.loading && !models.length && <p className="app-section-hint">{copy.empty}</p>}
              <label>{copy.path}<input className="app-input" aria-label={copy.path} aria-describedby={`${id}-path-help`} value={pathDraft} onChange={event => setPathDraft(event.target.value)} {...pathImeHandlers} /><span id={`${id}-path-help`} className="app-section-hint">{api.isExternalProvider(provider) ? copy.externalModelPath : help.path}</span></label>
              {pathPending && <button type="button" className="app-button app-button--secondary" disabled={!pathDraft.trim()} data-icon="open" onClick={() => chooseModel(enteredPath)}>{copy.load}</button>}
            </div>
  );
}
