import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ModelBadges, { modelBadges } from './ModelBadges';
import { I18nProvider } from '../i18n/i18n';

describe('model metadata badges', () => {
  it('displays declared architectures and arbitrary tags without a family allowlist or four-tag limit', () => {
    const badges = modelBadges('Qwen3.8-Flash-Next-8B-Q8_0.gguf', {
      architecture: 'qwen4exp', size_label: '30B-A3B', quantization: 'Q4_K_M',
      expert_count: 128, expert_used_count: 8, finetune: 'Instruct', license: 'apache-2.0',
      languages: ['en', 'ko'], tags: ['reasoning', 'custom-tag'],
    }, ['gguf', 'text-generation', 'en', 'reasoning', 'qwen4exp', 'sixth-tag']);
    const values = badges.map(badge => badge.value);
    expect(values).toEqual(expect.arrayContaining(['qwen4exp', '30B-A3B', 'Q4_K_M', 'MoE', 'experts:128',
      'active-experts:8', 'Instruct', 'license:apache-2.0', 'en', 'ko', 'reasoning', 'custom-tag', 'sixth-tag']));
    expect(values).not.toContain('Qwen3.8');
    expect(values).not.toContain('8B');
    expect(values).not.toContain('Q8_0');
    expect(values.filter(value => value === 'qwen4exp')).toHaveLength(1);
    expect(values.filter(value => value === 'reasoning')).toHaveLength(1);
  });
  it('extracts name hints without interpreting parent folders as model metadata', () => {
    expect(modelBadges('C:\\models\\Gemma-27B\\Qwen3-8B-Q4_K_M-00001-of-00003.gguf')).toEqual([
      { kind: 'family', value: 'Qwen3', source: 'filename' },
      { kind: 'parameters', value: '8B', source: 'filename' },
      { kind: 'quantization', value: 'Q4_K_M', source: 'filename' },
    ]);
    expect(modelBadges('/Qwen-32B-Q8_0/unknown.gguf')).toEqual([]);
    expect(modelBadges('')).toEqual([]);
  });
  it.each([
    ['community/gemma-3-4b-it-GGUF', ['gemma-3', '4B']],
    ['Mixtral-8x7B-IQ4_XS.gguf', ['Mixtral', '8X7B', 'IQ4_XS']],
    ['EmbeddingGemma-300M-BF16.gguf', ['EmbeddingGemma', '300M', 'BF16']],
    ['mmproj-F16.gguf', ['F16', 'mmproj']],
    ['model-1.5B-MXFP4_MOE.gguf', ['1.5B', 'MXFP4_MOE']],
    ['model-Q4_K_M_custom.gguf', ['Q4_K_M']],
    ['model-TQ2_0.gguf', ['TQ2_0']],
  ])('recognizes %s', (name, values) => {
    expect(modelBadges(name).map(badge => badge.value)).toEqual(values);
  });
  it('uses the declared architecture instead of treating a filename family as architecture', () => {
    expect(modelBadges('Qwen3-8B.gguf', { architecture: 'llama', context_length: 32768 })).toEqual([
      { kind: 'architecture', value: 'llama', source: 'metadata' },
      { kind: 'parameters', value: '8B', source: 'filename' },
      { kind: 'context', value: '32K', source: 'metadata' },
    ]);
  });
  it('localizes badge descriptions and identifies the source', () => {
    render(<I18nProvider initialLocale="ko"><ModelBadges model="Qwen3-8B-Q4_K_M.gguf" metadata={{ architecture: 'qwen3' }} /></I18nProvider>);
    expect(screen.getByTitle('아키텍처: qwen3 · GGUF 메타데이터')).toBeVisible();
    expect(screen.getByTitle('양자화: Q4_K_M · 모델명에서 읽은 정보')).toBeVisible();
  });
});
