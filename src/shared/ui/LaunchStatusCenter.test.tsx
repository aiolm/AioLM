import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/i18n';
import { finishTask, getTaskSnapshot, registerTask, removeTask } from '../state/taskRegistry';
import ActivityCenter from './ActivityCenter';
import LaunchStatusCenter from './LaunchStatusCenter';
import { PanelFeedbackOutlet, PanelFeedbackProvider } from './PanelFeedback';

afterEach(() => {
  cleanup();
  for (const task of getTaskSnapshot()) removeTask(task.id);
});

describe('LaunchStatusCenter', () => {
  it('stays collapsed while a model is loading, opens details on click, and cancels when allowed', async () => {
    const cancelLaunch = vi.fn(async () => undefined);
    registerTask({
      id: 'launch-1',
      kind: 'model-launch',
      label: 'Qwen3-8B',
      phase: 'Loading weights',
      interruptible: true,
      cancel: cancelLaunch,
    });

    render(
      <I18nProvider initialLocale="en">
        <LaunchStatusCenter />
      </I18nProvider>,
    );

    const trigger = screen.getByTestId('launch-status-trigger');
    expect(trigger).toHaveTextContent('Loading');
    expect(trigger.querySelector('progress')).toBeNull();
    expect(trigger.querySelector('.aiolm-status-indicator .app-status-badge__dot')).not.toBeNull();
    expect(screen.queryByTestId('launch-status-popover')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const popover = await screen.findByTestId('launch-status-popover');
    expect(within(popover).getByText('Qwen3-8B')).toBeVisible();
    expect(within(popover).getByRole('progressbar')).toBeVisible();

    fireEvent.click(within(popover).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancelLaunch).toHaveBeenCalledOnce());
  });

  it('auto-opens a floating alert popover on failure and keeps its fixed trigger mounted after dismissal', async () => {
    const reopenAction = vi.fn();
    render(
      <I18nProvider initialLocale="en">
        <LaunchStatusCenter />
      </I18nProvider>,
    );

    const idleTrigger = screen.getByTestId('launch-status-trigger');
    expect(idleTrigger).toBeVisible();
    expect(idleTrigger.querySelector('.aiolm-status-indicator .app-status-badge__dot')).not.toBeNull();
    expect(screen.queryByTestId('launch-status-popover')).not.toBeInTheDocument();

    fireEvent.click(idleTrigger);
    expect(await screen.findByText('No model loads in progress.')).toBeVisible();
    fireEvent.click(within(screen.getByTestId('launch-status-popover')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('launch-status-popover')).not.toBeInTheDocument();

    act(() => {
      registerTask({
        id: 'launch-fail',
        kind: 'model-launch',
        label: 'Llama-70B',
        interruptible: true,
        action: { label: 'Return to model settings', onClick: reopenAction },
      });
      finishTask('launch-fail', 'failed', 'Insufficient VRAM');
    });

    const popover = await screen.findByTestId('launch-status-popover');
    expect(within(popover).getByRole('alert')).toHaveTextContent('Insufficient VRAM');

    fireEvent.click(within(popover).getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('launch-status-popover')).not.toBeInTheDocument();
    expect(screen.getByTestId('launch-status-trigger')).toBeVisible();

    fireEvent.click(screen.getByTestId('launch-status-trigger'));
    const reopened = await screen.findByTestId('launch-status-popover');
    fireEvent.click(within(reopened).getByRole('button', { name: 'Return to model settings' }));
    expect(reopenAction).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('launch-status-popover')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('launch-status-trigger'));
    fireEvent.click(
      within(screen.getByTestId('launch-status-popover')).getByRole('button', {
        name: 'Dismiss: Llama-70B',
      }),
    );
    expect(screen.queryByTestId('launch-status-popover')).not.toBeInTheDocument();
    expect(screen.getByTestId('launch-status-trigger')).toBeVisible();
  });

  it('displays server status inside the fixed trigger when controlled by the shell header', async () => {
    render(
      <I18nProvider initialLocale="en">
        <LaunchStatusCenter
          statusLabel="model loaded"
          statusLabels={['no model loaded', 'loading model', 'model loaded']}
          statusTone="success"
        />
      </I18nProvider>,
    );

    const trigger = screen.getByTestId('launch-status-trigger');
    expect(trigger).toHaveClass('aiolm-status', 'app-badge--success');
    expect(trigger).toHaveTextContent('model loaded');
    expect(trigger.querySelector('.aiolm-status-indicator .app-status-badge__dot')).not.toBeNull();
  });

  it('closes its popover when another header center opens', async () => {
    render(
      <I18nProvider initialLocale="en">
        <PanelFeedbackProvider>
          <LaunchStatusCenter />
          <ActivityCenter hasActivity={false} title="Tasks" attentionMessage="Attention" globalError={false}>
            <PanelFeedbackOutlet />
          </ActivityCenter>
        </PanelFeedbackProvider>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('launch-status-trigger'));
    expect(await screen.findByTestId('launch-status-popover')).toBeVisible();

    fireEvent.click(screen.getByTestId('activity-center-trigger'));
    expect(screen.getByTestId('activity-center-popover')).not.toHaveAttribute('hidden');
    expect(screen.queryByTestId('launch-status-popover')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('launch-status-trigger'));
    expect(await screen.findByTestId('launch-status-popover')).toBeVisible();
    expect(screen.getByTestId('activity-center-popover')).toHaveAttribute('hidden');
  });
});
