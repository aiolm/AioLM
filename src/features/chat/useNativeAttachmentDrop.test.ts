import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discardAttachmentDrop, onAttachmentDrop, type AttachmentDropNotice } from '../../shared/api/commands';
import { attachmentDropPoint, useNativeAttachmentDrop } from './useNativeAttachmentDrop';

vi.mock('../../shared/api/commands', () => ({ onAttachmentDrop: vi.fn(), discardAttachmentDrop: vi.fn(async () => undefined) }));

let notify: (notice: AttachmentDropNotice) => void;
let target: HTMLDivElement;
let textarea: HTMLTextAreaElement;
let hit: Element | null;
const unlisten = vi.fn();
const originalHitTest = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(onAttachmentDrop).mockImplementation(async callback => { notify = callback; return unlisten; });
  target = document.createElement('div');
  textarea = document.createElement('textarea');
  textarea.value = 'Preserved draft';
  target.append(textarea);
  document.body.append(target);
  hit = textarea;
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, right: 310, bottom: 120, width: 300, height: 100 } as DOMRect);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => hit) });
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
});
afterEach(() => {
  target.remove();
  vi.restoreAllMocks();
  if (originalHitTest) Object.defineProperty(document, 'elementFromPoint', originalHitTest);
  else Reflect.deleteProperty(document, 'elementFromPoint');
});

function setup() {
  const onDrop = vi.fn();
  const setError = vi.fn();
  const targetRef = { current: target };
  return { onDrop, setError, ...renderHook(({ active, enabled }) => useNativeAttachmentDrop({
    targetRef, active, enabled, onDrop, setError,
  }), { initialProps: { active: true, enabled: true } }) };
}
const notice = (overrides: Partial<AttachmentDropNotice> = {}): AttachmentDropNotice => ({
  id: 'native-token', count: 2, position: { x: 100, y: 100 }, ...overrides,
});

describe('native composer file drops', () => {
  it('uses physical pixel coordinates and retains the draft and focus', async () => {
    const { onDrop } = setup();
    textarea.focus();
    act(() => notify(notice()));
    expect(onDrop).toHaveBeenCalledWith('native-token', 2);
    expect(document.elementFromPoint).toHaveBeenCalledWith(50, 50);
    expect(textarea.value).toBe('Preserved draft');
    expect(document.activeElement).toBe(textarea);
    expect(discardAttachmentDrop).not.toHaveBeenCalled();
    expect(attachmentDropPoint({ x: NaN, y: 1 }, 2)).toBeNull();
    expect(attachmentDropPoint({ x: 1, y: 1 }, 0)).toBeNull();
  });

  it.each(['outside', 'overlay', 'inert', 'inactive'] as const)('discards a drop over %s content without reading or an unrelated error', async reason => {
    const { onDrop, setError, rerender } = setup();
    if (reason === 'overlay') hit = document.body;
    if (reason === 'inert') target.setAttribute('inert', '');
    if (reason === 'inactive') rerender({ active: false, enabled: true });
    act(() => notify(notice(reason === 'outside' ? { position: { x: 620, y: 100 } } : {})));
    expect(onDrop).not.toHaveBeenCalled();
    expect(discardAttachmentDrop).toHaveBeenCalledWith('native-token');
    expect(setError).not.toHaveBeenCalled();
  });

  it('uses current busy state without registering another listener, then accepts a later retry', async () => {
    const { onDrop, setError, rerender } = setup();
    rerender({ active: true, enabled: false });
    act(() => notify(notice()));
    expect(onDrop).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith(expect.stringContaining('Finish the current response'));
    rerender({ active: true, enabled: true });
    act(() => notify(notice({ id: 'retry-token' })));
    expect(onDrop).toHaveBeenCalledWith('retry-token', 2);
    expect(onAttachmentDrop).toHaveBeenCalledOnce();
  });

  it('reports a rejected native batch and refuses malformed counts', async () => {
    const { onDrop, setError } = setup();
    act(() => notify(notice({ id: null, count: 0, error: 'Too many dropped files' })));
    expect(setError).toHaveBeenLastCalledWith('File attachment failed: Too many dropped files');
    act(() => notify(notice({ count: 65 })));
    expect(onDrop).not.toHaveBeenCalled();
    expect(discardAttachmentDrop).toHaveBeenCalledWith('native-token');
  });

  it('releases a subscription that arrives after unmount and ignores its late events', async () => {
    let resolve!: (stop: () => void) => void;
    vi.mocked(onAttachmentDrop).mockImplementation(callback => {
      notify = callback;
      return new Promise(done => { resolve = done; });
    });
    const { onDrop, unmount } = setup();
    unmount();
    await act(async () => { resolve(unlisten); });
    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
    act(() => notify(notice()));
    expect(onDrop).not.toHaveBeenCalled();
  });
});
