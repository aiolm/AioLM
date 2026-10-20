import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, useI18n } from '../../shared/i18n/i18n';
import { testConfig } from '../../testing/appStore';
import type { AppConfig } from '../../shared/api/types';
import type { ServerTextKey } from './tuningFields';
import TuningServerSection from './TuningServerSection';
import TuningReasoningSection from './TuningReasoningSection';

function ServerView({ cfg, updateFlash, onServerTextChange, commitServerText }: {
  cfg: AppConfig;
  updateFlash: (value: string) => void;
  onServerTextChange: (key: ServerTextKey, value: string) => void;
  commitServerText: (key: ServerTextKey, value: string) => void;
}) {
  const { t } = useI18n();
  return <TuningServerSection
    t={t}
    cfg={cfg}
    disabled={false}
    numericDrafts={{}}
    onNumericChange={vi.fn()}
    onNumericCommit={vi.fn()}
    updateFlash={updateFlash}
    serverTextValue={key => cfg[key]}
    onServerTextChange={onServerTextChange}
    commitServerText={commitServerText}
    projectorEditable={false}
    serverSelectValue={() => 'custom'}
    selectServerText={vi.fn()}
    fields={[]}
    showFlashAttention
    showCacheTypes
    showProjector={false}
    showSpeculative={false}
    showDraftBindings={false}
  />;
}

function ReasoningView({ cfg, updateServerText }: { cfg: AppConfig; updateServerText: (key: 'reasoning' | 'reasoning_format' | 'reasoning_preserve', value: string) => void }) {
  const { t } = useI18n();
  return <TuningReasoningSection
    t={t}
    cfg={cfg}
    disabled={false}
    numericDrafts={{}}
    onNumericChange={vi.fn()}
    onNumericCommit={vi.fn()}
    updateServerText={updateServerText}
    updateReasoningEffort={vi.fn()}
    reasoningBudgetMessageValue=""
    onReasoningBudgetMessageChange={vi.fn()}
    onReasoningBudgetMessageCommit={vi.fn()}
  />;
}

describe('fixed tuning values', () => {
  it('keeps raw cache and Flash values visible until an explicit selection', () => {
    const rawFlash = '\u001b[31mfuture-flash\u001b[0m';
    const cfg = { ...testConfig, cache_type_k: 'k+v', cache_type_v: 'future-v', flash_attn: rawFlash };
    const updateFlash = vi.fn();
    const onServerTextChange = vi.fn();
    const commitServerText = vi.fn();
    const { rerender } = render(<I18nProvider initialLocale="en"><ServerView cfg={cfg} updateFlash={updateFlash} onServerTextChange={onServerTextChange} commitServerText={commitServerText} /></I18nProvider>);

    expect(screen.getByRole('combobox', { name: 'Flash attention' })).toHaveTextContent('future-flash');
    expect(screen.getByRole('combobox', { name: 'Cache type K' })).toHaveTextContent('k+v');
    expect(screen.getByRole('combobox', { name: 'Cache type V' })).toHaveTextContent('future-v');
    rerender(<I18nProvider initialLocale="en"><ServerView cfg={{ ...cfg, flash_attn: rawFlash }} updateFlash={updateFlash} onServerTextChange={onServerTextChange} commitServerText={commitServerText} /></I18nProvider>);
    expect(updateFlash).not.toHaveBeenCalled();
    expect(onServerTextChange).not.toHaveBeenCalled();
    expect(commitServerText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('combobox', { name: 'Flash attention' }));
    fireEvent.click(screen.getByRole('option', { name: 'on' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Cache type K' }));
    fireEvent.click(screen.getByRole('option', { name: 'f32' }));
    expect(updateFlash).toHaveBeenCalledWith('on');
    expect(onServerTextChange).toHaveBeenCalledWith('cache_type_k', 'f32');
    expect(commitServerText).toHaveBeenCalledWith('cache_type_k', 'f32');
  });

  it('keeps an unknown reasoning format visible and commits only an explicit known value', () => {
    const rawFormat = '\u001b[32mfuture-reasoning\u001b[0m';
    const updateServerText = vi.fn();
    render(<I18nProvider initialLocale="en"><ReasoningView cfg={{ ...testConfig, reasoning: 'off', reasoning_format: rawFormat, reasoning_preserve: 'off', reasoning_effort: 'none' }} updateServerText={updateServerText} /></I18nProvider>);

    expect(screen.getByRole('combobox', { name: 'Reasoning format' })).toHaveTextContent('future-reasoning');
    expect(screen.getByRole('combobox', { name: 'Reasoning mode' })).toHaveTextContent('off');
    expect(screen.getByRole('combobox', { name: 'Preserve reasoning' })).toHaveTextContent('off');
    expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveTextContent('none');
    expect(updateServerText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('combobox', { name: 'Reasoning format' }));
    fireEvent.click(screen.getByRole('option', { name: 'deepseek' }));
    expect(updateServerText).toHaveBeenCalledWith('reasoning_format', 'deepseek');
  });
});
