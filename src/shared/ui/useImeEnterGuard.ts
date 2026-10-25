import { useEffect, useRef, type KeyboardEventHandler, type SyntheticEvent } from 'react';
import { createImeEnterGuard } from '../lib/imeEnterGuard';

/** Shares native composition ordering and interaction resets across text fields. */
export function useImeEnterGuard<T extends HTMLInputElement | HTMLTextAreaElement>(value: string, onKeyDown: KeyboardEventHandler<T>) {
  const guardRef = useRef<ReturnType<typeof createImeEnterGuard> | null>(null);
  if (guardRef.current === null) guardRef.current = createImeEnterGuard(value);
  const guard = guardRef.current;
  useEffect(() => { if (!value) guard.reset(value); }, [guard, value]);
  const reset = (event: SyntheticEvent<T>) => guard.reset(event.currentTarget.value);

  return {
    onInput: (event: SyntheticEvent<T>) => guard.input(event.nativeEvent as InputEvent, event.currentTarget.value),
    onCompositionStart: () => guard.compositionStart(),
    onCompositionEnd: () => guard.compositionEnd(),
    onPointerDown: reset,
    onMouseDown: reset,
    onBlur: reset,
    onFocus: reset,
    onKeyUp: (event: React.KeyboardEvent<T>) => guard.keyUp(event.nativeEvent),
    onKeyDown: (event: React.KeyboardEvent<T>) => {
      const decision = guard.keyDown(event.nativeEvent);
      if (decision.preventDefault) event.preventDefault();
      if (!decision.skipAction) onKeyDown(event);
    },
  };
}
