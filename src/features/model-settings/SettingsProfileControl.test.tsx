import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, type Locale } from '../../shared/i18n/i18n';
import SettingsProfileControl, { type ProfileViewItem, type SettingsProfileControlProps } from './SettingsProfileControl';

const items: ProfileViewItem[] = [
  { id: 'balanced', name: 'Balanced', scope: 'preset', settings: { temperature: 0.7, ctx_size: 4096 }, description: 'Balanced output.' },
  { id: 'creative', name: 'Creative', scope: 'global', settings: { temperature: 0.9 }, system_prompt: 'Write freely.' },
  { id: 'precise', name: 'Precise', scope: 'model', settings: { temperature: 0.2 }, system_prompt: 'Be concise.' },
  { id: 'everyday', name: 'Everyday', scope: 'global', settings: { temperature: 0.7 }, deletable: false, deletionReason: 'default' },
];
const resolved = () => vi.fn().mockResolvedValue(undefined);
function mount(overrides: Partial<SettingsProfileControlProps> = {}, locale: Locale = 'en') {
  const props: SettingsProfileControlProps = {
    items, activeId: 'precise', basedOnId: null, defaultProfileId: 'everyday', modelPath: 'models/example.gguf', state: 'named', disabled: false, full: true,
    currentSettings: { temperature: 0.2 }, currentPrompt: 'Be concise.', defaults: { temperature: 0.8, runtime_defaults: ['temperature'] },
    onApply: resolved(), onSaveAs: resolved(), onRename: resolved(), onDelete: resolved(), onSetDefault: resolved(), onRevert: resolved(), onReset: vi.fn(() => true), ...overrides,
  };
  const view = render(<I18nProvider initialLocale={locale}><SettingsProfileControl {...props} /></I18nProvider>);
  return { ...props, ...view, rerenderControl: (patch: Partial<SettingsProfileControlProps>) => view.rerender(<I18nProvider initialLocale={locale}><SettingsProfileControl {...props} {...patch} /></I18nProvider>) };
}
function preview(name: string) { fireEvent.click(screen.getByRole('button', { name })); }
function openCreate(scope: 'Global' | 'Model' = 'Model') {
  fireEvent.click(screen.getByRole('button', { name: 'Save as new' }));
  if (screen.getByRole('combobox', { name: 'Scope' }).textContent !== scope) {
    fireEvent.click(screen.getByRole('combobox', { name: 'Scope' }));
    fireEvent.click(screen.getByRole('option', { name: scope }));
  }
}

describe('settings profile workspace', () => {
  it.each([
    ['en', 'Save as new', 'Create new profile', 'Select this profile'], ['ko', '새 프로필로 저장', '새 프로필 생성', '이 프로필 선택'],
    ['ja', '新規として保存', '新しいプロファイルを作成', 'このプロファイルを選択'], ['zh', '另存为新预设', '创建新预设', '选择此预设'],
  ] as const)('keeps creation and profile selection distinct in every layout in %s', (locale, name, create, select) => {
    const props = mount({}, locale);
    for (const full of [true, false]) for (const state of ['named', 'working'] as const) {
      props.rerenderControl({ full, state });
      expect(screen.getAllByRole('button', { name })).toHaveLength(1);
      expect(document.querySelectorAll('.settings-profile-group-heading button')).toHaveLength(0);
    }
    props.rerenderControl({ full: true });
    preview('Creative');
    expect(screen.getByRole('button', { name: select })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name }));
    expect(screen.getByRole('button', { name: create })).toBeDisabled();
  });

  it('shows the current profile identity once above its values and retains the preview identity', () => {
    mount();
    expect(screen.getAllByRole('heading', { name: 'Precise' })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Current values' })).toBeVisible();
    preview('Creative');
    expect(within(screen.getByRole('region', { name: 'Preview' })).getByRole('heading', { name: 'Creative' })).toBeVisible();
  });
  it('resets the selected profile draft without applying the preview or changing saved profiles', () => {
    const props = mount({ blocked: true });
    preview('Creative');
    const reset = screen.getByRole('button', { name: 'Reset all to defaults' });
    expect(reset).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText(/Reset all options in the selected profile/)).not.toBeInTheDocument();
    fireEvent.click(reset);
    expect(props.onReset).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Reset to defaults.');
    expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onSaveAs).not.toHaveBeenCalled();
  });

  it.each([
    ['en', true, 'Reset all to defaults', 'Reset to defaults.'],
    ['en', false, 'Reset all to defaults', 'Already using defaults.'],
    ['ko', true, '전체 기본값으로 초기화', '기본값으로 초기화했습니다.'],
    ['ko', false, '전체 기본값으로 초기화', '이미 기본값입니다.'],
    ['ja', true, 'すべて既定値に戻す', '既定値に戻しました。'],
    ['ja', false, 'すべて既定値に戻す', 'すでに既定値です。'],
    ['zh', true, '全部重置为默认值', '已重置为默认值。'],
    ['zh', false, '全部重置为默认值', '已在使用默认值。'],
  ] as const)('announces reset results in %s when values changed is %s', (locale, changed, label, message) => {
    const props = mount({ onReset: vi.fn(() => changed) }, locale);
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(screen.getByRole('status')).toHaveTextContent(message);
    expect(props.onReset).toHaveBeenCalledOnce();
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onSaveAs).not.toHaveBeenCalled();
  });

  it('keeps repeated reset feedback visible for a fresh interval then restores the profile status', () => {
    vi.useFakeTimers();
    try {
      const props = mount({ onReset: vi.fn(() => false) });
      const reset = screen.getByRole('button', { name: 'Reset all to defaults' });
      fireEvent.click(reset);
      expect(screen.getByRole('status')).toHaveTextContent('Already using defaults.');
      act(() => vi.advanceTimersByTime(3000));
      fireEvent.click(reset);
      act(() => vi.advanceTimersByTime(3000));
      expect(screen.getByRole('status')).toHaveTextContent('Already using defaults.');
      expect(props.onReset).toHaveBeenCalledTimes(2);
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByText('Already using defaults.')).not.toBeInTheDocument();
      expect(screen.getByText('Model profile · selected for this model')).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows saved profile scopes together without presets and separates preview from the saved profile', () => {
    const props = mount();
    expect(screen.queryByRole('region', { name: 'Preset profiles' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Balanced' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Global profiles' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Model profiles' })).toBeInTheDocument();
    const activeChip = screen.getByRole('button', { name: 'Precise · Selected' });
    expect(activeChip).toHaveClass('settings-profile-chip--active');
    preview('Creative');
    const card = screen.getByRole('region', { name: 'Preview' });
    expect(within(card).getByText('0.9')).toBeInTheDocument();
    expect(within(card).getByText('Write freely.')).toBeInTheDocument();
    expect(activeChip).toHaveClass('settings-profile-chip--active');
    expect(screen.getByRole('button', { name: 'Creative' })).toHaveAttribute('aria-pressed', 'true');
    expect(props.onApply).not.toHaveBeenCalled();
    preview('Creative');
    expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Current values' })).getByText('0.2')).toBeInTheDocument();
  });

  it('applies a preview only through its explicit action and closes after saving succeeds', async () => {
    let complete!: () => void;
    const onApply = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    mount({ onApply }); preview('Creative');
    fireEvent.click(screen.getByRole('button', { name: 'Select this profile' }));
    expect(onApply).toHaveBeenCalledWith('creative');
    expect(screen.getByRole('region', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select this profile' })).toBeDisabled();
    await act(async () => complete());
    expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();
  });

  it('retains the preview and offers retry when application fails', async () => {
    const onApply = vi.fn().mockRejectedValueOnce(new Error('Save conflict')).mockResolvedValue(undefined);
    mount({ onApply }); preview('Creative');
    fireEvent.click(screen.getByRole('button', { name: 'Select this profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save conflict');
    expect(screen.getByRole('region', { name: 'Preview' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select this profile' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument());
  });

  it('keeps the selected profile identity while previewing saved values during editing', () => {
    const props = mount({ state: 'working', basedOnId: 'precise', currentSettings: { temperature: 0.4 } });
    expect(screen.getByText('Model profile · unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Precise · Selected · Editing' })).toHaveClass('settings-profile-chip--active');
    expect(within(screen.getByRole('region', { name: 'Current values' })).getByText('0.4')).toBeInTheDocument();
    preview('Precise · Selected · Editing');
    expect(within(screen.getByRole('region', { name: 'Preview' })).getByText('0.2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Precise' })).not.toBeInTheDocument();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('keeps the named editing banner and its actions available in compact mode', async () => {
    const props = mount({ state: 'working', basedOnId: 'precise', full: false });
    expect(screen.getByRole('heading', { name: 'Precise · Editing' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Preset profiles' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as new' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(props.onRevert).toHaveBeenCalledOnce());
  });

  it('keeps creating a profile separate from applying a preview', async () => {
    const props = mount({ state: 'working', basedOnId: 'precise' });
    preview('Creative');
    expect(screen.queryByRole('button', { name: /Update with working/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Creative' })).not.toBeInTheDocument();
    openCreate();
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'From current values' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create new profile' }));
    await waitFor(() => expect(props.onSaveAs).toHaveBeenCalledWith('From current values', 'model'));
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('retains the selected name after saving or reverting edits', () => {
    const props = mount({ state: 'working', full: false });
    expect(screen.getByRole('heading', { name: 'Precise · Editing' })).toBeInTheDocument();
    props.rerenderControl({ state: 'named' });
    expect(screen.getByRole('heading', { name: 'Precise' })).toBeInTheDocument();
    expect(screen.getByText('Model profile · selected for this model')).toBeInTheDocument();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('keeps the defaults summary read only', () => {
    mount();
    const defaults = screen.getByText('Defaults').closest('details')!;
    expect(within(defaults).getByText('Runtime default')).toBeInTheDocument();
    expect(within(defaults).queryByRole('button')).not.toBeInTheDocument();
  });

  it('previews inherited defaults even when no scalar values are stored', () => {
    mount({ items: [{ id: 'default', name: 'Default', scope: 'global', settings: { runtime_defaults: ['temperature', 'top_p', 'ctx_size'], chat_options: {} }, deletable: false }], activeId: 'default', defaultProfileId: 'default' });
    preview('Default · Selected · Default profile');
    const card = within(screen.getByRole('region', { name: 'Preview' }));
    for (const label of ['Temperature', 'Top P', 'Context size']) {
      expect(card.getByText(label).nextElementSibling).toHaveTextContent('Runtime default');
    }
  });

  it.each(['Model', 'Global'] as const)('creates a %s profile only through a successfully saved name form', async scope => {
    const props = mount(); openCreate(scope);
    expect(screen.getByLabelText('Profile name')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create new profile' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: '  Clear answers  ' } });
    expect(props.onSaveAs).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create new profile' }));
    await waitFor(() => expect(screen.queryByLabelText('Profile name')).not.toBeInTheDocument());
    expect(props.onSaveAs).toHaveBeenCalledWith('Clear answers', scope.toLowerCase());
  });

  it('preserves typed names after save failure and does not create duplicate requests while saving', async () => {
    let fail!: (error: Error) => void;
    const onSaveAs = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    mount({ onSaveAs }); openCreate();
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Retry this name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create new profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create new profile' }));
    expect(onSaveAs).toHaveBeenCalledOnce();
    await act(async () => fail(new Error('Storage unavailable')));
    expect(screen.getByLabelText('Profile name')).toHaveValue('Retry this name');
    expect(screen.getByRole('alert')).toHaveTextContent('Storage unavailable');
  });

  it('renames separately from updating profile values', async () => {
    const props = mount(); fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Renamed' } });
    fireEvent.keyDown(screen.getByLabelText('Profile name'), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByLabelText('Profile name')).not.toBeInTheDocument());
    expect(props.onRename).toHaveBeenCalledWith('precise', 'Renamed');
    expect(props.onSaveAs).not.toHaveBeenCalled(); expect(props.onApply).not.toHaveBeenCalled();
  });

  it('requires confirmation to delete a profile and preserves the action if deletion fails', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('Delete failed'));
    mount({ onDelete }); fireEvent.click(screen.getByRole('button', { name: 'Delete profile' }));
    expect(onDelete).not.toHaveBeenCalled();
    const confirm = within(screen.getByRole('group', { name: 'Delete profile' }));
    expect(confirm.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(confirm.getByRole('button', { name: 'Delete profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Delete failed');
    expect(screen.getByRole('group', { name: 'Delete profile' })).toBeInTheDocument();
  });

  it('confirms deletion of a previewed profile without applying it', async () => {
    const props = mount(); preview('Creative');
    fireEvent.click(screen.getByRole('button', { name: 'Delete profile' }));
    const confirm = within(screen.getByRole('group', { name: 'Delete profile' }));
    expect(confirm.getByText('Delete “Creative”?')).toBeInTheDocument();
    expect(confirm.getByText('Models using this profile will switch to the default profile, “Everyday”.')).toBeInTheDocument();
    fireEvent.click(confirm.getByRole('button', { name: 'Delete profile' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Delete profile' })).not.toBeInTheDocument());
    expect(props.onDelete).toHaveBeenCalledWith('creative');
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it.each([
    ['en', 'Delete profile', 'The default profile cannot be deleted. Set another profile as the default first.'],
    ['ko', '프로필 삭제', '기본 프로필은 삭제할 수 없습니다. 먼저 다른 프로필을 기본으로 지정하세요.'],
    ['ja', 'プロファイルを削除', '既定のプロファイルは削除できません。先に別のプロファイルを既定に設定してください。'],
    ['zh', '删除预设', '无法删除默认预设。请先将其他预设设为默认。'],
  ] as const)('explains in %s why the designated default profile cannot be deleted', (locale, label, hint) => {
    const props = mount({ items: [items[1], { ...items[2], deletionReason: 'default', deletable: false }], defaultProfileId: 'precise' }, locale);
    const remove = screen.getByRole('button', { name: label });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAccessibleDescription(hint);
    expect(screen.getByText(hint)).toBeVisible();
    fireEvent.click(remove);
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: label })).not.toBeInTheDocument();
  });

  it('prevents an open confirmation from deleting a profile that has become the default', () => {
    const props = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Delete profile' }));
    props.rerenderControl({ defaultProfileId: 'precise' });
    const confirm = within(screen.getByRole('group', { name: 'Delete profile' }));
    const remove = confirm.getByRole('button', { name: 'Delete profile' });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAccessibleDescription(/The default profile cannot be deleted/);
    fireEvent.click(remove);
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Delete profile' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete profile' })).toBeDisabled();
  });

  it('allows deleting the selected nondefault profile after explaining the fallback', async () => {
    const props = mount();
    const remove = screen.getByRole('button', { name: 'Delete profile' });
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    const confirm = within(screen.getByRole('group', { name: 'Delete profile' }));
    expect(confirm.getByText('Models using this profile will switch to the default profile, “Everyday”.')).toBeVisible();
    fireEvent.click(confirm.getByRole('button', { name: 'Delete profile' }));
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith('precise'));
  });

  it.each([
    ['en', 'Default profile', 'Set as default'],
    ['ko', '기본 프로필', '기본 프로필로 지정'],
    ['ja', '既定のプロファイル', '既定に設定'],
    ['zh', '默认预设', '设为默认'],
  ] as const)('shows the %s default designation independently of the profile name', (locale, badge, action) => {
    const props = mount({ defaultProfileId: 'precise', full: false }, locale);
    expect(screen.getByRole('heading', { name: 'Precise' })).toBeVisible();
    expect(screen.getByText(badge)).toBeVisible();
    props.rerenderControl({ full: true });
    expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument();
    expect(document.querySelector('.settings-profile-chip--active .settings-profile-default-badge')).toHaveTextContent(badge);
  });

  it.each(['current', 'preview'] as const)('designates a %s profile without applying or saving unsaved option values', async target => {
    const props = mount({ state: 'working', blocked: true });
    if (target === 'preview') preview('Creative');
    const button = screen.getByRole('button', { name: 'Set as default' });
    expect(button).toBeEnabled();
    if (target === 'current') expect(button).toHaveAccessibleDescription('Setting this profile as default makes it available to all models.');
    fireEvent.click(button);
    await waitFor(() => expect(props.onSetDefault).toHaveBeenCalledWith(target === 'current' ? 'precise' : 'creative'));
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onSaveAs).not.toHaveBeenCalled();
  });

  it('retains the previous default and permits retry when changing the default fails', async () => {
    let fail!: (reason: Error) => void;
    const onSetDefault = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; })).mockResolvedValue(undefined);
    const props = mount({ onSetDefault });
    fireEvent.click(screen.getByRole('button', { name: 'Set as default' }));
    expect(screen.getByRole('button', { name: 'Set as default' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete profile' })).toBeDisabled();
    await act(async () => { fail(new Error('Could not save default')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save default');
    expect(screen.getByRole('button', { name: 'Everyday · Default profile' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set as default' }));
    await waitFor(() => expect(onSetDefault).toHaveBeenCalledTimes(2));
    props.rerenderControl({ defaultProfileId: 'precise' });
    expect(screen.getByRole('button', { name: 'Precise · Selected · Default profile' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete profile' })).toBeDisabled();
    preview('Everyday');
    expect(screen.getByRole('button', { name: 'Delete profile' })).toBeEnabled();
  });

  it('prevents confirmation from deleting a profile that no longer exists', () => {
    const props = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Delete profile' }));
    props.rerenderControl({ items: [items[1]], activeId: 'creative' });
    const remove = within(screen.getByRole('group', { name: 'Delete profile' })).getByRole('button', { name: 'Delete profile' });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('allows previews and reverting invalid edits while blocking apply and creation', async () => {
    const props = mount({ blocked: true, state: 'working', basedOnId: 'precise' });
    preview('Creative');
    expect(screen.getByRole('region', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select this profile' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save as new' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(props.onRevert).toHaveBeenCalledOnce());
  });

  it('cancels name editing and closes preview on Escape without dismissing the enclosing editor', () => {
    const parentEscape = vi.fn();
    const props = mount(); document.addEventListener('keydown', parentEscape);
    preview('Creative'); fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Unfinished' } });
    fireEvent.keyDown(screen.getByLabelText('Profile name'), { key: 'Escape' });
    expect(screen.queryByLabelText('Profile name')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename' })).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Preview' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close preview' }), { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();
    expect(parentEscape).not.toHaveBeenCalled(); expect(props.onRename).not.toHaveBeenCalled();
    document.removeEventListener('keydown', parentEscape);
  });

  it('reports inline actions and clears them when changing model', () => {
    const onEditingChange = vi.fn(); const props = mount({ onEditingChange });
    preview('Creative'); expect(onEditingChange).toHaveBeenLastCalledWith(false);
    openCreate(); expect(onEditingChange).toHaveBeenLastCalledWith(true);
    props.rerenderControl({ modelPath: 'models/other.gguf' });
    expect(screen.queryByLabelText('Profile name')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });

  it.each([
    ['ko', 'Precise · 편집 중', '모델 프로필 · 저장하지 않은 변경'],
    ['ja', 'Precise · 編集中', 'モデルプロファイル · 未保存の変更'],
    ['zh', 'Precise · 编辑中', '模型预设 · 未保存的更改'],
  ] as const)('provides %s named editing-state copy', (locale, title, subtitle) => {
    mount({ state: 'working', basedOnId: 'precise', full: false }, locale);
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByText(subtitle)).toBeInTheDocument();
  });
});
