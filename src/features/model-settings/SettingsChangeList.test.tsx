import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { parseRuntimeHelp, SERVER_OPTIONS } from '../../shared/config/serverOptions';
import SettingsChangeList, { changeCount } from './SettingsChangeList';

const runtimeOptions = parseRuntimeHelp([
  '--threads N               threads (default: 6)',
  '--top-k N                 top k (default: 41)',
].join('\n'));

describe('profile save change list', () => {
  it('shows an arrow and values for each changed option in its own row', () => {
    const saved = { chat_options: { min_p: 0.1, seed: 7 }, threads: 12, runtime_defaults: ['top_k'] };
    const current = { chat_options: { min_p: 0.2, seed: 7, max_tokens: 128 }, threads: 12,
      top_k: 40, runtime_defaults: ['threads'] };
    render(<I18nProvider initialLocale="en"><SettingsChangeList saved={saved} current={current} savedPrompt="" currentPrompt=""
      runtimeOptions={runtimeOptions} runtimeVerified /></I18nProvider>);

    const rows = screen.getAllByRole('term').map(term => term.parentElement!);
    expect(rows).toHaveLength(4);
    expect(rows.map(row => [row.querySelector('dt')?.textContent,
      row.querySelector('.settings-profile-change-before')?.textContent,
      row.querySelector('.settings-profile-change-after')?.textContent])).toEqual([
      ['Chat options · Maximum output tokens', 'None', '128'],
      ['Chat options · Min P', '0.1', '0.2'],
      ['CPU threads', '12', 'Runtime default: 6'],
      ['Top K', 'Runtime default: 41', '40'],
    ]);
    for (const row of rows) expect(row.querySelector('.settings-profile-change-arrow')).toHaveTextContent('→');
    expect(changeCount(saved, current, '', '')).toBe(rows.length);
  });

  it('separates runtime flags and distinguishes an empty JSON object from no value', () => {
    render(<I18nProvider initialLocale="en"><SettingsChangeList
      saved={{ server_args: ['--cache-ram', '1', '--jinja'], chat_options: {} }}
      current={{ server_args: ['--cache-ram', '2', '--mmap'], chat_options: { response_format: {} } }}
      savedPrompt="" currentPrompt="" runtimeOptions={[]} runtimeVerified={false}
    /></I18nProvider>);
    const rows = screen.getAllByRole('term').map(term => term.parentElement!);
    expect(rows.map(row => row.querySelector('dt')?.textContent)).toEqual([
      'Chat options · Response format',
      'Additional runtime arguments · --cache-ram',
      'Additional runtime arguments · --jinja',
      'Additional runtime arguments · --mmap',
    ]);
    expect(rows[0].querySelector('.settings-profile-change-before')).toHaveTextContent('None');
    expect(rows[0].querySelector('.settings-profile-change-after')).toHaveTextContent('{}');
    for (const row of rows) expect(row.querySelector('.settings-profile-change-arrow')).toHaveTextContent('→');
  });

  it('labels a LoRA scale change with its adapter path', () => {
    render(<I18nProvider initialLocale="en"><SettingsChangeList
      saved={{ lora_adapters: [{ path: 'models/adapter.gguf', enabled: true, scale: 0.5 }] }}
      current={{ lora_adapters: [{ path: 'models/adapter.gguf', enabled: true, scale: 0.75 }] }}
      savedPrompt="" currentPrompt="" runtimeOptions={[]} runtimeVerified={false}
    /></I18nProvider>);
    const row = screen.getByRole('term').parentElement!;
    expect(row.querySelector('dt')).toHaveTextContent('LoRA adapters · models/adapter.gguf · Scale');
    expect(row.querySelector('.settings-profile-change-before')).toHaveTextContent('0.5');
    expect(row.querySelector('.settings-profile-change-after')).toHaveTextContent('0.75');
    expect(row.querySelector('.settings-profile-change-arrow')).toHaveTextContent('→');
  });

  it('shows app values, automatic defaults, and unavailable values without using the new runtime for old settings', () => {
    const options = parseRuntimeHelp('--threads N               threads (default: -1)');
    render(<I18nProvider initialLocale="ko"><SettingsChangeList
      saved={{ active_backend: 'cpu', active_build: 'old', top_k: 40, runtime_defaults: ['top_k'] }}
      current={{ active_backend: 'vulkan', active_build: 'new', top_k: 41,
        runtime_defaults: ['threads', 'ctx_size', 'n_cpu_moe'] }}
      savedPrompt="" currentPrompt="" runtimeOptions={options} runtimeVerified
    /></I18nProvider>);
    const rows = screen.getAllByRole('term').map(term => term.parentElement!);
    const after = (label: string) => rows.find(row => row.querySelector('dt')?.textContent === label)
      ?.querySelector('.settings-profile-change-after')?.textContent;
    const before = (label: string) => rows.find(row => row.querySelector('dt')?.textContent === label)
      ?.querySelector('.settings-profile-change-before')?.textContent;
    expect(after('컨텍스트 크기')).toBe('앱 기본값: 4096');
    expect(after('CPU 스레드')).toBe('런타임 기본값: -1 (자동 선택)');
    expect(after('CPU 전문가 레이어')).toBe('런타임 기본값 (값 확인 불가)');
    expect(before('Top K')).toBe('이전 런타임 기본값 (값 확인 불가)');
  });

  it('does not present reference defaults as verified runtime values', () => {
    render(<I18nProvider initialLocale="en"><SettingsChangeList
      saved={{ top_k: 12 }} current={{ runtime_defaults: ['top_k'] }}
      savedPrompt="" currentPrompt="" runtimeOptions={SERVER_OPTIONS} runtimeVerified={false}
    /></I18nProvider>);
    expect(screen.getByText('Runtime default (value unavailable)')).toBeInTheDocument();
    expect(screen.queryByText('Runtime default: 40')).not.toBeInTheDocument();
  });
});
