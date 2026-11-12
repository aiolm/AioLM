import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { runtimeHelpImport, type ImportedPlan, type OptionSchema } from '../../shared/api/runtimeHelp';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import { JsonOptionNumberError } from '../../shared/runtime/jsonOptionNumbers';
import { applyPlan, ImportedIntegerPrecisionError } from './optionOrder';
import { maskImportReview } from './optionPresentation';
import type { RuntimeOptionSchemaFormProps } from './RuntimeOptionSchemaForm';

interface ImportRequestOwner { schema: OptionSchema; scopeKey: string; text: string }

export function useOptionCommandImport({ schema, scope, values, onChange, readOnlyForOption }: Pick<RuntimeOptionSchemaFormProps, 'schema' | 'scope' | 'values' | 'onChange' | 'readOnlyForOption'>, copy: (typeof runtimeOptionsCopy)['en']) {
  const [paste, setPaste] = useState('');
  const [acceptedImport, setAcceptedImport] = useState<{ request: ImportRequestOwner; result: ImportedPlan } | null>(null);
  const [failedImport, setFailedImport] = useState<{ request: ImportRequestOwner; message: string } | null>(null);
  const activeImport = useRef<ImportRequestOwner | null>(null);
  const scopeKey = JSON.stringify(scope);
  const importOwner = useRef({ schema, scopeKey, text: paste });
  const matchesRenderedOwner = (request: ImportRequestOwner) => request.schema === schema && request.scopeKey === scopeKey && request.text === paste;
  const ownsImport = (request: ImportRequestOwner) => activeImport.current === request
    && request.schema === importOwner.current.schema && request.scopeKey === importOwner.current.scopeKey && request.text === importOwner.current.text;
  const imported = acceptedImport && matchesRenderedOwner(acceptedImport.request) ? acceptedImport.result : null;
  const importError = failedImport && matchesRenderedOwner(failedImport.request) ? failedImport.message : '';

  useLayoutEffect(() => { importOwner.current = { schema, scopeKey, text: paste }; }, [schema, scopeKey, paste]);
  useLayoutEffect(() => {
    // A changed owner hides stale data during render and then releases it.
    // Equal scope contents and unrelated saved-value edits retain the import.
    setAcceptedImport(current => current && (current.request.schema !== schema || current.request.scopeKey !== scopeKey) ? null : current);
    setFailedImport(current => current && (current.request.schema !== schema || current.request.scopeKey !== scopeKey) ? null : current);
    return () => {
      // An older owner's cleanup must not invalidate a newer request.
      if (activeImport.current?.schema === schema && activeImport.current.scopeKey === scopeKey) activeImport.current = null;
    };
  }, [schema, scopeKey]);

  const reviewedImport = useMemo(() => imported ? maskImportReview(imported, schema, values) : null, [imported, schema, values]);
  const changePaste = (text: string) => {
    activeImport.current = null; setAcceptedImport(null); setFailedImport(null); setPaste(text);
  };
  const readCommand = () => {
    const request = { schema, scopeKey, text: paste };
    activeImport.current = request;
    setAcceptedImport(null); setFailedImport(null);
    void runtimeHelpImport(schema, scope, paste)
      .then(result => { if (ownsImport(request)) setAcceptedImport({ request, result }); })
      .catch(cause => {
        if (!ownsImport(request)) return;
        setAcceptedImport(null); setFailedImport({ request, message: cause instanceof Error ? cause.message : String(cause) });
      });
  };
  const applyImport = () => {
    if (!acceptedImport || !ownsImport(acceptedImport.request)) return;
    const plan = readOnlyForOption ? acceptedImport.result.plan.filter(item => {
      const option = schema.options.find(option => option.key === item.key);
      return !option || !readOnlyForOption(option);
    }) : acceptedImport.result.plan;
    try { onChange(applyPlan(schema, values, { plan })); } catch (cause) { setFailedImport({ request: acceptedImport.request, message: cause instanceof ImportedIntegerPrecisionError ? copy.importIntegerPrecision : cause instanceof JsonOptionNumberError ? copy.jsonNumberRange : cause instanceof Error ? cause.message : String(cause) }); }
  };
  return { paste, imported, reviewedImport, importError, changePaste, readCommand, applyImport };
}
