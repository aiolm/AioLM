import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { I18nProvider } from '../../shared/i18n/i18n';
import TuningSamplerChain from './TuningSamplerChain';

const chainOrder = () => screen.getAllByRole('listitem').map(item => item.getAttribute('data-sampler'));
const stage = (name: string) => screen.getByRole('listitem', { name });
const wrap = (element: ReactNode) => <I18nProvider initialLocale="en">{element}</I18nProvider>;

describe('sampler chain ordering', () => {
  it('keeps a move button focused while repeatedly moving a stage and updates the boundaries', () => {
    const changed = vi.fn();
    render(wrap(<TuningSamplerChain value={['top_k', 'top_n_sigma', 'temperature']} onChange={changed} />));
    const earlier = screen.getByRole('button', { name: 'Move temperature earlier' });
    earlier.focus();
    fireEvent.click(earlier);
    expect(chainOrder()).toEqual(['top_k', 'temperature', 'top_n_sigma']);
    expect(earlier).toHaveFocus();
    fireEvent.click(earlier);
    expect(chainOrder()).toEqual(['temperature', 'top_k', 'top_n_sigma']);
    expect(changed).toHaveBeenLastCalledWith(['temperature', 'top_k', 'top_n_sigma']);
    expect(earlier).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move top_n_sigma later' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move top_k earlier' })).toBeEnabled();
  });

  it('renumbers steps after dragging and allows removing and adding a stage again', () => {
    const changed = vi.fn();
    render(wrap(<TuningSamplerChain value={['top_k', 'top_p', 'temperature']} onChange={changed} />));
    fireEvent.dragStart(stage('top_k'));
    fireEvent.dragOver(stage('temperature'));
    fireEvent.drop(stage('temperature'));
    expect(chainOrder()).toEqual(['top_p', 'temperature', 'top_k']);
    expect(within(stage('top_p')).getByText('1')).toBeVisible();
    expect(within(stage('top_k')).getByText('3')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Remove temperature' }));
    expect(chainOrder()).toEqual(['top_p', 'top_k']);
    expect(within(stage('top_k')).getByText('2')).toBeVisible();
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'temperature' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(chainOrder()).toEqual(['top_p', 'top_k', 'temperature']);
    expect(changed).toHaveBeenLastCalledWith(['top_p', 'top_k', 'temperature']);
  });

  it('shows externally replaced values and retains custom sampler names', () => {
    const changed = vi.fn();
    const { rerender } = render(wrap(<TuningSamplerChain value={['top_k', ' custom_sampler ', 'top_k']} onChange={changed} />));
    expect(chainOrder()).toEqual(['top_k', 'custom_sampler']);
    rerender(wrap(<TuningSamplerChain value={['temperature', 'custom_sampler']} onChange={changed} />));
    expect(chainOrder()).toEqual(['temperature', 'custom_sampler']);
    expect(changed).not.toHaveBeenCalled();
  });

  it('prevents changes when disabled, including a drop after disabling during a drag', () => {
    const changed = vi.fn();
    const value = ['top_k', 'top_p'];
    const { rerender } = render(wrap(<TuningSamplerChain value={value} onChange={changed} />));
    fireEvent.dragStart(stage('top_k'));
    rerender(wrap(<TuningSamplerChain value={value} disabled onChange={changed} />));
    fireEvent.drop(stage('top_p'));
    fireEvent.click(screen.getByRole('button', { name: 'Move top_p earlier' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove top_p' }));
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(stage('top_k')).toHaveAttribute('draggable', 'false');
    expect(chainOrder()).toEqual(value);
    expect(changed).not.toHaveBeenCalled();
  });
});
