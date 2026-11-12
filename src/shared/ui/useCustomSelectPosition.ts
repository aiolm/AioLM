import { useCallback, useLayoutEffect, useState, type RefObject } from "react";
import type { CustomSelectProps } from "./CustomSelect";

interface DropdownPosition {
  top: number;
  left: number;
  minWidth: number;
  maxWidth: string;
  maxHeight: number;
  opensAbove: boolean;
}

const MENU_EDGE = 8;
/** Longest line a menu grows to for options wider than their trigger. */
const MENU_READABLE_WIDTH = "30rem";

interface CustomSelectPositionOptions extends Pick<CustomSelectProps,
  "className" | "menuClassName" | "portalContainer" | "size" | "triggerClassName"> {
  open: boolean;
  editable: boolean;
  value: string | number;
  overlayContainer: HTMLElement | null;
  triggerRef: RefObject<HTMLButtonElement | HTMLInputElement | null>;
  menuRef: RefObject<HTMLUListElement | null>;
}

export function useCustomSelectPosition({
  open, editable, value, overlayContainer, portalContainer, className, menuClassName,
  size, triggerClassName, triggerRef, menuRef,
}: CustomSelectPositionOptions) {
  const [menuPosition, setMenuPosition] = useState<DropdownPosition | null>(null);
  const menuMounted = menuPosition !== null;
  const canObserveResize = typeof ResizeObserver !== 'undefined';

  const clampMenuLeft = useCallback((left: number) => {
    const menu = menuRef.current;
    if (!menu) return Math.max(MENU_EDGE, left);
    return Math.max(MENU_EDGE, Math.min(Math.max(MENU_EDGE, left), window.innerWidth - MENU_EDGE - menu.getBoundingClientRect().width));
  }, [menuRef]);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const edge = MENU_EDGE;
    const gap = 4;
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - edge - gap);
    const spaceAbove = Math.max(0, rect.top - edge - gap);
    const opensAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
    const availableSpace = opensAbove ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(64, Math.min(240, availableSpace || 64));
    const viewportWidth = Math.max(0, window.innerWidth - edge * 2);
    const minWidth = Math.min(rect.width, viewportWidth);

    const nextPosition: DropdownPosition = {
      top: opensAbove ? rect.top - gap : rect.bottom + gap,
      // Aligned with the trigger until the rendered width is known (see below).
      left: clampMenuLeft(rect.left),
      // A narrow trigger must not squeeze long options into a column a few
      // characters wide: the menu grows to its longest option, up to a readable
      // line length and never beyond the viewport.
      minWidth,
      maxWidth: `max(${minWidth}px, min(${viewportWidth}px, ${MENU_READABLE_WIDTH}))`,
      maxHeight,
      opensAbove,
    };
    setMenuPosition(previous => previous
      && previous.top === nextPosition.top
      && previous.left === nextPosition.left
      && previous.minWidth === nextPosition.minWidth
      && previous.maxWidth === nextPosition.maxWidth
      && previous.maxHeight === nextPosition.maxHeight
      && previous.opensAbove === nextPosition.opensAbove
      ? previous
      : nextPosition);
  }, [clampMenuLeft, triggerRef]);

  const alignMenuLeft = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const leftLimit = window.innerWidth - MENU_EDGE - menu.getBoundingClientRect().width;
    setMenuPosition(previous => {
      if (!previous) return previous;
      const left = Math.max(MENU_EDGE, Math.min(Math.max(MENU_EDGE, previous.left), leftLimit));
      return left === previous.left ? previous : { ...previous, left };
    });
  }, [menuRef]);

  useLayoutEffect(() => {
    if (!open) return;
    updateMenuPosition();
  }, [className, editable, menuClassName, open, overlayContainer, portalContainer, size, triggerClassName, updateMenuPosition, value]);

  // The menu's width follows its options, so its far edge is only known once it
  // is rendered: shift it toward the start just enough to stay inside the viewport.
  useLayoutEffect(() => {
    if (!open || !menuPosition || !canObserveResize) return;
    alignMenuLeft();
  }, [alignMenuLeft, canObserveResize, menuPosition, open]);

  // Legacy WebViews without ResizeObserver need the original render-driven
  // measurement path because mutable option arrays and CSS-only changes have no observer signal.
  // This intentionally has no dependency list so same-reference option mutations are measured.
  useLayoutEffect(() => {
    if (!open || !menuPosition || canObserveResize) return;
    updateMenuPosition();
  });

  useLayoutEffect(() => {
    if (!open || !menuMounted || !canObserveResize) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const observer = new ResizeObserver(() => {
      updateMenuPosition();
    });
    observer.observe(trigger);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [canObserveResize, menuMounted, menuRef, open, triggerRef, updateMenuPosition]);

  return { menuPosition, setMenuPosition, updateMenuPosition };
}
