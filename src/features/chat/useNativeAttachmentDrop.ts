import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { discardAttachmentDrop, onAttachmentDrop, type AttachmentDropNotice } from '../../shared/api/commands';

interface NativeAttachmentDropOptions {
  targetRef: RefObject<HTMLDivElement | null>;
  active: boolean;
  enabled: boolean;
  onDrop: (id: string, count: number) => void;
  setError: (message: string | null) => void;
}

/** Native coordinates are physical pixels relative to the webview. */
export function attachmentDropPoint(position: AttachmentDropNotice['position'], scale: number) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)
    || !Number.isFinite(scale) || scale <= 0) return null;
  return { x: position.x / scale, y: position.y / scale };
}

export function useNativeAttachmentDrop(options: NativeAttachmentDropOptions) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const subscription = onAttachmentDrop(notice => {
      if (disposed || !notice) return;
      const discard = () => {
        if (typeof notice.id === 'string') void discardAttachmentDrop(notice.id).catch(() => undefined);
      };
      const { targetRef, active, enabled, onDrop, setError } = latest.current;
      const target = targetRef.current;
      const point = attachmentDropPoint(notice.position, window.devicePixelRatio);
      if (!active || !target?.isConnected || !point || target.closest('[inert], [hidden]')) { discard(); return; }
      const rect = target.getBoundingClientRect();
      const hit = document.elementFromPoint(point.x, point.y);
      // A settings dialog or another page must never attach to the hidden chat.
      if (rect.width <= 0 || rect.height <= 0 || point.x < rect.left || point.x >= rect.right
        || point.y < rect.top || point.y >= rect.bottom || !hit || !target.contains(hit)) { discard(); return; }
      if (!enabled) {
        discard();
        setError('File attachment failed: Finish the current response or attachment, and use a running chat model before dropping files.');
        return;
      }
      if (notice.error || typeof notice.id !== 'string' || !Number.isInteger(notice.count) || notice.count < 1 || notice.count > 64) {
        discard();
        setError(`File attachment failed: ${notice.error || 'The native file drop could not be read. Please choose the files again.'}`);
        return;
      }
      onDrop(notice.id, notice.count);
    });
    void subscription.then(stop => { if (disposed) stop(); else unlisten = stop; })
      .catch(() => { if (!disposed) latest.current.setError('File attachment failed: Native file drops are unavailable. Use Attach file to choose a file.'); });
    return () => { disposed = true; unlisten?.(); };
  }, []);
}
