import { describe, expect, it } from 'vitest';
import { describeServerOption, SERVER_OPTIONS } from '../config/serverOptions';
import { serverOptionDescription, serverOptionDescriptions } from './serverOptionDescriptions';
import { optionDefaultText } from './optionDefaultText';

describe('localized server option help', () => {
  it('preserves dotted option names and their switch arity', () => {
    const option = describeServerOption('--fim-qwen-1.5b-default', 'Use a model preset.')!;
    expect(option.id).toBe('--fim-qwen-1.5b-default');
    expect(option.flags).toEqual(['--fim-qwen-1.5b-default']);
    expect(option.arity).toBe(0);
  });

  it('covers every bundled option with Korean, Japanese and Chinese descriptions', () => {
    for (const option of SERVER_OPTIONS) {
      const translations = serverOptionDescriptions[option.id];
      expect(translations, option.id).toBeDefined();
      expect(translations[0], option.id).toMatch(/[가-힣]/);
      expect(translations[1], option.id).toMatch(/[ぁ-んァ-ン一-龯]/);
      expect(translations[2], option.id).toMatch(/[一-龯]/);
    }
  });

  it('resolves runtime aliases and does not use English prose for an unknown localized option', () => {
    const alias = describeServerOption('--n-gpu-layers N', 'English runtime explanation')!;
    expect(serverOptionDescription(alias, 'ko')).toBe(serverOptionDescription(SERVER_OPTIONS.find(option => option.flags.includes('--n-gpu-layers'))!, 'ko'));
    const unknown = describeServerOption('--future-option VALUE', 'New English runtime help.')!;
    expect(serverOptionDescription(unknown, 'en')).toBe(unknown.description);
    expect(serverOptionDescription(unknown, 'ko')).toMatch(/번역된 설명/);
    expect(serverOptionDescription(unknown, 'ja')).toMatch(/翻訳/);
    expect(serverOptionDescription(unknown, 'zh')).toMatch(/翻译/);
  });

  it('translates default qualifications without changing numbers, option names or literal values', () => {
    expect(optionDefaultText('8192, -1 = unlimited', 'ko')).toBe('8192, -1 = 제한 없음');
    expect(optionDefaultText('0, 0 = loaded from model', 'ja')).toBe('0, 0 = モデルから読み込む');
    expect(optionDefaultText('same as --threads', 'zh')).toBe('与 --threads 相同');
    expect(optionDefaultText("'auto'", 'ko')).toBe("'auto'");
    expect(optionDefaultText('f16', 'ko')).toBe('f16');
    expect(optionDefaultText('0.95, 1.0 = disabled', 'en')).toBe('0.95, 1.0 = disabled');
  });
});
