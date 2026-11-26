import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { I18nProvider } from '../../shared/i18n/i18n';
import RuntimeArgumentList from './RuntimeArgumentList';

it('drops the shell quotes of a pasted path token and keeps other quoted tokens', () => {
  const onChange = vi.fn();
  render(<I18nProvider initialLocale="en"><RuntimeArgumentList label="Arguments" tokens={['--mmproj', '', '--x=""']} disabled={false} onChange={onChange} /></I18nProvider>);
  const [, path, flag] = screen.getAllByRole('textbox');
  fireEvent.change(path!, { target: { value: '"C:\\Models\\한글 dir\\mmproj-F32.gguf"' } });
  expect(onChange).toHaveBeenLastCalledWith(['--mmproj', 'C:\\Models\\한글 dir\\mmproj-F32.gguf', '--x=""']);
  fireEvent.change(flag!, { target: { value: '--mtp="D:\\mtp.gguf"' } });
  expect(onChange).toHaveBeenLastCalledWith(['--mmproj', '', '--mtp=D:\\mtp.gguf']);
  fireEvent.change(flag!, { target: { value: '--label="quoted text"' } });
  expect(onChange).toHaveBeenLastCalledWith(['--mmproj', '', '--label="quoted text"']);
});
