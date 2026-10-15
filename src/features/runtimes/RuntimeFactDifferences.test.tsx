import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import RuntimeFactDifferences from './RuntimeFactDifferences';
import { I18nProvider } from '../../shared/i18n/i18n';
import type { FactConflict, OptionSchema } from '../../shared/api/runtimeHelp';

const unknown = { value: null, certainty: 'unknown' as const };
const adapter = { kind: 'adapter', id: 'synthetic.adapter', revision: 'r1' };
const schema = (sensitive: boolean): OptionSchema => ({
  schema_version: 1,
  binding: { engine: 'custom.synthetic', runtime: 'build-1', fingerprint: 'a'.repeat(64) },
  options: [{
    key: 'fresh_amber', scope: [], spellings: [{ flag: '--fresh-amber' }], position: null,
    kind: unknown, arity: { value: { min: 1, max: 1 }, certainty: 'verified', source: adapter },
    repeatable: unknown, choices: unknown, range: unknown, unit: unknown, runtime_default: unknown,
    group: 'runtime', help: '', target: 'launch', request_field: unknown, restart_required: unknown,
    sensitive: sensitive ? { value: true, certainty: 'documented', source: adapter } : unknown,
    local_path: unknown, managed: null, raw_spans: [],
  }],
  constraints: [], raw_help: [], end_of_options: unknown,
});
const conflict = (field: string, observed: unknown, declared: unknown, key = 'fresh_amber'): FactConflict => ({
  key, flag: '--fresh-amber', field, observed, declared, declared_by: 'synthetic.adapter r1', applies: 'observed', blocking: false,
});

describe('declared fact differences', () => {
  it('hides default and choice literals of a secret option but keeps the difference visible', () => {
    render(<I18nProvider initialLocale="en"><RuntimeFactDifferences schema={schema(true)}
      conflicts={[conflict('runtime_default', { literal: 'observed-amber-synthetic' }, { literal: 'declared-amber-synthetic' }), conflict('arity', { min: 1, max: 1 }, { min: 2, max: 2 })]}
      metadata={{ adapter: 'synthetic.adapter', revision: 'r1', builtin: false, applied: [], error: null,
        conflicts: [conflict('option', null, { sensitive: true, runtime_default: { literal: 'absent-amber-synthetic' } }, '')] }} /></I18nProvider>);
    const region = screen.getByRole('region', { name: 'Option fact differences' });
    for (const literal of ['observed-amber-synthetic', 'declared-amber-synthetic', 'absent-amber-synthetic']) {
      expect(region).not.toHaveTextContent(literal);
    }
    expect(region).toHaveTextContent('runtime default');
    expect(region).toHaveTextContent('•••');
    // Value counts are not secret and stay readable.
    expect(region).toHaveTextContent('{"min":2,"max":2}');
  });

  it('shows the literals of an option nothing declares secret', () => {
    render(<I18nProvider initialLocale="en"><RuntimeFactDifferences schema={schema(false)}
      conflicts={[conflict('runtime_default', { literal: 'observed-visible' }, { literal: 'declared-visible' })]} /></I18nProvider>);
    expect(screen.getByRole('region', { name: 'Option fact differences' })).toHaveTextContent('declared-visible');
  });
});
