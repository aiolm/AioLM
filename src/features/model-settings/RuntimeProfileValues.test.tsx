import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api';
import type { EffectiveSchema } from '../../shared/api/runtimeHelp';
import { I18nProvider } from '../../shared/i18n/i18n';
import { testConfig } from '../../testing/appStore';
import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';
import RuntimeProfileValues from './RuntimeProfileValues';
import { useProfileRuntimeSchema } from './useProfileRuntimeSchema';
import { StrictMode } from 'react';
import { notifyRuntimeInventoryChanged } from '../../shared/runtime/runtimeInventoryEvents';
import { getTaskSnapshot, removeTask } from '../../shared/state/taskRegistry';

beforeEach(() => vi.restoreAllMocks());
afterEach(() => { for (const task of getTaskSnapshot()) removeTask(task.id); });

const option = schemaOption({ key: 'limit', flag: '--limit', target: 'launch', group: 'unfamiliar', kind: { type: 'integer' }, runtime_default: '0' });
const config = { ...testConfig, active_provider: 'custom.profile', active_runtime: 'first', provider_options: { 'custom.profile': { limit: 0, forgotten: 'UNKNOWN-PRIVATE' } } } satisfies api.AppConfig;
function View({ cfg, reference = false, enabled = true }: { cfg: api.AppConfig; reference?: boolean; enabled?: boolean }) {
  const schema = useProfileRuntimeSchema(cfg, enabled);
  return <I18nProvider initialLocale="en"><RuntimeProfileValues config={cfg} provider={api.providerOf(cfg)} settings={cfg} mode={reference ? 'reference' : 'current'} schema={schema} /></I18nProvider>;
}

describe('runtime profile projection', () => {
  it('keeps stale runtime defaults read-only without offering runtime help mutations', async () => {
    vi.spyOn(api, 'providerOptionSchema').mockResolvedValue(effectiveSchema([], [option], { help_state: 'stale' }));
    render(<View cfg={config} reference />);
    await screen.findByText(/Check that the saved options are supported/);
    expect(screen.queryByRole('button', { name: 'Recheck options' })).not.toBeInTheDocument();
  });
  it('shares one pending verification across effect replay and rechecks an installation replaced under the same id', async () => {
    let finish!: (view: EffectiveSchema) => void;
    const read = vi.spyOn(api, 'providerOptionSchema').mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(effectiveSchema([], [{ ...option, spellings: [{ flag: '--replacement-limit' }] }]));
    render(<StrictMode><View cfg={config} /></StrictMode>);
    expect(read).toHaveBeenCalledOnce();
    await act(async () => finish(effectiveSchema([], [option])));
    expect(await screen.findByText('--limit')).toBeVisible();
    act(() => notifyRuntimeInventoryChanged());
    expect(screen.queryByText('--limit')).not.toBeInTheDocument();
    expect(await screen.findByText('--replacement-limit')).toBeVisible();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('keeps the checked schema while profile values change instead of restarting runtime verification', async () => {
    const read = vi.spyOn(api, 'providerOptionSchema').mockResolvedValue(effectiveSchema([], [option]));
    const { rerender } = render(<View cfg={config} />);
    expect(await screen.findByText('--limit')).toBeVisible();
    rerender(<View cfg={{ ...config, request_timeout_seconds: 42, provider_options: { 'custom.profile': { limit: 9 } } }} />);
    expect(screen.getByText('--limit')).toBeVisible();
    expect(screen.getByText('9')).toBeVisible();
    expect(screen.queryByText(/Checking the options available/)).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledOnce();
  });
  it('finishes the original verification when a profile edit arrives before its answer', async () => {
    let finish!: (view: EffectiveSchema) => void;
    const read = vi.spyOn(api, 'providerOptionSchema').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<View cfg={config} />);
    rerender(<View cfg={{ ...config, provider_options: { 'custom.profile': { limit: 7 } } }} />);
    await act(async () => finish(effectiveSchema([], [option])));
    expect(await screen.findByText('--limit')).toBeVisible();
    expect(screen.getByText('7')).toBeVisible();
    expect(read).toHaveBeenCalledOnce();
  });
  it('rejects a late schema after a runtime switch and hides unverifiable saved values', async () => {
    let first!: (view: EffectiveSchema) => void; let second!: (view: EffectiveSchema) => void;
    vi.spyOn(api, 'providerOptionSchema').mockImplementationOnce(() => new Promise(resolve => { first = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
    const { container, rerender } = render(<View cfg={config} />);
    expect(container).not.toHaveTextContent('UNKNOWN-PRIVATE');
    rerender(<View cfg={{ ...config, active_runtime: 'second' }} />);
    await act(async () => first(effectiveSchema([], [{ ...option, spellings: [{ flag: '--old-limit' }] }])));
    expect(screen.queryByText('--old-limit')).not.toBeInTheDocument();
    await act(async () => second(effectiveSchema([], [option])));
    expect(await screen.findByText('--limit')).toBeVisible();
    expect(container).not.toHaveTextContent('UNKNOWN-PRIVATE');
  });
  it('recovers from schema failure without guessing values or changing the saved config', async () => {
    const read = vi.spyOn(api, 'providerOptionSchema').mockRejectedValueOnce(new Error('PRIVATE-BACKEND-DIAGNOSTIC')).mockResolvedValueOnce(effectiveSchema([], [option]));
    const before = structuredClone(config);
    const { container } = render(<View cfg={config} />);
    expect(await screen.findByText(/Could not check/)).toBeVisible();
    expect(container).not.toHaveTextContent('PRIVATE-BACKEND-DIAGNOSTIC');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('--limit')).toBeVisible();
    expect(screen.getByText('0')).toBeVisible();
    expect(read).toHaveBeenCalledTimes(2); expect(config).toEqual(before);
  });
  it('recovers stale options only after explicit discovery and acceptance, preserving saved values after a failed attempt', async () => {
    const before = structuredClone(config);
    const stale = effectiveSchema([], [option], { help_state: 'stale' });
    const current = effectiveSchema([], [option]);
    let accepted = false;
    vi.spyOn(api, 'providerOptionSchema').mockImplementation(async () => accepted ? current : stale);
    vi.spyOn(api, 'runtimeHelpTarget').mockResolvedValue({
      engine: config.active_provider, runtime: config.active_runtime, program: 'synthetic-engine',
      fixed: true, prefix: [], request: { args: ['--help'], scope: [] },
    });
    const identity = { fingerprint: 'a'.repeat(64), executable_sha256: 'b'.repeat(64), artifacts_sha256: {}, parser_version: 1 };
    const discover = vi.spyOn(api, 'runtimeHelpDiscoverSelected').mockRejectedValueOnce(new Error('Synthetic help command failed'))
      .mockResolvedValueOnce([{
        identity, scope: [], stdout: { text: '', clean_text: '', encoding: 'utf-8', decoding_loss: false, truncated: false },
        stderr: { text: '', clean_text: '', encoding: 'utf-8', decoding_loss: false, truncated: false },
        success: true, cancelled: false, timed_out: false, elapsed_ms: 1,
      }, {
        engine: config.active_provider, runtime: config.active_runtime, fingerprint: identity.fingerprint,
        help_complete: true, schema: current.schema, retained: ['forgotten'],
        diff: { added: [], removed: [], changed: [], retained_unknown: ['forgotten'] },
      }]);
    const accept = vi.spyOn(api, 'runtimeHelpAccept').mockImplementation(async () => {
      accepted = true;
      return { version: 1, fingerprint: identity.fingerprint, request: { args: ['--help'], scope: [] } };
    });
    vi.spyOn(api, 'runtimeHelpCancelSelected').mockResolvedValue(true);
    const { container } = render(<View cfg={config} />);
    const recheck = await screen.findByRole('button', { name: 'Recheck options' });
    await waitFor(() => expect(recheck).not.toHaveAttribute('aria-disabled', 'true'));
    expect(discover).not.toHaveBeenCalled();
    fireEvent.click(recheck);
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic help command failed');
    expect(screen.queryByText('--limit')).not.toBeInTheDocument();
    expect(accept).not.toHaveBeenCalled();
    fireEvent.click(recheck);
    const acceptButton = await screen.findByRole('button', { name: 'Use these options' });
    expect(accept).not.toHaveBeenCalled();
    fireEvent.click(acceptButton);
    expect(await screen.findByText('--limit')).toBeVisible();
    expect(screen.getByText('0')).toBeVisible();
    expect(recheck).toHaveFocus();
    expect(container).not.toHaveTextContent('UNKNOWN-PRIVATE');
    expect(config).toEqual(before);
  });
  it('keeps stale help, reserved arguments and other subcommands out of confirmed options', async () => {
    const variants = [option, { ...option, key: 'reserved', managed: 'reserved' as const }, { ...option, key: 'elsewhere', scope: ['other'] }];
    const read = vi.spyOn(api, 'providerOptionSchema').mockResolvedValueOnce(effectiveSchema([], variants, { help_state: 'stale' }));
    const cfg = { ...config, provider_options: { 'custom.profile': { limit: 12, reserved: 'RESERVED-PRIVATE', elsewhere: 'SCOPED-PRIVATE' } } };
    const { container, rerender } = render(<View cfg={cfg} />);
    expect(await screen.findByRole('button', { name: 'Recheck options' })).toBeVisible();
    expect(screen.queryByText('--limit')).not.toBeInTheDocument();
    read.mockResolvedValueOnce(effectiveSchema([], variants));
    rerender(<View cfg={{ ...cfg, active_runtime: 'reviewed' }} />);
    expect(await screen.findByText('--limit')).toBeVisible();
    expect(container).not.toHaveTextContent('RESERVED-PRIVATE'); expect(container).not.toHaveTextContent('SCOPED-PRIVATE');
    expect(screen.getAllByText(/Needs a compatibility check/)).toHaveLength(2);
  });
  it('shows declared zero defaults and preserves masking across occurrences and duplicated values', async () => {
    const secret = { ...option, key: 'credential', spellings: [{ flag: '--credential' }], sensitive: { certainty: 'documented' as const, value: true },
      runtime_default: { certainty: 'documented' as const, value: { literal: 'PRIVATE-DEFAULT' } } };
    const note = { ...option, key: 'note', spellings: [{ flag: '--note' }] };
    vi.spyOn(api, 'providerOptionSchema').mockResolvedValue(effectiveSchema([], [option, secret, note]));
    const { container, rerender } = render(<View reference cfg={config} />);
    expect(await screen.findByText('--limit')).toBeVisible();
    expect(screen.getAllByText('0')).toHaveLength(2);
    rerender(<View cfg={{ ...config, provider_options: { 'custom.profile': {
      credential: { occurrences: [['SECRET-OCCURRENCE']], spelling: null }, note: 'prefix SECRET-OCCURRENCE suffix', limit: false,
    } } }} />);
    await waitFor(() => expect(screen.getByText('--note')).toBeVisible());
    expect(container).not.toHaveTextContent('SECRET-OCCURRENCE');
    expect(screen.getByText('Off')).toBeVisible();
  });
  it('rechecks the same runtime on workspace reentry instead of reusing old help facts', async () => {
    let finish!: (view: EffectiveSchema) => void;
    const read = vi.spyOn(api, 'providerOptionSchema').mockResolvedValueOnce(effectiveSchema([], [option]))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<View cfg={config} />);
    expect(await screen.findByText('--limit')).toBeVisible();
    rerender(<View cfg={config} enabled={false} />);
    rerender(<View cfg={config} />);
    expect(screen.queryByText('--limit')).not.toBeInTheDocument();
    await act(async () => finish(effectiveSchema([], [{ ...option, spellings: [{ flag: '--new-limit' }] }])));
    expect(await screen.findByText('--new-limit')).toBeVisible();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
