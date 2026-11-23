import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { discardAttachmentDrop, onAttachmentDrag, onAttachmentDrop, type AttachmentDropNotice } from '../../shared/api/commands';
import type { Locale } from '../../shared/i18n/i18nCatalog';
import { translate } from '../../shared/i18n/i18nUnified';

interface NativeAttachmentDropOptions {
  targetRef: RefObject<HTMLDivElement | null>;
  active: boolean;
  enabled: boolean;
  onDrop: (id: string, count: number) => void;
  setError: (message: string | null) => void;
  locale?: Locale;
}

/** Native coordinates are physical pixels relative to the webview. */
export function attachmentDropPoint(position: AttachmentDropNotice['position'], scale: number) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)
    || !Number.isFinite(scale) || scale <= 0) return null;
  return { x: position.x / scale, y: position.y / scale };
}

function pointInsideTarget(
  target: HTMLDivElement | null,
  position: { x: number; y: number } | undefined,
  active: boolean,
): boolean {
  const point = attachmentDropPoint(position as AttachmentDropNotice['position'], window.devicePixelRatio);
  if (!active || !target?.isConnected || !point || target.closest('[inert], [hidden]')) return false;
  const rect = target.getBoundingClientRect();
  const hit = document.elementFromPoint(point.x, point.y);
  // A settings dialog or another page must never attach to the hidden chat.
  return !(rect.width <= 0 || rect.height <= 0 || point.x < rect.left || point.x >= rect.right
    || point.y < rect.top || point.y >= rect.bottom || !hit || !target.contains(hit));
}

export function useNativeAttachmentDrop(options: NativeAttachmentDropOptions) {
  const [isDragOver, setIsDragOver] = useState(false);
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  useEffect(() => {
    if (!options.active || !options.enabled) setIsDragOver(false);
  }, [options.active, options.enabled]);
  useEffect(() => {
    let disposed = false;
    let unlistenDrop: (() => void) | undefined;
    let unlistenDrag: (() => void) | undefined;
    const dropError = (key: 'attachmentDropBusy' | 'attachmentDropUnreadable' | 'attachmentDropUnavailable') => {
      const currentLocale = latest.current.locale ?? 'en';
      return translate(currentLocale, 'chat.attachmentError', { error: translate(currentLocale, `chat.${key}`) });
    };
    const subscription = onAttachmentDrop(notice => {
      if (disposed || !notice) return;
      setIsDragOver(false);
      const discard = () => {
        if (typeof notice.id === 'string') void discardAttachmentDrop(notice.id).catch(() => undefined);
      };
      const { targetRef, active, enabled, onDrop, setError, locale = 'en' } = latest.current;
      const target = targetRef.current;
      if (!pointInsideTarget(target, notice.position, active)) { discard(); return; }
      if (!enabled) {
        discard();
        setError(dropError('attachmentDropBusy'));
        return;
      }
      if (notice.error || typeof notice.id !== 'string' || !Number.isInteger(notice.count) || notice.count < 1 || notice.count > 64) {
        discard();
        setError(translate(locale, 'chat.attachmentError', {
          error: notice.error || translate(locale, 'chat.attachmentDropUnreadable'),
        }));
        return;
      }
      onDrop(notice.id, notice.count);
    });
    void subscription.then(stop => { if (disposed) stop(); else unlistenDrop = stop; })
      .catch(() => { if (!disposed) latest.current.setError(dropError('attachmentDropUnavailable')); });

    if (typeof onAttachmentDrag === 'function') {
      const dragSubscription = onAttachmentDrag(notice => {
        if (disposed || !notice) return;
        const { targetRef, active, enabled } = latest.current;
        if (notice.state === 'leave' || !active || !enabled) {
          setIsDragOver(false);
          return;
        }
        setIsDragOver(pointInsideTarget(targetRef.current, notice.position, active));
      });
      void dragSubscription.then(stop => { if (disposed) stop(); else unlistenDrag = stop; }).catch(() => undefined);
    }

    return () => {
      disposed = true;
      unlistenDrop?.();
      unlistenDrag?.();
    };
  }, []);
  return { isDragOver };
}
