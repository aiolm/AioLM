import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/i18n';
import Tooltip from './Tooltip';
import ConfirmDialog from './ConfirmDialog';

describe('shared path presentation', () => {
  it('cleans help text and accessible labels in a portaled tooltip', () => {
    const raw = String.raw`\\?\C:\models\model.gguf`;
    render(<I18nProvider initialLocale="en"><Tooltip label={`Help for ${raw}`}
      content={{ title: raw, description: `Open ${raw}` }} /></I18nProvider>);
    fireEvent.focus(screen.getByRole('button', { name: String.raw`Help for C:\models\model.gguf` }));
    expect(screen.getByRole('tooltip')).toHaveTextContent(String.raw`Open C:\models\model.gguf`);
    expect(screen.getByRole('tooltip').textContent).not.toContain('\\\\?\\');
  });

  it('cleans a confirmation title and description while the action keeps the original path', () => {
    const raw = String.raw`\\?\UNC\server\share\model.gguf`;
    const action = vi.fn();
    render(<I18nProvider initialLocale="en"><ConfirmDialog open title={`Open ${raw}`}
      description={`Continue with ${raw}`} onConfirm={() => action(raw)} onCancel={vi.fn()} /></I18nProvider>);
    const dialog = screen.getByRole('dialog', { name: String.raw`Open \\server\share\model.gguf` });
    expect(dialog).toHaveAccessibleDescription(String.raw`Continue with \\server\share\model.gguf`);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(action).toHaveBeenCalledWith(raw);
  });
});
