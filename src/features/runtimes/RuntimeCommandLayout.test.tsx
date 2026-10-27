import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { I18nProvider } from '../../shared/i18n/i18n';
import type { CommandLayout } from '../../shared/api/runtimeHelp';
import RuntimeCommandLayout from './RuntimeCommandLayout';

it('maps a repeated word as an option value and only the chosen token as a subcommand', () => {
  function App() {
    const [layout, setLayout] = useState<CommandLayout>();
    return <><RuntimeCommandLayout prefix={['--label', 'serve', 'serve']} value={layout} disabled={false} onChange={setLayout} /><output>{JSON.stringify(layout)}</output></>;
  }
  render(<I18nProvider initialLocale="en"><App /></I18nProvider>);
  expect(screen.queryByLabelText('Role 1')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Declare fixed options and subcommands'));
  fireEvent.click(screen.getByRole('combobox', { name: 'Role 1' }));
  fireEvent.click(screen.getByRole('option', { name: 'Fixed option' }));
  fireEvent.change(screen.getByLabelText('Following value count 1'), { target: { value: '1' } });
  expect(screen.queryByLabelText('Role 2')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('combobox', { name: 'Role 3' }));
  fireEvent.click(screen.getByRole('option', { name: 'Subcommand' }));
  expect(JSON.parse(screen.getByRole('status').textContent!)).toEqual({ version: 1, options: [{ index: 0, values: 1 }], subcommands: [2] });
});
