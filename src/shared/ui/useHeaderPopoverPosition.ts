import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

const HEADER_POPOVER_OPEN_EVENT = "aiolm:header-popover-open";

export function useExclusiveHeaderPopover(id: string, open: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const handleOtherOpen = (event: Event) => {
      const openedId = (event as CustomEvent<string>).detail;
      if (openedId && openedId !== id) onCloseRef.current();
    };
    window.addEventListener(HEADER_POPOVER_OPEN_EVENT, handleOtherOpen);
    return () => window.removeEventListener(HEADER_POPOVER_OPEN_EVENT, handleOtherOpen);
  }, [id]);

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent<string>(HEADER_POPOVER_OPEN_EVENT, { detail: id }));
  }, [id, open]);
}

export interface HeaderPopoverPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const VIEWPORT_EDGE = 8;
const TRIGGER_GAP = 6;
const DEFAULT_WIDTH = 420;

export function headerPopoverStyle(position: HeaderPopoverPosition | null): CSSProperties {
  if (!position) return { visibility: "hidden", pointerEvents: "none" };
  return {
    top: `${position.top}px`,
    left: `${position.left}px`,
    right: "auto",
    width: `${position.width}px`,
    maxHeight: `${position.maxHeight}px`,
  };
}

export function useHeaderPopoverPosition({
  open,
  triggerRef,
  panelRef,
  preferredWidth = DEFAULT_WIDTH,
  align = "end",
}: {
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  preferredWidth?: number;
  align?: "start" | "end";
}) {
  const [position, setPosition] = useState<HeaderPopoverPosition | null>(null);

  const update = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(preferredWidth, Math.max(240, viewportWidth - VIEWPORT_EDGE * 2));
    const panelWidth = width;

    const idealLeft = align === "start" ? rect.left : rect.right - panelWidth;
    const left = Math.max(
      VIEWPORT_EDGE,
      Math.min(idealLeft, viewportWidth - VIEWPORT_EDGE - panelWidth),
    );

    const rawSpaceBelow = Math.max(0, viewportHeight - rect.bottom - TRIGGER_GAP - VIEWPORT_EDGE);
    const rawSpaceAbove = Math.max(0, rect.top - TRIGGER_GAP - VIEWPORT_EDGE);
    const openAbove = rawSpaceBelow < 220 && rawSpaceAbove > rawSpaceBelow;
    const availableHeight = openAbove ? rawSpaceAbove : rawSpaceBelow;
    const maxHeight = Math.max(80, Math.min(460, availableHeight));
    const panelHeight = Math.min(
      panelRef.current?.getBoundingClientRect().height || maxHeight,
      maxHeight,
    );
    const top = openAbove
      ? Math.max(VIEWPORT_EDGE, rect.top - TRIGGER_GAP - panelHeight)
      : Math.max(
          VIEWPORT_EDGE,
          Math.min(rect.bottom + TRIGGER_GAP, viewportHeight - VIEWPORT_EDGE - panelHeight),
        );

    setPosition((previous) =>
      previous &&
      previous.top === top &&
      previous.left === left &&
      previous.width === width &&
      previous.maxHeight === maxHeight
        ? previous
        : { top, left, width, maxHeight },
    );
  }, [align, panelRef, preferredWidth, triggerRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    update();
    const onResize = () => update();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    const observer =
      typeof ResizeObserver !== "undefined" && (panel || trigger)
        ? new ResizeObserver(onResize)
        : null;
    if (panel && observer) observer.observe(panel);
    if (trigger && observer) observer.observe(trigger);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
      observer?.disconnect();
    };
  }, [open, panelRef, triggerRef, update]);

  return position;
}
