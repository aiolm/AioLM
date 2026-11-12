import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { ChatHistoryMessage } from '../../shared/api/conversationTypes';
import type { ChatPhase } from './chatSendTypes';

export function useChatScroll(viewMessages: ChatHistoryMessage[], visiblePhase: ChatPhase, atBottomRef: RefObject<boolean>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<{ width: number; height: number } | null>(null);

  // An empty idle conversation shows its guidance from the top; like the
  // message effect below, resizing does not pin it to the bottom.
  const followLatestRef = useRef(false);
  followLatestRef.current = viewMessages.length > 0 || visiblePhase !== 'idle';
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    scrollViewportRef.current = { width: element.clientWidth, height: element.clientHeight };
    // Keep the latest reply in view when a window or composer changes size.
    // A reader who scrolled into history retains their place.
    const observer = new ResizeObserver(() => {
      scrollViewportRef.current = { width: element.clientWidth, height: element.clientHeight };
      if (atBottomRef.current && followLatestRef.current) element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [atBottomRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !atBottomRef.current || (viewMessages.length === 0 && visiblePhase === 'idle')) return;
    const frame = window.requestAnimationFrame(() => {
      if (atBottomRef.current) element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [viewMessages, visiblePhase, atBottomRef]);

  const onDraftRendered = useCallback(() => {
    const element = scrollRef.current;
    if (element && atBottomRef.current) element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
  }, [atBottomRef]);
  const onScrollAtBottomChange = useCallback((atBottom: boolean) => {
    const element = scrollRef.current;
    const viewport = scrollViewportRef.current;
    // Resizing can emit scroll before ResizeObserver restores the bottom.
    if (!element || !viewport || (element.clientWidth === viewport.width && element.clientHeight === viewport.height)) atBottomRef.current = atBottom;
  }, [atBottomRef]);

  return { scrollRef, onDraftRendered, onScrollAtBottomChange };
}
