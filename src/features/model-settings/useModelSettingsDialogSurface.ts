import { useEffect, useLayoutEffect, useRef, useState, type FocusEventHandler, type KeyboardEventHandler } from 'react';
import type { SettingsStep } from './SettingsFlowNav';
// Narrow or short windows scroll the header, steps and editor as one region
// above a separate footer (model-settings.css); nothing is pinned over fields.
const dialogScroller = (outer: HTMLElement | null) =>
  outer && getComputedStyle(outer).overflowY === 'auto' && outer.scrollHeight > outer.clientHeight ? outer : null;
// Keyboard focus in a region-wide scroll keeps the focused control clear of the
// scroll edges. The WebView's own focus scroll ignores scroll margins.
const revealFocused = (outer: HTMLElement, target: HTMLElement) => {
  // Portalled menus bubble focus here through React but are not in this scroll.
  if (!outer.contains(target)) return;
  // A tab column pinned beside the editor in a short wide window is always in view.
  const tabs = target.closest<HTMLElement>('.model-settings-nav');
  if (tabs && getComputedStyle(tabs).position === 'sticky') return;
  const box = outer.getBoundingClientRect();
  const field = target.getBoundingClientRect();
  const gap = 16;
  const top = box.top + gap;
  const bottom = box.bottom - gap;
  if (field.top < top) outer.scrollTop -= top - field.top;
  else if (field.bottom > bottom) outer.scrollTop += Math.min(field.bottom - bottom, field.top - top);
};
// The region scroll position that starts the options layout (tabs, profile bar, editor) at the top.
const layoutStart = (outer: HTMLElement) => {
  const layout = outer.querySelector<HTMLElement>('.model-settings-layout');
  return layout ? outer.scrollTop + layout.getBoundingClientRect().top - outer.getBoundingClientRect().top : 0;
};
interface DialogSurfaceOptions {
  open: boolean; disabled: boolean; initialSection?: string; runtimeSelection: string;
  runtimeKey: string; profileId: string; profileDirty: boolean; setSection: (value: string) => void;
}

export function useModelSettingsDialogSurface({ open, disabled, initialSection, runtimeSelection, runtimeKey, profileId, profileDirty, setSection }: DialogSurfaceOptions) {
  const [tabOrientation, setTabOrientation] = useState<'horizontal' | 'vertical'>('vertical');
  const body = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const focusFrame = useRef<number | null>(null);
  useLayoutEffect(() => () => {
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = null;
  }, [open]);
  // Sections are tall; arriving at one part-scrolled from the last shows its
  // middle, which reads as a half-rendered panel. When the header, steps and
  // editor scroll as one region, the tabs and panel start return to the top
  // unless they are already in view.
  const showSection = (value: string) => {
    setSection(value); body.current?.scrollTo({ top: 0 });
    const outer = dialogScroller(scroller.current);
    if (!outer) return;
    const start = layoutStart(outer);
    if (start < outer.scrollTop) outer.scrollTo({ top: Math.max(0, start) });
  };
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const invoker = useRef<HTMLElement | null>(null);
  // The focused Cancel of a pending start is removed when the start settles.
  // Focus then returns to the start action (or the dialog title), not to the
  // page behind this still-open dialog; a focus moved elsewhere is kept.
  const startButton = useRef<HTMLButtonElement>(null);
  const cancelFocus = useRef(false);
  useLayoutEffect(() => {
    if (disabled || !cancelFocus.current) return;
    cancelFocus.current = false;
    const own = dialog.current;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (!own?.open || !lost || Array.from(document.querySelectorAll('dialog[open]')).at(-1) !== own) return;
    const start = startButton.current;
    (start && !start.disabled && !start.closest('[hidden], [inert]') ? start : heading.current)?.focus();
  }, [disabled]);
  // An explicit section is an existing-context deep link. Ordinary entry and
  // runtime repair begin at selection; an absent runtime can never be skipped.
  const firstStep: SettingsStep = !initialSection || ['setup', 'runtime'].includes(initialSection) ? 'runtime' : initialSection === 'profiles' ? 'profile' : 'options';
  const [flow, setFlow] = useState(() => ({ step: firstStep, runtime: firstStep === 'runtime' ? null : runtimeKey, profile: firstStep === 'options' ? profileId : null as string | null }));
  const [profilePreview, setProfilePreview] = useState<string | null>(null);
  const flowHeading = useRef<HTMLHeadingElement>(null);
  const canProfile = !!runtimeSelection && flow.runtime === runtimeKey;
  const canOptions = canProfile && flow.profile === profileId;
  const step: SettingsStep = !runtimeSelection || flow.step !== 'runtime' && !canProfile ? 'runtime' : flow.step === 'options' && !canOptions ? 'profile' : flow.step;
  // The new step is focused and back at its top in the commit that shows it,
  // before paint. Deferred to a frame, the focus scroll moved the painted step
  // under a pointer press already aimed at it.
  // Every step request sets a new flow, so the request is consumed by that commit.
  const stepFocus = useRef<{ previous: Element | null } | null>(null);
  const focusStepHeading = () => { stepFocus.current = { previous: document.activeElement }; };
  useLayoutEffect(() => {
    const request = stepFocus.current;
    if (!request) return;
    stepFocus.current = null;
    if (document.activeElement === request.previous || document.activeElement === document.body || document.activeElement === heading.current) flowHeading.current?.focus({ preventScroll: true });
    body.current?.scrollTo({ top: 0 });
    // A region-wide scroll also starts the step from the top, with its focused
    // heading moved into view.
    const outer = dialogScroller(scroller.current);
    if (outer) { outer.scrollTo({ top: 0 }); flowHeading.current?.scrollIntoView({ block: 'nearest' }); }
  }, [flow]);
  // In a region-wide scroll the options step opens with the header and steps
  // scrolled away and the tabs, profile bar (which names the model and
  // profile) and editor starting at the top. The header's model metadata can
  // still change height after this commit, so the start is kept until the
  // region is scrolled some other way.
  const optionsStep = step === 'options';
  useLayoutEffect(() => {
    const outer = scroller.current;
    const header = outer?.querySelector<HTMLElement>('.model-settings-header');
    const steps = outer?.querySelector<HTMLElement>('.model-settings-flow');
    if (!optionsStep || !outer || !header || !steps || typeof ResizeObserver === 'undefined') return;
    const syncTabOrientation = () => {
      const tabs = outer.querySelector<HTMLElement>('.model-settings-nav');
      if (tabs) setTabOrientation(getComputedStyle(tabs).flexDirection === 'row' ? 'horizontal' : 'vertical');
    };
    let entryTop: number | null = null;
    const alignEntry = () => {
      if (!dialogScroller(outer)) { entryTop = null; return; }
      outer.scrollTo({ top: Math.max(0, layoutStart(outer)) });
      entryTop = outer.scrollTop;
    };
    syncTabOrientation();
    alignEntry();
    const observer = new ResizeObserver(() => {
      syncTabOrientation();
      if (entryTop === null) return;
      if (outer.scrollTop === entryTop) alignEntry(); else entryTop = null;
    });
    observer.observe(header); observer.observe(steps);
    return () => observer.disconnect();
  }, [optionsStep]);
  const navigateStep = (next: SettingsStep) => {
    if (disabled || profileDirty || next === 'profile' && !canProfile || next === 'options' && !canOptions) return;
    setFlow(previous => ({ ...previous, step: next }));
    focusStepHeading();
  };
  const continueStep = () => {
    if (disabled || profileDirty || !runtimeSelection) return;
    setFlow({ step: step === 'runtime' ? 'profile' : 'options', runtime: runtimeKey, profile: step === 'runtime' ? null : profileId });
    focusStepHeading();
  };
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open) {
      if (!element.open) { invoker.current = document.activeElement as HTMLElement | null; element.showModal(); }
      // Focus the heading on the next frame, unless focus has moved to a control by then.
      const opened = document.activeElement;
      const frame = requestAnimationFrame(() => { if (document.activeElement === opened) heading.current?.focus(); });
      return () => cancelAnimationFrame(frame);
    } else if (element.open) { element.close(); invoker.current?.focus(); }
  }, [open]);
  useEffect(() => { const element = dialog.current; return () => { if (element?.open) element.close(); invoker.current?.focus(); }; }, []);
  const onDialogKeyDown: KeyboardEventHandler<HTMLDialogElement> = event => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])'))
        .filter(element => !element.closest('[hidden], [inert]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); heading.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const onDialogFocus: FocusEventHandler<HTMLDivElement> = event => {
        if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
        focusFrame.current = null;
        const outer = dialogScroller(event.currentTarget);
        const target = event.target;
        if (!outer || !(target instanceof HTMLElement)) return;
        revealFocused(outer, target);
        // WebKit scrolls interactive focus after dispatch. Recheck after that
        // scroll; programmatic step headings stay synchronous for pointer entry.
        if (!open || target.tabIndex < 0 || !outer.contains(target)) return;
        const own = dialog.current;
        focusFrame.current = requestAnimationFrame(() => {
          focusFrame.current = null;
          if (!own?.open || dialog.current !== own || scroller.current !== outer
            || !target.isConnected || document.activeElement !== target
            || target.closest('dialog') !== own || target.closest('[hidden], [inert]')
            || Array.from(document.querySelectorAll('dialog[open]')).at(-1) !== own) return;
          revealFocused(outer, target);
        });
  };
  return { dialog, heading, body, scroller, startButton, cancelFocus, flowHeading, tabOrientation, showSection, setFlow, profilePreview, setProfilePreview, canProfile, canOptions, step, navigateStep, continueStep, onDialogKeyDown, onDialogFocus };
}
