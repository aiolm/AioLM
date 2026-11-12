// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadLocale } from '../i18n/i18nUnified';
import { lifecycleErrorMessage } from './serverLifecycle';
import { IpcError } from '../api/ipcError';

describe('localized lifecycle errors', () => {
  it.each([
    [new IpcError('busy', 'Finish or stop the active response before loading a model'), 'Finish or stop the active response, then try again.'],
    ['startup timed out', 'The operation timed out.'],
    ['address already in use', 'The configured port is already in use.'],
    ['executable not found', 'The runtime executable could not be found.'],
    ['invalid model file', 'The selected model could not be loaded.'],
    ['CUDA out of memory', 'There is not enough available memory or VRAM'],
    ['unexpected runtime failure', 'Check the runtime log shown with this error'],
  ])('keeps the existing English diagnosis for %s', (detail, hint) => {
    const error = typeof detail === 'string' ? new Error(detail) : detail;
    const message = lifecycleErrorMessage('start', error, 'en');
    expect(message).toMatch(/^Model load failed: /);
    expect(message).toContain(hint);
    expect(message).toContain(` (${detail})`);
  });

  it('uses native busy and timeout kinds even when their messages do not name the diagnosis', () => {
    expect(lifecycleErrorMessage('start', new IpcError('busy', 'operation in progress'), 'en'))
      .toBe('Model load failed: Another model or runtime operation is in progress. Wait for it to finish, then try again. (operation in progress)');
    expect(lifecycleErrorMessage('start', new IpcError('timeout', 'readiness deadline reached'), 'en'))
      .toBe('Model load failed: The operation timed out. Check the runtime log shown with this error and try again. (readiness deadline reached)');
  });

  it.each([
    ['ko', '모델 언로드 실패', '이 설정에 필요한 메모리 또는 VRAM이 부족합니다.'],
    ['ja', 'モデルのアンロードに失敗しました', 'この設定に必要なメモリまたはVRAMが不足しています。'],
    ['zh', '模型卸载失败', '可用内存或显存不足以支持此配置。'],
  ] as const)('translates %s guidance but retains the original runtime detail', async (locale, prefix, hint) => {
    await loadLocale(locale);
    expect(lifecycleErrorMessage('stop', new Error('CUDA out of memory'), locale))
      .toBe(`${prefix}: ${hint} (CUDA out of memory)`);
  });

  it('does not add empty diagnostic parentheses', () => {
    expect(lifecycleErrorMessage('start', '', 'en'))
      .toBe('Model load failed: Check the runtime log shown with this error and retry after correcting the issue.');
  });
});
