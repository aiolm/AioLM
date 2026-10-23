import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickModelsDir } from '../../shared/api';
import { defaultPreferences } from '../../shared/config/preferences';
import { I18nProvider } from '../../shared/i18n/i18n';
import InitialSurface from '../../shared/ui/InitialSurface';
import { trackInitialRead } from '../../shared/ui/initialLayout';
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
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
    const paint = async () => { await act(async () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(0)); }); };
    // JSDOM does not enforce inert's native focus rejection. Model only that
    // browser boundary while exercising the real surfaces and focus effect.
    const nativeFocus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      if (!this.closest('[inert]')) nativeFocus.call(this, options);
    });
    const nested = (show: boolean) => <I18nProvider><InitialSurface>{show && <InitialSurface>
      <Onboarding preferences={defaultPreferences()} modelsDir="C:/test/models" onComplete={complete} />
    </InitialSurface>}</InitialSurface></I18nProvider>;
    const deferredView = render(nested(false));
    let release!: () => void;
    const pending = trackInitialRead(() => new Promise<void>(resolve => { release = resolve; }));
    deferredView.rerender(nested(true));
    const deferredHeading = screen.getByRole('heading', { name: 'Choose your language' });
    expect(deferredHeading).not.toHaveFocus();
    await paint(); await paint();
    expect([...deferredView.container.querySelectorAll('.initial-surface-content')].map(node => node.getAttribute('data-ready'))).toEqual(['false', 'true']);
    expect(deferredHeading).not.toHaveFocus();
    await act(async () => { release(); await pending; });
    await paint();
    expect(deferredHeading).not.toHaveFocus();
    await paint();
    expect(deferredHeading.closest('[inert]')).toBeNull();
    expect(deferredHeading).toHaveFocus();
    deferredView.unmount();

    // An already-revealed parent can receive its lazy child while a window
    // control owns focus. StrictMode replay must keep that deliberate focus.
    const existingFocus = (show: boolean) => <StrictMode><I18nProvider>
      <button type="button">Existing window control</button><InitialSurface>{show &&
        <Onboarding preferences={defaultPreferences()} modelsDir="C:/test/models" onComplete={complete} />
      }</InitialSurface></I18nProvider></StrictMode>;
    const focusedView = render(existingFocus(false));
    await paint(); await paint();
    const control = screen.getByRole('button', { name: 'Existing window control' });
    control.focus(); focusedView.rerender(existingFocus(true));
    expect(control).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(screen.getByRole('heading', { name: 'Make yourself at home' })).toHaveFocus();
    focusedView.unmount();
    expect(frames.size).toBe(0);

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
