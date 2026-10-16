import { describe, expect, it } from 'vitest';
import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';
import type { CommandEntry, OptionSchemaDefinition } from '../../shared/api/runtimeHelp';
import { sensitiveEntryTokenStrings, sensitiveStaticIndices } from './sensitiveEntryTokens';
import { maskImportReview, maskPreview } from './RuntimeOptionSchemaForm';

const SECRET = 'synthetic-entry-amber-9152';
const PLAIN = 'plain-token';

const entry: CommandEntry = {
  version: 1, program: '/synthetic/engine', prefix: ['-I', 'engine.py', 'serve', SECRET, PLAIN],
  layout: { version: 1, subcommands: [2], options: [{ index: 0, values: 0 }] },
  positional_bindings: ['model'],
};

function slot(key: string, position: number, sensitive: OptionSchemaDefinition['sensitive']): OptionSchemaDefinition {
  return { ...schemaOption({ key, target: 'launch', group: 'options', kind: { type: 'text' } }), position, managed: 'discovery', sensitive, help: `${key} help` };
}

const known = { value: true as const, certainty: 'documented' as const, source: { kind: 'adapter' as const, id: 'synthetic.role', revision: '1' } };

describe('sensitive entry tokens', () => {
  it('collects the exact prefix index a known-sensitive static role names', () => {
    const slots = [slot('marker', 2, known)];
    const effective = effectiveSchema([], slots, {
      entry,
      supplement: { fingerprint: 'a'.repeat(64), current: true, applied: ['marker'], conflicts: [], options: { marker: { positional: { role: 'static', index: 3 } } } },
    });
    expect(sensitiveStaticIndices(effective)).toEqual(new Set([3]));
    expect(sensitiveEntryTokenStrings(effective)).toEqual([SECRET]);
  });

  it('keeps stale known-sensitive roles covering the display without applying them', () => {
    const slots = [slot('marker', 0, known)];
    const effective = effectiveSchema([], slots, {
      entry,
      accepted_fingerprint: 'b'.repeat(64),
      help_state: 'stale',
      supplement: { fingerprint: 'a'.repeat(64), current: false, applied: [], conflicts: [],
        options: { marker: { positional: { role: 'static', index: 3 } } } },
    });
    expect(sensitiveEntryTokenStrings(effective)).toEqual([SECRET]);
  });

  it('ignores unknown certainty, non-sensitive slots and out-of-range indices', () => {
    const slots = [
      slot('guess', 0, { value: true as const, certainty: 'unknown' as const }),
      slot('open', 1, { value: null, certainty: 'unknown' as const }),
      slot('marker', 2, known),
    ];
    const effective = effectiveSchema([], slots, {
      entry,
      supplement: { fingerprint: 'a'.repeat(64), current: true, applied: [], conflicts: [], options: {
        guess: { positional: { role: 'static', index: 4 } },
        open: { positional: { role: 'static', index: 4 } },
        marker: { positional: { role: 'static', index: 99 } },
      } },
    });
    expect(sensitiveEntryTokenStrings(effective)).toEqual([]);
  });

  it('masks entry secrets in preview argv without touching stored values', () => {
    const slots = [slot('marker', 2, known)];
    const effective = effectiveSchema([], slots, {
      entry,
      supplement: { fingerprint: 'a'.repeat(64), current: true, applied: ['marker'], conflicts: [], options: { marker: { positional: { role: 'static', index: 3 } } } },
    });
    const secrets = sensitiveEntryTokenStrings(effective);
    const argv = ['/synthetic/engine', '-I', 'engine.py', 'serve', SECRET, PLAIN, `--token=${SECRET}`];
    const values = {};
    const before = structuredClone({ argv, values });
    const masked = maskPreview(argv, effective.schema, values, secrets);
    expect(masked).toEqual(['/synthetic/engine', '-I', 'engine.py', 'serve', '•••', PLAIN, '--token=•••']);
    expect({ argv, values }).toEqual(before);
  });

  it('masks entry secrets in import review projections while keeping pasted bytes', () => {
    const slots = [slot('marker', 2, known)];
    const effective = effectiveSchema([], slots, {
      entry,
      supplement: { fingerprint: 'a'.repeat(64), current: true, applied: ['marker'], conflicts: [], options: { marker: { positional: { role: 'static', index: 3 } } } },
    });
    const secrets = sensitiveEntryTokenStrings(effective);
    const imported = { plan: [], managed: ['serve', SECRET], unrecognized: [`--x=${SECRET}`] };
    const review = maskImportReview(imported, effective.schema, {}, secrets);
    expect(review.managed).toEqual(['serve', '•••']);
    expect(review.unrecognized).toEqual(['--x=•••']);
    expect(imported.managed).toEqual(['serve', SECRET]);
  });
});
