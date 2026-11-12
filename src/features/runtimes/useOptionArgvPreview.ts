import { useEffect, useMemo, useState } from 'react';
import { runtimeHelpResolve } from '../../shared/api/runtimeHelp';
import { maskPreview } from './optionPresentation';
import type { RuntimeOptionSchemaFormProps } from './RuntimeOptionSchemaForm';

export function useOptionArgvPreview({ schema, scope, values, compact = false }: Pick<RuntimeOptionSchemaFormProps, 'schema' | 'scope' | 'values' | 'compact'>) {
  const [issues, setIssues] = useState<Array<{ key: string; message: string }>>([]);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (compact) return;
    let active = true;
    setError('');
    setPreview(null);
    const timer = setTimeout(() => {
      void runtimeHelpResolve(schema, scope, values)
        .then(result => { if (active) { setIssues([]); setPreview(result.argv); } })
        .catch(cause => {
          if (!active) return;
          if (Array.isArray(cause)) { setIssues(cause as Array<{ key: string; message: string }>); setPreview([]); } else setError(String(cause));
        });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [compact, schema, scope, values]);

  const masked = useMemo(() => (preview ? maskPreview(preview, schema, values) : null), [preview, schema, values]);
  return { issues, error, masked };
}
