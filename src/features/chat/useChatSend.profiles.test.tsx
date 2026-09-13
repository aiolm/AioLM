import { useRef, useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import { emptyProfileLibrary, profileTargetKey, type ProfileApplication } from '../../shared/config/settingsProfiles';
import { createTestStore } from '../../testing/appStore';
import { requestProfileFromApplication } from '../model-settings/profileEditor';
import { createChatThread, type ChatHistoryMessage } from './chatHistory';
import type { DocumentAttachment, ImageAttachment } from './chatUtils';
import { useChatSend } from './useChatSend';

vi.mock('../../shared/api/index', () => ({ chatStream: vi.fn(async () => 'Response'), serverActivity: vi.fn(async () => undefined) }));

type Options = Parameters<typeof useChatSend>[0];
const model = 'models/example.gguf';
function appliedConfig() {
  const library = emptyProfileLibrary();
  library.legacy_imported = true;
  library.entries = [{ id: 'shared', name: 'Shared instruction', scope: 'global', revision: 2, settings: {}, system_prompt: 'A later edit to the shared profile' }];
  const application: ProfileApplication = { model, profile_id: 'shared', profile_name: 'Shared instruction', profile_revision: 1, settings: { temperature: 0.2 }, system_prompt: 'Copied default instruction' };
  library.applied[profileTargetKey(model)] = application;
  library.applied[profileTargetKey(model, 'writing')] = { ...application, system_prompt: 'Copied writing instruction' };
  return { active_model: model, settings_profiles: library };
}
function setup(overrides: Partial<Options> = {}) {
  const store = createTestStore(appliedConfig());
  return renderHook(() => {
    const [msgs, setMsgs] = useState<ChatHistoryMessage[]>([]);
    const [input, setInput] = useState('Hello');
    const [phase, setPhase] = useState<'idle' | 'thinking' | 'streaming'>('idle');
    const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
    const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
    const atBottomRef = useRef(true);
    return useChatSend({
      store, effectiveConfig: store.cfg, sessionId: 'default', baseUrl: 'http://127.0.0.1:8080', apiKey: '', model,
      activeThread: createChatThread(), msgs, setMsgs, input, setInput, phase, setPhase, attachments, setAttachments,
      documents, setDocuments, atBottomRef, mcpDefinitions: [], mcpEntryByFunctionName: new Map(), ...overrides,
    });
  });
}
function systemPrompt() {
  return vi.mocked(api.chatStream).mock.calls[0][3].find(message => message.role === 'system')?.content;
}

describe('chat profile application', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
  it('inherits the copied target prompt for a new conversation while later profile edits stay separate', async () => {
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    expect(systemPrompt()).toBe('Copied default instruction');
  });
  it('uses the named session application rather than the default target', async () => {
    const { result } = setup({ sessionId: 'writing' });
    await act(async () => { await result.current.send(); });
    expect(systemPrompt()).toBe('Copied writing instruction');
  });
  it('preserves an existing conversation instruction', async () => {
    const { result } = setup({ activeThread: { ...createChatThread(), systemPrompt: 'Keep this conversation instruction' } });
    await act(async () => { await result.current.send(); });
    expect(systemPrompt()).toBe('Keep this conversation instruction');
  });
  it('uses the running snapshot supplied by the target provider', async () => {
    const modelProfile = requestProfileFromApplication({ model, settings: {}, system_prompt: 'Current running instruction' });
    const { result } = setup({ modelProfile });
    await act(async () => { await result.current.send(); });
    expect(systemPrompt()).toBe('Current running instruction');
  });
  it('does not consult a saved profile when the target has no applied prompt', async () => {
    const { result } = setup({ modelProfile: null });
    await act(async () => { await result.current.send(); });
    expect(systemPrompt()).toBe('You are a helpful assistant.');
  });
});
