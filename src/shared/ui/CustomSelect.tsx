import React, { createContext, useContext, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { normalizeDisplayText } from "../lib/displayPaths";
import { createPortal } from "react-dom";

/** Keep overlays inside a modal's top layer while retaining viewport positioning. */
export const OverlayContainerContext = createContext<HTMLElement | null>(null);

export interface CustomSelectOption<T extends string | number = string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface CustomSelectProps<T extends string | number = string> {
  id?: string;
  name?: string;
  value: T;
  options: CustomSelectOption<T>[];
  onChange: (value: T) => void;
  /** Allows free text alongside the same option menu used by fixed selections. */
  onInputChange?: (value: string) => void;
  placeholder?: string;
  spellCheck?: boolean;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  size?: "sm" | "md";
  portalContainer?: HTMLElement | null;
}

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  opensAbove: boolean;
}

export function CustomSelect<T extends string | number = string>({
  id,
  name,
  value,
  options,
  onChange,
  onInputChange,
  placeholder,
  spellCheck,
  disabled = false,
  className = "",
  triggerClassName = "",
  menuClassName = "",
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  "aria-label": ariaLabelKebab,
  "aria-labelledby": ariaLabelledByKebab,
  "aria-describedby": ariaDescribedByKebab,
  size = "md",
  portalContainer,
}: CustomSelectProps<T>) {
  const overlayContainer = useContext(OverlayContainerContext);
  const effectiveAriaLabel = ariaLabel ?? ariaLabelKebab;
  const effectiveAriaLabelledBy = ariaLabelledBy ?? ariaLabelledByKebab;
  const effectiveAriaDescribedBy = ariaDescribedBy ?? ariaDescribedByKebab;
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const editable = !!onInputChange;
  const visibleOptions = editable && query
    ? options.filter(option => normalizeDisplayText(option.label).toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    : options;
  const open = isOpen && !disabled && visibleOptions.length > 0;
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | HTMLInputElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [menuPosition, setMenuPosition] = useState<DropdownPosition | null>(null);
  const selected = options.find((opt) => opt.value === value) || options[0];
  const generatedId = useId();
  const listboxId = `${id ?? generatedId}-listbox`;
  const selectedIndex = visibleOptions.findIndex((opt) => opt.value === value);
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);
  const typeaheadRef = useRef<{ query: string; timer: ReturnType<typeof setTimeout> | null }>({ query: "", timer: null });
  const controlDisabled = () => disabled || !!triggerRef.current?.matches(':disabled');

  useEffect(() => {
    const buffer = typeaheadRef.current;
    return () => { if (buffer.timer) clearTimeout(buffer.timer); };
  }, []);

  useEffect(() => { if (disabled) setIsOpen(false); }, [disabled]);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const labels = Array.from(trigger.labels ?? []);
    const focusFromLabel = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || trigger.contains(target)) return;
      const element = target instanceof Element ? target : target.parentElement;
      if (element?.closest("button, input, select, textarea, a[href], summary, [contenteditable='true']")) return;

      // Labels retain their accessible name and focus behavior without forwarding
      // a second activation to the dropdown button.
      event.preventDefault();
      if (!trigger.matches(':disabled')) trigger.focus();
    };
    labels.forEach((label) => label.addEventListener("click", focusFromLabel));
    return () => labels.forEach((label) => label.removeEventListener("click", focusFromLabel));
  });

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const edge = 8;
    const gap = 4;
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - edge - gap);
    const spaceAbove = Math.max(0, rect.top - edge - gap);
    const opensAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
    const availableSpace = opensAbove ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(64, Math.min(240, availableSpace || 64));
    const width = Math.min(rect.width, Math.max(0, window.innerWidth - edge * 2));
    const maxLeft = Math.max(edge, window.innerWidth - edge - width);

    setMenuPosition({
      top: opensAbove ? rect.top - gap : rect.bottom + gap,
      left: Math.min(Math.max(edge, rect.left), maxLeft),
      width,
      maxHeight,
      opensAbove,
    });
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setIsOpen(false);
    }
    if (open) {
      document.addEventListener("pointerdown", handleClickOutside);
      window.addEventListener("aiolm:navigate", closeMenu);
    }
    function closeMenu() { setIsOpen(false); }
    return () => {
      document.removeEventListener("pointerdown", handleClickOutside);
      window.removeEventListener("aiolm:navigate", closeMenu);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }

    // Keyboard navigation only moves the highlight while open; re-seed it from the
    // committed value each time the listbox opens so a previous preview never leaks in.
    setHighlightedIndex(visibleOptions.findIndex((opt) => opt.value === value));
    updateMenuPosition();
    const handleViewportChange = () => updateMenuPosition();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, updateMenuPosition]);

  useLayoutEffect(() => {
    if (open && highlightedIndex >= 0) menuRef.current?.children[highlightedIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [open, highlightedIndex]);

  /** Finds the next enabled option at or after `from` (wrapping), matching `predicate`. */
  const findEnabledOption = (from: number, step: number, predicate: (opt: CustomSelectOption<T>) => boolean) => {
    for (let offset = 0; offset < visibleOptions.length; offset += 1) {
      const index = ((from + step * offset) % visibleOptions.length + visibleOptions.length) % visibleOptions.length;
      if (!visibleOptions[index].disabled && predicate(visibleOptions[index])) return index;
    }
    return -1;
  };

  const commitHighlighted = () => {
    const option = visibleOptions[highlightedIndex];
    if (option && !option.disabled && !controlDisabled()) onChange(option.value);
    setQuery('');
    setIsOpen(false);
  };

  const handleTypeahead = (char: string) => {
    const buffer = typeaheadRef.current;
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.query = `${buffer.query}${char.toLowerCase()}`;
    buffer.timer = setTimeout(() => { buffer.query = ""; }, 700);
    const matches = (opt: CustomSelectOption<T>) => opt.label.toLocaleLowerCase().startsWith(buffer.query);
    const searchFrom = open ? highlightedIndex + 1 : selectedIndex + 1;
    let match = findEnabledOption(searchFrom, 1, matches);
    // A repeated single letter (e.g. "d", "d") should still find something even if
    // it only matches the option already active, so retry from the start once.
    if (match === -1 && buffer.query.length > 1) match = findEnabledOption(0, 1, matches);
    if (match === -1) return;
    if (open) setHighlightedIndex(match);
    else onChange(visibleOptions[match].value);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (controlDisabled() || e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      if (open) { e.preventDefault(); e.stopPropagation(); }
      setIsOpen(false);
      return;
    }
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || (!editable && (e.key === "Enter" || e.key === " "))) {
        e.preventDefault();
        setQuery('');
        setIsOpen(true);
        return;
      }
      if (!editable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        handleTypeahead(e.key);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = findEnabledOption(highlightedIndex + 1, 1, () => true);
      if (next !== -1) setHighlightedIndex(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = findEnabledOption(highlightedIndex - 1, -1, () => true);
      if (prev !== -1) setHighlightedIndex(prev);
    } else if (!editable && e.key === "Home") {
      e.preventDefault();
      const first = findEnabledOption(0, 1, () => true);
      if (first !== -1) setHighlightedIndex(first);
    } else if (!editable && e.key === "End") {
      e.preventDefault();
      const last = findEnabledOption(visibleOptions.length - 1, -1, () => true);
      if (last !== -1) setHighlightedIndex(last);
    } else if (e.key === "Enter" || (!editable && e.key === " ")) {
      e.preventDefault();
      commitHighlighted();
    } else if (e.key === "Tab") {
      setIsOpen(false);
    } else if (!editable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      handleTypeahead(e.key);
    }
  };

  const isSm = size === "sm";
  const accessibility = {
    id, role: 'combobox' as const, 'aria-haspopup': 'listbox' as const, 'aria-expanded': open,
    'aria-controls': listboxId,
    'aria-activedescendant': open && visibleOptions[highlightedIndex] ? `${listboxId}-option-${highlightedIndex}` : undefined,
    'aria-label': effectiveAriaLabel, 'aria-labelledby': effectiveAriaLabelledBy, 'aria-describedby': effectiveAriaDescribedBy,
    disabled,
  };
  const triggerClasses = `app-custom-select-trigger app-custom-select-trigger--${size} ${triggerClassName}`;
  const toggle = () => {
    if (controlDisabled()) return;
    setQuery('');
    setIsOpen(previous => !previous);
    triggerRef.current?.focus();
  };
  const chevron = <svg className={`app-custom-select-chevron shrink-0 text-muted transition-transform duration-150 ${isSm ? 'h-3 w-3' : 'h-3.5 w-3.5'} ${open ? 'rotate-180 text-ink' : ''}`}
    fill="none" viewBox="0 0 20 20" stroke="currentColor" aria-hidden="true" focusable="false">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m6 8 4 4 4-4" />
  </svg>;

  return (
    <div
      ref={containerRef}
      className={`app-custom-select-container relative inline-block text-left ${className}`}
      onKeyDown={handleKeyDown}
      onBlur={event => {
        if (!containerRef.current?.contains(event.relatedTarget) && !menuRef.current?.contains(event.relatedTarget)) setIsOpen(false);
      }}
    >
      {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
      {editable ? <div className="app-custom-select-editable">
        <input {...accessibility} ref={element => { triggerRef.current = element; }}
          className={`${triggerClasses} app-custom-select-input`} aria-autocomplete="list" autoComplete="off"
          value={normalizeDisplayText(String(value))} placeholder={placeholder} spellCheck={spellCheck}
          onClick={() => { if (!controlDisabled()) { setQuery(''); setIsOpen(true); } }}
          onChange={event => {
            const next = event.target.value;
            onInputChange?.(next);
            setQuery(next);
            setHighlightedIndex(-1);
            setIsOpen(true);
          }} />
        <button type="button" className="app-custom-select-toggle" disabled={disabled} tabIndex={-1} aria-hidden="true"
          onMouseDown={event => event.preventDefault()} onClick={toggle}>{chevron}</button>
      </div> : <button
        {...accessibility}
        ref={element => { triggerRef.current = element; }}
        type="button"
        onClick={toggle}
        className={triggerClasses}
      >
        <span className="app-text-wrap flex items-center gap-1.5 min-w-0">
          {selected?.icon}
          <span className="app-text-wrap">{normalizeDisplayText(selected?.label ?? String(value))}</span>
        </span>
        {chevron}
      </button>}

      {open && menuPosition && createPortal(
        <ul
          ref={menuRef}
          id={listboxId}
          role="listbox"
          aria-label={effectiveAriaLabel}
          aria-labelledby={effectiveAriaLabelledBy}
          className={[`app-custom-dropdown-menu ${menuClassName}`, (menuPosition.opensAbove ? "ui-transform-translateY-100" : "")].filter(Boolean).join(" ")}
          style={{ top: menuPosition.top, left: menuPosition.left, width: menuPosition.width, maxHeight: menuPosition.maxHeight }}
        >
          {visibleOptions.map((opt, index) => {
            const isSelected = opt.value === value;
            const isHighlighted = index === highlightedIndex;
            return (
              <li
                key={String(opt.value)}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={opt.disabled}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => {
                  if (opt.disabled || controlDisabled()) return;
                  onChange(opt.value);
                  setQuery('');
                  setIsOpen(false);
                  triggerRef.current?.focus();
                }}
                className={`app-custom-dropdown-item ${isSelected || isHighlighted ? "is-selected" : ""} ${opt.disabled ? "opacity-40 cursor-not-allowed pointer-events-none" : ""}`}
              >
                <span className="app-text-wrap flex items-center gap-2 min-w-0">
                  {opt.icon}
                  <span className="app-text-wrap">{normalizeDisplayText(opt.label)}</span>
                </span>
                {isSelected && (
                  <svg className="app-custom-dropdown-check h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>,
        portalContainer ?? overlayContainer ?? document.body,
      )}
    </div>
  );
}
