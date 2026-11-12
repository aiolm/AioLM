import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { normalizeDisplayText } from "../lib/displayPaths";
import type { CustomSelectOption, CustomSelectProps } from "./CustomSelect";
import { useCustomSelectPosition } from "./useCustomSelectPosition";

function associatedLabels(trigger: HTMLButtonElement | HTMLInputElement | null): HTMLLabelElement[] {
  if (!trigger) return [];
  const root = trigger.getRootNode();
  if (!("querySelectorAll" in root)) return [];
  const id = trigger.id;
  // CSS selectors replace nulls and unpaired surrogates, so these rare IDs
  // need the native lookup to retain their exact DOM value.
  if (/[\u0000\ud800-\udfff]/u.test(id)) return Array.from(trigger.labels ?? []);
  const escapedId = id.replace(/[\u0001-\u001f\u007f"\\\u{10000}-\u{10ffff}]/gu, character => `\\${character.codePointAt(0)!.toString(16)} `);
  // Only explicit labels can be outside the control's ancestors. Keep their
  // lookup selective rather than inspecting every label on every editor commit.
  const labels = id
    ? Array.from((root as ParentNode).querySelectorAll<HTMLLabelElement>(`label[for="${escapedId}"]`))
    : [];
  for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
    if (parent.localName === "label" && !labels.includes(parent as HTMLLabelElement)) labels.push(parent as HTMLLabelElement);
  }
  // Native resolution retains duplicate-id, namespaced attribute and first
  // labelable-child rules. Ancestor labels must rejoin explicit labels in tree order.
  return labels.filter(label => label.control === trigger)
    .sort((left, right) => left === right ? 0 : left.compareDocumentPosition(right) & 4 ? -1 : 1);
}

type CustomSelectControllerOptions<T extends string | number> = Pick<CustomSelectProps<T>,
  "id" | "value" | "options" | "onChange" | "onInputChange" | "disabled" | "className"
  | "triggerClassName" | "menuClassName" | "size" | "portalContainer"> & {
  overlayContainer: HTMLElement | null;
};

export function useCustomSelectController<T extends string | number>({
  id, value, options, onChange, onInputChange, disabled = false, className,
  triggerClassName, menuClassName, size, portalContainer, overlayContainer,
}: CustomSelectControllerOptions<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const editable = !!onInputChange;
  const normalizedQuery = query ? query.toLocaleLowerCase() : '';
  const visibleOptions = editable && query
    ? options.filter(option => normalizeDisplayText(option.label).toLocaleLowerCase().includes(normalizedQuery))
    : options;
  const open = isOpen && !disabled && visibleOptions.length > 0;
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | HTMLInputElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const setTriggerRef = useCallback((element: HTMLButtonElement | HTMLInputElement | null) => {
    triggerRef.current = element;
  }, []);
  const boundLabelsRef = useRef<HTMLLabelElement[]>([]);
  const [labelName, setLabelName] = useState<string>();
  const selected = options.find((opt) => opt.value === value) || options[0];
  const generatedId = useId();
  const listboxId = `${id ?? generatedId}-listbox`;
  const selectedIndex = visibleOptions.findIndex((opt) => opt.value === value);
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);
  const typeaheadRef = useRef<{ query: string; timer: ReturnType<typeof setTimeout> | null }>({ query: "", timer: null });
  const controlDisabled = () => disabled || !!triggerRef.current?.matches(':disabled');

  useEffect(() => {
    const buffer = typeaheadRef.current;
    return () => { clearTimeout(buffer.timer ?? undefined); };
  }, []);

  useEffect(() => { if (disabled) setIsOpen(false); }, [disabled]);

  const focusFromLabel = useCallback((event: MouseEvent) => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const target = event.target;
    if (!(target instanceof Node) || trigger.contains(target)) return;
    const element = target instanceof Element ? target : target.parentElement;
    if (element?.closest("button, input, select, textarea, a[href], summary, [contenteditable='true']")) return;

    // Labels retain their accessible name and focus behavior without forwarding
    // a second activation to the dropdown button.
    event.preventDefault();
    if (!trigger.matches(':disabled')) trigger.focus();
  }, []);

  // This intentionally runs after every commit: associated labels can be replaced
  // without changing the control props, so dependency-based binding misses them.
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const labels = associatedLabels(trigger);
    const previousLabels = boundLabelsRef.current;
    const labelsChanged = labels.length !== previousLabels.length || labels.some((label) => !previousLabels.includes(label));
    if (labelsChanged) {
      previousLabels.forEach((label) => {
        if (!labels.includes(label)) label.removeEventListener("click", focusFromLabel);
      });
      labels.forEach((label) => {
        if (!previousLabels.includes(label)) label.addEventListener("click", focusFromLabel);
      });
      boundLabelsRef.current = labels;
    }
  });

  useLayoutEffect(() => () => {
    boundLabelsRef.current.forEach((label) => label.removeEventListener("click", focusFromLabel));
    boundLabelsRef.current = [];
  }, [focusFromLabel]);

  const { menuPosition, setMenuPosition, updateMenuPosition } = useCustomSelectPosition({
    open, editable, value, overlayContainer, portalContainer, className, menuClassName,
    size, triggerClassName, triggerRef, menuRef,
  });

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

  const openingSelection = useRef({ value, visibleOptions });
  openingSelection.current = { value, visibleOptions };

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }

    // Keyboard navigation only moves the highlight while open; re-seed it from the
    // committed value each time the listbox opens so a previous preview never leaks in.
    const selection = openingSelection.current;
    setHighlightedIndex(selection.visibleOptions.findIndex((opt) => opt.value === selection.value));
    // A portalled listbox is outside the native <label>, so it repeats the label's
    // own text; a wrapping label's copy of the trigger (the selected value) is dropped.
    setLabelName(associatedLabels(triggerRef.current).map((label) => {
      const copy = label.cloneNode(true) as HTMLLabelElement;
      copy.querySelectorAll(".app-custom-select-container").forEach((element) => element.remove());
      return copy.textContent?.trim();
    }).filter(Boolean).join(" ") || undefined);
    const handleViewportChange = () => updateMenuPosition();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [open, setMenuPosition, updateMenuPosition]);

  useLayoutEffect(() => {
    if (open && highlightedIndex >= 0) menuRef.current?.children[highlightedIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [open, highlightedIndex]);

  /** Finds the next enabled option at or after `from` (wrapping), matching `predicate`. */
  const findEnabledOption = (from: number, step: number, predicate: (opt: CustomSelectOption<T>) => boolean) => {
    for (let offset = 0; offset < visibleOptions.length; offset += 1) {
      const index = ((from + step * offset) % visibleOptions.length + visibleOptions.length) % visibleOptions.length;
      const option = visibleOptions[index];
      if (option && !option.disabled && predicate(option)) return index;
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
    clearTimeout(buffer.timer ?? undefined);
    buffer.query = `${buffer.query}${char.toLowerCase()}`;
    buffer.timer = setTimeout(() => { buffer.query = ""; }, 700);
    const matches = (opt: CustomSelectOption<T>) => opt.label.toLocaleLowerCase().startsWith(buffer.query);
    const searchFrom = open ? highlightedIndex + 1 : selectedIndex + 1;
    let match = findEnabledOption(searchFrom, 1, matches);
    // A repeated single letter (e.g. "d", "d") should still find something even if
    // it only matches the option already active, so retry from the start once.
    if (match === -1 && buffer.query.length > 1) match = findEnabledOption(0, 1, matches);
    const option = visibleOptions[match];
    if (!option) return;
    if (open) setHighlightedIndex(match);
    else onChange(option.value);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
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

  const toggle = () => {
    if (controlDisabled()) return;
    setQuery('');
    setIsOpen(previous => !previous);
    triggerRef.current?.focus();
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!containerRef.current?.contains(event.relatedTarget) && !menuRef.current?.contains(event.relatedTarget)) setIsOpen(false);
  };

  const openEditable = () => {
    if (!controlDisabled()) { setQuery(''); setIsOpen(true); }
  };

  const changeInput = (next: string) => {
    onInputChange?.(next);
    setQuery(next);
    setHighlightedIndex(-1);
    setIsOpen(true);
  };

  const selectOption = (option: CustomSelectOption<T>) => {
    if (option.disabled || controlDisabled()) return;
    onChange(option.value);
    setQuery('');
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.currentTarget.click();
  };

  return {
    open, editable, visibleOptions, selected, highlightedIndex, listboxId, labelName,
    menuPosition, containerRef, menuRef, setTriggerRef, setHighlightedIndex,
    handleKeyDown, handleOptionKeyDown, handleBlur, toggle, openEditable, changeInput, selectOption,
  };
}
