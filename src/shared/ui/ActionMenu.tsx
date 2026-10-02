import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { OverlayContainerContext } from "./CustomSelect";

export interface ActionMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  tone?: "danger";
  /** Not available: the item stays focusable and says why, but does nothing. */
  disabled?: boolean;
  /** Available only to report why it cannot run: activation still calls onSelect. */
  blocked?: boolean;
  /** Visible reason shown under the label and announced as its description. */
  description?: string | null;
  onSelect: () => void;
}

interface Props {
  /** Accessible name of the trigger, naming the object the actions apply to. */
  label: string;
  items: ActionMenuItem[];
  className?: string;
}

interface MenuPosition { top: number; left: number; opensAbove: boolean }

const EDGE = 8;
const GAP = 4;

/** An always-visible ellipsis button that opens a small menu of row actions.
 * Focus moves into the menu, arrows and Home/End move between items, Escape,
 * Tab or a pointer outside close it, and focus returns to the trigger. */
export default function ActionMenu({ label, items, className = "" }: Props) {
  const overlayContainer = useContext(OverlayContainerContext);
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom - EDGE - GAP;
    const opensAbove = spaceBelow < height && rect.top - EDGE - GAP > spaceBelow;
    // Align the menu's end edge with the trigger's, then keep it on screen.
    const left = Math.min(Math.max(EDGE, rect.right - width), Math.max(EDGE, window.innerWidth - EDGE - width));
    const top = opensAbove ? Math.max(EDGE, rect.top - GAP - height) : Math.min(rect.bottom + GAP, Math.max(EDGE, window.innerHeight - EDGE - height));
    setPosition({ top, left, opensAbove });
  }, []);

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onNavigate = () => close(false);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("aiolm:navigate", onNavigate);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("aiolm:navigate", onNavigate);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']")[focusIndex]?.focus();
  }, [open, focusIndex, position]);

  const openAt = (index: number) => { setFocusIndex(index); setOpen(true); };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); openAt(0); }
    else if (event.key === "ArrowUp") { event.preventDefault(); openAt(items.length - 1); }
  };

  const activate = (item: ActionMenuItem) => {
    if (item.disabled) return;
    close(true);
    item.onSelect();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = items.length - 1;
    if (event.key === "ArrowDown") { event.preventDefault(); setFocusIndex((i) => (i >= last ? 0 : i + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setFocusIndex((i) => (i <= 0 ? last : i - 1)); }
    else if (event.key === "Home") { event.preventDefault(); setFocusIndex(0); }
    else if (event.key === "End") { event.preventDefault(); setFocusIndex(last); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === "Tab") { event.preventDefault(); close(true); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(items[focusIndex]); }
  };

  const menu = open && <div
    ref={menuRef}
    id={menuId}
    role="menu"
    aria-label={label}
    className={`app-action-menu${position?.opensAbove ? " is-above" : ""}`}
    // Measured before it is placed; opacity (not visibility) keeps items focusable.
    style={position ? { top: position.top, left: position.left } : { top: 0, left: 0, opacity: 0, pointerEvents: "none" }}
    onKeyDown={onMenuKeyDown}
  >
    {items.map((item, index) => {
      const labelId = `${menuId}-${item.id}-label`;
      const descriptionId = item.description ? `${menuId}-${item.id}-reason` : undefined;
      return <div
        key={item.id}
        role="menuitem"
        tabIndex={index === focusIndex ? 0 : -1}
        aria-disabled={item.disabled || item.blocked ? "true" : undefined}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        className={`app-action-menu__item${item.tone === "danger" ? " is-danger" : ""}`}
        onClick={() => activate(item)}
        onMouseEnter={() => setFocusIndex(index)}
      >
        {item.icon && <span className="app-action-menu__icon" aria-hidden="true">{item.icon}</span>}
        <span className="app-action-menu__copy">
          <span id={labelId}>{item.label}</span>
          {item.description && <span id={descriptionId} className="app-action-menu__reason">{item.description}</span>}
        </span>
      </div>;
    })}
  </div>;

  return <>
    <button
      ref={triggerRef}
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      className={`app-icon-button app-action-menu-trigger ${className}`.trim()}
      onClick={() => (open ? close(false) : openAt(0))}
      onKeyDown={onTriggerKeyDown}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" fill="currentColor"><circle cx="4.5" cy="10" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="15.5" cy="10" r="1.6" /></svg>
    </button>
    {menu && createPortal(menu, overlayContainer ?? document.body)}
  </>;
}
