import React, { createContext, useContext } from "react";
import { normalizeDisplayText } from "../lib/displayPaths";
import { createPortal } from "react-dom";
import { useCustomSelectController } from "./useCustomSelectController";

/** Keep overlays inside a modal's top layer while retaining viewport positioning. */
export const OverlayContainerContext = createContext<HTMLElement | null>(null);

export interface CustomSelectOption<T extends string | number = string> {
  value: T;
  label: string;
  title?: string;
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
  ariaInvalid?: React.AriaAttributes["aria-invalid"];
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
  size?: "sm" | "md";
  portalContainer?: HTMLElement | null;
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
  ariaInvalid,
  "aria-label": ariaLabelKebab,
  "aria-labelledby": ariaLabelledByKebab,
  "aria-describedby": ariaDescribedByKebab,
  "aria-invalid": ariaInvalidKebab,
  size = "md",
  portalContainer,
}: CustomSelectProps<T>) {
  const overlayContainer = useContext(OverlayContainerContext);
  const effectiveAriaLabel = ariaLabel ?? ariaLabelKebab;
  const effectiveAriaLabelledBy = ariaLabelledBy ?? ariaLabelledByKebab;
  const effectiveAriaDescribedBy = ariaDescribedBy ?? ariaDescribedByKebab;
  const {
    open, editable, visibleOptions, selected, highlightedIndex, listboxId, labelName,
    menuPosition, containerRef, menuRef, setTriggerRef, setHighlightedIndex,
    handleKeyDown, handleOptionKeyDown, handleBlur, toggle, openEditable, changeInput, selectOption,
  } = useCustomSelectController({
    id, value, options, onChange, onInputChange, disabled, className, triggerClassName,
    menuClassName, size, portalContainer, overlayContainer,
  });

  const accessibility = {
    id, role: 'combobox' as const, 'aria-haspopup': 'listbox' as const, 'aria-expanded': open,
    // Only point at the popup while it is rendered, so the reference never dangles.
    'aria-controls': open && menuPosition ? listboxId : undefined,
    'aria-activedescendant': open && menuPosition && visibleOptions[highlightedIndex] ? `${listboxId}-option-${highlightedIndex}` : undefined,
    'aria-label': effectiveAriaLabel, 'aria-labelledby': effectiveAriaLabelledBy, 'aria-describedby': effectiveAriaDescribedBy,
    'aria-invalid': ariaInvalid ?? ariaInvalidKebab,
    disabled,
  };
  const triggerClasses = `app-custom-select-trigger app-custom-select-trigger--${size} ${triggerClassName}`;
  const chevron = <svg className={`app-custom-select-chevron ${open ? 'is-open' : ''}`}
    fill="none" viewBox="0 0 20 20" stroke="currentColor" aria-hidden="true" focusable="false">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" d="m6 8 4 4 4-4" />
  </svg>;

  return (
    <div
      ref={containerRef}
      className={`app-custom-select-container relative inline-block text-left ${className}`}
      onBlur={handleBlur}
    >
      {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
      {editable ? <div className="app-custom-select-editable">
        <input {...accessibility} ref={setTriggerRef}
          onKeyDown={handleKeyDown}
          className={`${triggerClasses} app-custom-select-input`} aria-autocomplete="list" autoComplete="off"
          value={normalizeDisplayText(String(value))} placeholder={placeholder} spellCheck={spellCheck}
          onClick={openEditable}
          onChange={event => changeInput(event.target.value)} />
        <button type="button" className="app-custom-select-toggle" disabled={disabled} tabIndex={-1} aria-hidden="true"
          onMouseDown={event => event.preventDefault()} onClick={toggle}>{chevron}</button>
      </div> : <button
        {...accessibility}
        ref={setTriggerRef}
        type="button"
        onKeyDown={handleKeyDown}
        title={selected?.title ? normalizeDisplayText(selected.title) : undefined}
        onClick={toggle}
        className={triggerClasses}
      >
        <span className="app-custom-select-label flex items-center gap-1.5">
          {selected?.icon}
          <span className="app-custom-select-label">{normalizeDisplayText(selected?.label ?? String(value))}</span>
        </span>
        {chevron}
      </button>}

      {open && menuPosition && createPortal(
        <ul
          ref={menuRef}
          id={listboxId}
          role="listbox"
          aria-label={effectiveAriaLabel ?? (effectiveAriaLabelledBy ? undefined : labelName)}
          aria-labelledby={effectiveAriaLabelledBy}
          className={[`app-custom-dropdown-menu ${menuClassName}`, (menuPosition.opensAbove ? "ui-transform-translateY-100" : "")].filter(Boolean).join(" ")}
          style={{ top: menuPosition.top, left: menuPosition.left, width: "max-content", minWidth: menuPosition.minWidth, maxWidth: menuPosition.maxWidth, maxHeight: menuPosition.maxHeight }}
        >
          {visibleOptions.map((opt, index) => {
            const isSelected = opt.value === value;
            const isHighlighted = index === highlightedIndex;
            return (
              <li
                key={String(opt.value)}
                id={`${listboxId}-option-${index}`}
                role="option"
                title={opt.title ? normalizeDisplayText(opt.title) : undefined}
                aria-selected={isSelected}
                aria-disabled={opt.disabled}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setHighlightedIndex(index)}
                onKeyDown={handleOptionKeyDown}
                onClick={() => selectOption(opt)}
                className={`app-custom-dropdown-item ${isSelected ? "is-selected" : ""} ${isHighlighted ? "is-highlighted" : ""} ${opt.disabled ? "opacity-40 cursor-not-allowed pointer-events-none" : ""}`}
              >
                <span className="app-custom-select-label flex items-center gap-2">
                  {opt.icon}
                  <span className="app-custom-select-label">{normalizeDisplayText(opt.label)}</span>
                </span>
                {isSelected && (
                  <svg className="app-custom-dropdown-check shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true" focusable="false">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" d="m4.5 10.5 3.5 3.5 7.5-8" />
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
