import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '../../shared/api';
import { I18nProvider } from '../../shared/i18n/i18n';
import { testConfig } from '../../testing/appStore';
import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';
import type { CommandEntry, OptionSchemaDefinition } from '../../shared/api/runtimeHelp';
import RuntimeHelpReview from './RuntimeHelpReview';

vi.mock('../../shared/api', async origin => ({
  ...await origin<typeof import('../../shared/api')>(),
  runtimeHelpTarget: vi.fn(), runtimeHelpDiscoverSelected: vi.fn(),
  runtimeHelpCancelSelected: vi.fn(async () => true), runtimeHelpAccept: vi.fn(),
  pickRuntimePath: vi.fn(),
}));

const SECRET = 'synthetic-role-amber-8431';
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
const unknown = { value: true as const, certainty: 'unknown' as const };

const cfg = { ...testConfig, active_provider: 'custom.synthetic' as const, active_runtime: 'build-1' };

function targetFor(prefix: string[]) {
  return {
    engine: cfg.active_provider, runtime: cfg.active_runtime, program: '/synthetic/engine', fixed: false,
    prefix, request: { args: [...prefix, '--help'], scope: [] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.runtimeHelpTarget).mockImplementation(async () => targetFor(entry.prefix));
  vi.mocked(api.runtimeHelpDiscoverSelected).mockResolvedValue([
    {
      identity: { fingerprint: 'a'.repeat(64), executable_sha256: 'b'.repeat(64), artifacts_sha256: {}, parser_version: 1 },
      scope: [], stdout: { text: '', clean_text: '', encoding: 'utf-8', decoding_loss: false, truncated: false },
      stderr: { text: '', clean_text: '', encoding: 'utf-8', decoding_loss: false, truncated: false },
      success: true, cancelled: false, timed_out: false, exit_code: 0, elapsed_ms: 1,
    },
    {
      engine: 'custom.synthetic', runtime: 'build-1', fingerprint: 'a'.repeat(64),
      help_complete: true, schema: effectiveSchema([]).schema, retained: [],
    },
  ]);
});

function view(effective: ReturnType<typeof effectiveSchema>) {
  return <I18nProvider initialLocale="en"><RuntimeHelpReview cfg={cfg} effective={effective} disabled={false} onAccepted={vi.fn()} /></I18nProvider>;
}

it('hides a current known-sensitive static entry token from the command display', async () => {
  const slots = [slot('input', 0, { value: null, certainty: 'unknown' }), slot('marker', 2, known)];
  const effective = effectiveSchema([], slots, {
    entry,
    supplement: { fingerprint: 'a'.repeat(64), current: true, applied: ['marker'], conflicts: [], options: { marker: { positional: { role: 'static', index: 3 } } } },
  });
  render(view(effective));
  await waitFor(() => expect(screen.getByText(/Help command/)).toBeInTheDocument());
  expect(document.body).not.toHaveTextContent(SECRET);
  expect(screen.getByText(/Help command/)).toHaveTextContent('•••');
  // Neighbouring plain tokens stay visible: no over-masking.
  expect(screen.getByText(/Help command/)).toHaveTextContent(PLAIN);
  expect(screen.getByText(/Help command/)).toHaveTextContent('serve');
});

it('hides a stale known-sensitive static entry token without applying its role', async () => {
  const slots = [slot('marker', 0, known), slot('other', 1, { value: null, certainty: 'unknown' })];
  const effective = effectiveSchema([], slots, {
    entry,
    accepted_fingerprint: 'b'.repeat(64),
    help_state: 'stale',
    supplement: { fingerprint: 'a'.repeat(64), current: false, applied: [], conflicts: [],
      options: { marker: { positional: { role: 'static', index: 3 } } } },
  });
  render(view(effective));
  await waitFor(() => expect(screen.getByText(/Help command/)).toBeInTheDocument());
  expect(document.body).not.toHaveTextContent(SECRET);
  expect(screen.getByText(/Help command/)).toHaveTextContent('•••');
  expect(screen.getByText(/Help command/)).toHaveTextContent(PLAIN);
});

it('keeps an unknown-certainty token visible instead of guessing it sensitive', async () => {
  const slots = [slot('marker', 0, unknown)];
  const effective = effectiveSchema([], slots, {
    entry,
    supplement: { fingerprint: 'a'.repeat(64), current: true, applied: [], conflicts: [], options: { marker: { positional: { role: 'static', index: 3 } } } },
  });
  render(view(effective));
  await waitFor(() => expect(screen.getByText(/Help command/)).toBeInTheDocument());
  expect(screen.getByText(/Help command/)).toHaveTextContent(SECRET);
});

it('keeps the program path visible: it is not prefix index 0', async () => {
  const slots = [slot('marker', 0, known)];
  const programEntry: CommandEntry = { ...entry, program: '/synthetic/engine' };
  const effective = effectiveSchema([], slots, {
    entry: programEntry,
    supplement: { fingerprint: 'a'.repeat(64), current: true, applied: ['marker'], conflicts: [], options: { marker: { positional: { role: 'static', index: 3 } } } },
  });
  render(view(effective));
  await waitFor(() => expect(screen.getByText(/Help command/)).toBeInTheDocument());
  expect(screen.getByText(/Help command/)).toHaveTextContent('/synthetic/engine');
  expect(document.body).not.toHaveTextContent(SECRET);
});
