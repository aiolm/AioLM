import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '../../shared/i18n/i18n';
import type { CommandEntry, OptionSchemaDefinition } from '../../shared/api/runtimeHelp';
import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';
import PositionalLayout from './PositionalLayout';

function slot(key: string, position: number): OptionSchemaDefinition {
  return { ...schemaOption({ key, target: 'launch', group: 'options', kind: { type: 'text' } }), position, managed: 'discovery', help: `${key} help` };
}

const entry: CommandEntry = {
  version: 1, program: 'python', prefix: ['-I', 'engine.py', 'serve', 'MARKER'],
  layout: { version: 1, subcommands: [2], options: [{ index: 0, values: 0 }] },
  positional_bindings: ['model'],
};

const choose = (slotKey: string, label: string) => {
  fireEvent.click(screen.getByRole('combobox', { name: `${slotKey} Positional layout` }));
  fireEvent.click(screen.getByRole('option', { name: label }));
};

describe('positional layout', () => {
  it('maps user slots before and between template slots and keeps other confirmations', () => {
    const slots = [slot('input', 0), slot('model', 1), slot('marker', 2), slot('output', 3)];
    const effective = effectiveSchema([], slots, {
      entry,
      supplement: { fingerprint: 'a'.repeat(64), current: true, applied: [], conflicts: [], options: { pair: { repeatable: true } } },
    });
    const onSave = vi.fn();
    render(<I18nProvider initialLocale="en"><PositionalLayout effective={effective} disabled={false} onSave={onSave} /></I18nProvider>);
    choose('input', 'You supply it');
    choose('model', 'App binding: model');
    // Only literal tokens after the declared subcommand are offered.
    fireEvent.click(screen.getByRole('combobox', { name: 'marker Positional layout' }));
    expect(screen.queryByRole('option', { name: /Entry token 2: engine.py/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Entry token 4: MARKER' }));
    choose('output', 'You supply it');
    fireEvent.click(screen.getByRole('button', { name: 'Save positional layout' }));
    expect(onSave).toHaveBeenCalledWith({
      pair: { repeatable: true },
      input: { positional: { role: 'user' } },
      model: { positional: { role: 'binding', name: 'model' } },
      marker: { positional: { role: 'static', index: 3 } },
      output: { positional: { role: 'user' } },
    });
  });

  it('keeps unsaved choices within one review and drops them for a new review or runtime', () => {
    const slots = [slot('input', 0)];
    const view = (fingerprint: string, runtime = 'synthetic') => {
      const effective = effectiveSchema([], slots, { entry, accepted_fingerprint: fingerprint });
      effective.schema.binding = { ...effective.schema.binding, runtime, fingerprint };
      return <I18nProvider initialLocale="en"><PositionalLayout effective={effective} disabled={false} onSave={vi.fn()} /></I18nProvider>;
    };
    const rendered = render(view('a'.repeat(64)));
    choose('input', 'You supply it');
    const value = () => screen.getByRole('combobox', { name: 'input Positional layout' });
    // A re-render of the same review keeps the unsaved edit.
    rendered.rerender(view('a'.repeat(64)));
    expect(value()).toHaveTextContent('You supply it');
    // Newly accepted help describes other slots: nothing carries over.
    rendered.rerender(view('b'.repeat(64)));
    expect(value()).toHaveTextContent('Not mapped');
    choose('input', 'You supply it');
    rendered.rerender(view('b'.repeat(64), 'other-runtime'));
    expect(value()).toHaveTextContent('Not mapped');
  });

  it('explains a refused layout and offers no choice without a declared entry', () => {
    const slots = [slot('input', 0)];
    const refused = effectiveSchema([], slots, {
      entry,
      supplement: { fingerprint: 'a'.repeat(64), current: true, applied: [], options: { input: { positional: { role: 'user' } } },
        conflicts: [{ key: 'input', field: 'positional', confirmed: { role: 'user' }, help: 'map the launch template\'s positional binding model to its slot' }] },
    });
    const view = render(<I18nProvider initialLocale="en"><PositionalLayout effective={refused} disabled={false} onSave={vi.fn()} /></I18nProvider>);
    expect(screen.getByRole('alert')).toHaveTextContent('positional binding model');
    view.unmount();
    render(<I18nProvider initialLocale="en"><PositionalLayout effective={effectiveSchema([], slots)} disabled={false} onSave={vi.fn()} /></I18nProvider>);
    expect(screen.getByText(/does not declare positional placement/)).toBeVisible();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
