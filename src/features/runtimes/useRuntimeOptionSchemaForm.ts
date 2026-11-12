import { useId, useMemo } from 'react';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import { editOption, expandPlan, ORDER_KEY, readOrder } from './optionOrder';
import type { RuntimeOptionSchemaFormProps } from './RuntimeOptionSchemaForm';
import { useOptionArgvPreview } from './useOptionArgvPreview';
import { useOptionCommandImport } from './useOptionCommandImport';
import { useSchemaOptionPagination } from './useSchemaOptionPagination';

export function useRuntimeOptionSchemaForm(props: RuntimeOptionSchemaFormProps) {
  const { schema, values, onChange, validationDescriptions, disabled = false, compact = false, showAll = false, showNoMatch = true } = props;
  const { locale } = useI18n();
  const copy = runtimeOptionsCopy[locale];
  const formId = useId();
  const pagination = useSchemaOptionPagination(props);
  const { issues, error, masked } = useOptionArgvPreview(props);
  const commandImport = useOptionCommandImport(props, copy);
  const schemaKeys = useMemo(() => new Set(schema.options.map(option => option.key)), [schema]);

  // Field edits keep a saved order record consistent: occurrence positions
  // and per-occurrence aliases follow the edited rows.
  const update = (key: string, next: unknown, origins?: Array<number | null>) => onChange(editOption(schema, values, key, next, origins));
  const order = useMemo(() => readOrder(values), [values]);
  const rowSpellings = useMemo(() => {
    const byKey = new Map<string, Array<string | null>>();
    if (!order.ok || !order.order) return byKey;
    for (const item of expandPlan(schema, values, order.order)) {
      const spellings = byKey.get(item.key);
      if (spellings) spellings.push(item.spelling ?? null);
      else byKey.set(item.key, [item.spelling ?? null]);
    }
    return byKey;
  }, [order, schema, values]);
  const unknownKeys = useMemo(() => Object.keys(values).filter(key => key !== ORDER_KEY && !schemaKeys.has(key)), [schemaKeys, values]);

  const issueDescriptions = useMemo(() => {
    const descriptions = new Map(validationDescriptions);
    issues.forEach((issue, index) => descriptions.set(issue.key, [descriptions.get(issue.key), `${formId}-issue-${index}`].filter(Boolean).join(' ')));
    return descriptions;
  }, [validationDescriptions, issues, formId]);

  return {
    ...props,
    disabled, compact, showAll, showNoMatch,
    ...pagination,
    copy, formId, issues, error, masked, commandImport,
    order, rowSpellings, unknownKeys, issueDescriptions, update,
  };
}
