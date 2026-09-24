import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickModelsDir } from '../../shared/api';
import { defaultPreferences } from '../../shared/config/preferences';
import { I18nProvider } from '../../shared/i18n/i18n';
import Onboarding from './Onboarding';

vi.mock('../../shared/api', () => ({ pickModelsDir: vi.fn() }));

const complete = vi.fn();
function mount() {
  return render(<I18nProvider><Onboarding preferences={defaultPreferences()} modelsDir="C:/test/models" onComplete={complete} /></I18nProvider>);
}
function goToFolder() {
  fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
  fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
}

describe('First-run setup', () => {
  beforeEach(() => { localStorage.clear(); complete.mockReset().mockResolvedValue(undefined); vi.mocked(pickModelsDir).mockReset().mockResolvedValue(null); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('starts in English and translates every subsequent step immediately after language selection', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('ko-KR');
    mount();
    expect(screen.getByRole('heading', { name: 'Choose your language' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'English' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: '한국어' }));
    expect(screen.getByRole('heading', { name: '언어를 선택하세요' })).toBeVisible();
    expect(document.documentElement).toHaveAttribute('lang', 'ko');
    fireEvent.click(screen.getByRole('button', { name: /계속/ }));
    expect(screen.getByRole('heading', { name: '편안한 테마를 선택하세요' })).toHaveFocus();
    fireEvent.click(screen.getByRole('radio', { name: /어두운 테마/ }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    fireEvent.click(screen.getByRole('button', { name: '이전' }));
    expect(screen.getByRole('radio', { name: '한국어' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /계속/ }));
    expect(screen.getByRole('radio', { name: /어두운 테마/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /계속/ }));
    expect(screen.getByRole('textbox', { name: '모델 폴더' })).toHaveValue('C:/test/models');
    expect(complete).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /AioLM 시작하기/ })); });
    expect(complete).toHaveBeenCalledWith({ locale: 'ko', theme: 'dark', modelsDir: 'C:/test/models' });
  });

  it('retains the folder after picker cancellation and supports restoring the default', async () => {
    mount(); goToFolder();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Choose folder' })); });
    expect(screen.getByRole('textbox')).toHaveValue('C:/test/models');
    vi.mocked(pickModelsDir).mockResolvedValueOnce('D:/test/library');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Choose folder' })); });
    expect(screen.getByRole('textbox')).toHaveValue('D:/test/library');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(screen.getByRole('textbox')).toHaveValue('D:/test/library');
    fireEvent.click(screen.getByRole('button', { name: 'Use default folder' }));
    expect(screen.getByRole('textbox')).toHaveValue('C:/test/models');
  });

  it('keeps the chosen folder when saving fails and prevents duplicate submissions while retrying', async () => {
    complete.mockRejectedValueOnce(new Error('disk full'));
    mount(); goToFolder();
    vi.mocked(pickModelsDir).mockResolvedValueOnce('D:/test/library');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Choose folder' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start using AioLM/ })); });
    expect(screen.getByRole('alert')).toHaveTextContent('disk full');
    expect(screen.getByRole('textbox')).toHaveValue('D:/test/library');
    let finish!: () => void;
    complete.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: /Start using AioLM/ }));
    expect(screen.getByRole('button', { name: /Saving/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('form'));
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenLastCalledWith({ locale: 'en', theme: 'system', modelsDir: 'D:/test/library' });
    await act(async () => { finish(); });
  });

  it('shows a retryable picker error without completing setup', async () => {
    vi.mocked(pickModelsDir).mockRejectedValueOnce(new Error('picker unavailable'));
    mount(); goToFolder();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Choose folder' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('picker unavailable');
    expect(screen.getByRole('textbox')).toHaveValue('C:/test/models');
    expect(complete).not.toHaveBeenCalled();
  });
});
