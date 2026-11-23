import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discardAttachmentDrop, onAttachmentDrag, onAttachmentDrop, type AttachmentDragNotice, type AttachmentDropNotice } from '../../shared/api/commands';
import { attachmentDropPoint, useNativeAttachmentDrop } from './useNativeAttachmentDrop';

vi.mock('../../shared/api/commands', () => ({ onAttachmentDrop: vi.fn(), onAttachmentDrag: vi.fn(), discardAttachmentDrop: vi.fn(async () => undefined) }));

let notify: (notice: AttachmentDropNotice) => void;
let dragNotify: (notice: AttachmentDragNotice) => void;
let target: HTMLDivElement;
let textarea: HTMLTextAreaElement;
let hit: Element | null;
const unlisten = vi.fn();
const dragUnlisten = vi.fn();
const originalHitTest = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
const hitTest = vi.fn(() => hit);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(onAttachmentDrop).mockImplementation(async callback => { notify = callback; return unlisten; });
  vi.mocked(onAttachmentDrag).mockImplementation(async callback => { dragNotify = callback; return dragUnlisten; });
  target = document.createElement('div');
  textarea = document.createElement('textarea');
  textarea.value = 'Preserved draft';
  target.append(textarea);
  document.body.append(target);
  hit = textarea;
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, right: 310, bottom: 120, width: 300, height: 100 } as DOMRect);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hitTest });
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
});
afterEach(() => {
  target.remove();
  vi.restoreAllMocks();
  if (originalHitTest) Object.defineProperty(document, 'elementFromPoint', originalHitTest);
  else Reflect.deleteProperty(document, 'elementFromPoint');
});

function setup(locale: 'en' | 'ko' = 'en') {
  const onDrop = vi.fn();
  const setError = vi.fn();
  const targetRef = { current: target };
  const initialProps: { active: boolean; enabled: boolean; locale?: 'en' | 'ko' } = { active: true, enabled: true, locale };
  return { onDrop, setError, ...renderHook(({ active, enabled, locale: currentLocale }) => useNativeAttachmentDrop({
    targetRef, active, enabled, locale: currentLocale, onDrop, setError,
  }), { initialProps }) };
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
    expect(hitTest).toHaveBeenCalledWith(50, 50);
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

  it('tracks drag hover over the active composer target and cleans up drag listener on unmount', async () => {
    const { result, unmount, rerender } = setup();
    expect(result.current.isDragOver).toBe(false);
    act(() => dragNotify({ state: 'enter', position: { x: 100, y: 100 } }));
    expect(result.current.isDragOver).toBe(true);
    act(() => dragNotify({ state: 'over', position: { x: 620, y: 100 } }));
    expect(result.current.isDragOver).toBe(false);
    act(() => dragNotify({ state: 'over', position: { x: 100, y: 100 } }));
    expect(result.current.isDragOver).toBe(true);
    act(() => dragNotify({ state: 'leave' }));
    expect(result.current.isDragOver).toBe(false);
    act(() => dragNotify({ state: 'enter', position: { x: 100, y: 100 } }));
    expect(result.current.isDragOver).toBe(true);
    rerender({ active: true, enabled: false, locale: 'en' });
    expect(result.current.isDragOver).toBe(false);
    unmount();
    await waitFor(() => expect(dragUnlisten).toHaveBeenCalledOnce());
  });

  it('localizes the busy attachment drop error using the provided locale', () => {
    const { onDrop, setError, rerender } = setup('ko');
    rerender({ active: true, enabled: false, locale: 'ko' });
    act(() => notify(notice()));
    expect(onDrop).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith('파일 첨부 실패: 파일을 놓기 전에 현재 응답 또는 첨부를 마치고 채팅 모델이 실행 중인지 확인하세요.');
  });
});
