import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { defaultPreferences, savePreferences } from '../../shared/config/preferences';
import { createTestStore } from '../../testing/appStore';
import ModelsPanel from './Models';

vi.mock('../model-settings/ModelSettingsProvider', () => ({ useModelSettings: () => null, MANAGE_MODEL_RUNTIMES: 'synthetic-manage-runtimes' }));
vi.mock('../../shared/api/index', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api/index')>(),
  isNativeRuntimeAvailable: () => false,
  listModels: vi.fn(async () => ({ models: [{ name: 'next.gguf', path: 'models/next.gguf', size_mb: 1, is_vision: false }], truncated: false })),
}));

describe('model library replacement launches', () => {
  beforeEach(() => {
    localStorage.clear();
    const preferences = defaultPreferences();
    preferences.advanced.confirmDestructiveActions = false;
    savePreferences(preferences);
  });

  it.each(['save', 'preflight'] as const)('preserves the running process when replacement %s fails', async failure => {
    const store = createTestStore({ active_model: 'models/current.gguf', models_dir: 'models' });
    store.status = { state: 'running', model: 'models/current.gguf' };
    if (failure === 'save') vi.mocked(store.updateConfig).mockRejectedValueOnce(new Error('Synthetic save failure'));
    else vi.mocked(store.start).mockRejectedValueOnce(new Error('Synthetic preflight failure'));
    render(<I18nProvider initialLocale="en"><ModelsPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart (switch model): next.gguf' }));
    await waitFor(() => expect(screen.getByText(new RegExp(`Synthetic ${failure} failure`))).toBeVisible());
    expect(store.stop).not.toHaveBeenCalled();
    if (failure === 'save') expect(store.start).not.toHaveBeenCalled();
    else expect(store.start).toHaveBeenCalledWith(expect.objectContaining({ active_model: 'models/next.gguf' }), true);
    expect(store.status).toMatchObject({ state: 'running', model: 'models/current.gguf' });
  });
});

describe('model library status explanations', () => {
  it.each(['failed', 'crashed'] as const)('shows the original diagnostic after the model is %s without offering unload', state => {
    const store = createTestStore({ models_dir: '' });
    store.status = { state, error: 'Synthetic engine startup diagnostic' };
    render(<I18nProvider initialLocale="ko"><ModelsPanel store={store} /></I18nProvider>);
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic engine startup diagnostic');
    expect(screen.getByRole('alert')).toHaveTextContent(state === 'failed' ? '모델 실패' : '모델 비정상 종료');
    expect(screen.queryByRole('button', { name: '모델 언로드' })).toBeNull();
    expect(store.start).not.toHaveBeenCalled();
    expect(store.stop).not.toHaveBeenCalled();
  });

  it('does not present unavailable estimates as zero memory while a different engine is running', () => {
    const store = createTestStore({ models_dir: '', active_provider: 'custom.synthetic' });
    store.status = { state: 'running', model: 'synthetic-deployment.json', memory: {
      model_mb: 2048, context_mb: 0, kv_mb: 0, projector_mb: 0, adapters_mb: 0, total_mb: 0, source: 'unknown',
    } };
    const before = structuredClone(store.status.memory);
    render(<I18nProvider initialLocale="ko"><ModelsPanel store={store} /></I18nProvider>);
    expect(screen.getByText('메모리 예상값을 확인할 수 없습니다.')).toBeVisible();
    expect(screen.queryByText(/예상 메모리: 0/)).toBeNull();
    expect(store.status.memory).toEqual(before);
  });

  it('keeps a valid zero estimate distinct from unavailable and explains automatic and disabled settings', () => {
    const store = createTestStore({ models_dir: '' });
    store.status = { state: 'running', model: 'synthetic.gguf', memory: {
      model_mb: 0, context_mb: 0, kv_mb: 0, projector_mb: 0, adapters_mb: 0, total_mb: 0, source: 'metadata',
    }, lifecycle: { parallel: 0, sleep_idle_seconds: -1, request_timeout_seconds: 60, auto_unload_due: false, active_requests: 0, idle_seconds: 0 } };
    render(<I18nProvider initialLocale="ko"><ModelsPanel store={store} /></I18nProvider>);
    expect(screen.getByText(/예상 메모리: 0.*모델 정보 기준 추정/)).toBeVisible();
    expect(screen.queryByText('메모리 예상값을 확인할 수 없습니다.')).toBeNull();
    expect(screen.getByText(/슬롯: 자동 · 유휴 절전: 사용 안 함/)).toBeVisible();
  });
});
