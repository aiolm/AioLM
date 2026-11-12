import type { CSSProperties } from 'react';
import type { OptionSchemaDefinition } from '../../shared/api/runtimeHelp';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import { OccurrenceOrder } from './OccurrenceOrder';
import { SchemaOptionField } from './SchemaOptionField';
import { needsWideCard } from './SchemaOptionValueInput';
import { setOccurrenceSpelling } from './optionOrder';
import type { useRuntimeOptionSchemaForm } from './useRuntimeOptionSchemaForm';

type Controller = ReturnType<typeof useRuntimeOptionSchemaForm>;

function isApplicable(option: OptionSchemaDefinition, scope: string[]): boolean {
  return option.scope.length <= scope.length && option.scope.every((segment, index) => scope[index] === segment);
}

/** Items past the first screenful skip layout until scrolled near view. */
const DEFERRED_FROM = 12;
const deferredStyle: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto none auto 96px' };

export function RuntimeOptionSchemaFormView({ controller }: { controller: Controller }) {
  const { schema, values, scope, disabled, onChange, compact, showAll, showNoMatch,
    readOnlyForOption, inheritLabel, hint, onInvalid, onConfirmSyntax, confirmSyntaxFor,
    copy, formId, search, group, groups, limit, visible, changeSearch, changeGroup, showMore,
    issues, error, masked, order, rowSpellings, unknownKeys, issueDescriptions, update } = controller;

  const fields = (showAll ? visible : visible.slice(0, limit)).map((option, index) => (
    <div key={option.key} className={needsWideCard(option) ? 'schema-option-grid__wide' : undefined} style={index >= DEFERRED_FROM ? deferredStyle : undefined}>
      <SchemaOptionField option={option} stored={values[option.key]} disabled={disabled} readOnly={readOnlyForOption?.(option)} applicable={isApplicable(option, scope)}
        inheritLabel={inheritLabel?.(option)} hint={hint?.(option)} validationDescription={issueDescriptions.get(option.key)} onStore={(next, origins) => update(option.key, next, origins)} onInvalid={onInvalid}
        rowSpellings={rowSpellings.get(option.key)}
        onRowSpelling={order.ok ? (row, flag) => onChange(setOccurrenceSpelling(schema, values, option.key, row, flag)) : undefined}
        onConfirmSyntax={onConfirmSyntax && (!confirmSyntaxFor || confirmSyntaxFor(option)) ? syntax => onConfirmSyntax(option, syntax) : undefined} />
    </div>
  ));
  const navigation = (
        <fieldset className="schema-option-filter">
          <legend>{copy.legend}</legend>
          <label htmlFor={`${formId}-search`}>{copy.search}
            <input id={`${formId}-search`} name="schema-search" className="app-input" type="search" value={search}
              autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => changeSearch(event.target.value)} />
          </label>
          <label>{copy.group}
            <CustomSelect ariaLabel={copy.group} value={group} disabled={disabled}
              options={[{ value: '', label: copy.allGroups }, ...groups.map(name => ({ value: name, label: name }))]} onChange={changeGroup} />
          </label>
        </fieldset>
  );
  const more = !showAll && visible.length > limit && <button type="button" className="app-button app-button--secondary" disabled={disabled}
    onClick={showMore}>{copy.more} ({visible.length - limit})</button>;
  const fieldGrid = fields.length > 0 && <div className="schema-option-grid">{fields}</div>;
  if (compact) return <div className="model-settings-fields schema-option-form">{navigation}{fieldGrid}{more}{showNoMatch && visible.length === 0 && <p>{copy.noMatch}</p>}</div>;

  return (
    <div className="model-settings-fields schema-option-form">
      {navigation}
      {issues.map((issue, index) => <div key={`${issue.key}:${index}`} id={`${formId}-issue-${index}`}><FeedbackBanner tone="error">{issue.message}</FeedbackBanner></div>)}
      {unknownKeys.map(key => (
        <FeedbackBanner key={key} tone="error">
          {key} {copy.unknownKey}
          <button type="button" disabled={disabled} className="app-button app-button--secondary" onClick={() => update(key, undefined)}>{copy.remove}</button>
        </FeedbackBanner>
      ))}
      {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
      {fieldGrid}
      <OccurrenceOrder schema={schema} values={values} disabled={disabled} onChange={onChange} />
      {more}
      {showNoMatch && visible.length === 0 && <p className="app-section-hint">{copy.noMatch}</p>}
      <CommandImport controller={controller} />
      <div aria-live="polite">
        <h4>{copy.preview}</h4>
        {masked === null ? <p className="app-section-hint">{copy.previewPending}</p>
          : <pre className="overflow-auto whitespace-pre-wrap">{masked.map(token => JSON.stringify(token)).join(' ')}</pre>}
      </div>
    </div>
  );
}

function CommandImport({ controller }: { controller: Controller }) {
  const { copy, formId, disabled, commandImport } = controller;
  const { paste, imported, reviewedImport, importError, changePaste, readCommand, applyImport } = commandImport;
  return (
      <details>
        <summary>{copy.importTitle}</summary>
        <label htmlFor={`${formId}-import`}>{copy.importLabel}</label>
        <textarea id={`${formId}-import`} name="schema-import" className="app-textarea" value={paste} disabled={disabled}
          autoCorrect="off" autoCapitalize="off" spellCheck={false}
          onChange={event => changePaste(event.target.value)} />
        <div className="app-page-actions mt-3">
          <button type="button" className="app-button app-button--secondary" disabled={disabled || !paste.trim()}
            onClick={readCommand}>{copy.split}</button>
          {imported && (
            <button type="button" className="app-button app-button--secondary" disabled={disabled}
              onClick={applyImport}>{copy.apply}</button>
          )}
        </div>
        {importError && <FeedbackBanner tone="error">{importError}</FeedbackBanner>}
        {imported && reviewedImport && (
          <div>
            <p className="app-section-hint">{copy.planOrder}: {imported.plan.map(item => item.key).join(', ') || '—'}</p>
            <p className="app-section-hint">{copy.groupedNote}</p>
            {reviewedImport.managed.length > 0 && <FeedbackBanner tone="warning">{copy.importManaged}: {reviewedImport.managed.join(' ')}</FeedbackBanner>}
            {reviewedImport.unrecognized.length > 0 && <FeedbackBanner tone="warning">{copy.importUnknown}: {reviewedImport.unrecognized.join(' ')}</FeedbackBanner>}
          </div>
        )}
      </details>
  );
}
