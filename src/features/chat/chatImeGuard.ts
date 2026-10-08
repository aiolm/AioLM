/** Keeps an IME confirmation Enter separate from a later chat submission. */
export function createChatImeGuard(initialValue = '') {
  let phase: 'idle' | 'composing' | 'committed' = 'idle';
  let previousValue = initialValue;
  let enterHandled = false;

  const reset = (value = previousValue) => {
    phase = 'idle';
    enterHandled = false;
    previousValue = value;
  };

  return {
    reset,
    compositionStart() { phase = 'composing'; enterHandled = false; },
    compositionEnd() {
      // A pointer/blur reset or an already handled Enter must stay settled.
      if (phase !== 'idle' && !enterHandled) phase = 'committed';
    },
    input(event: Pick<InputEvent, 'inputType' | 'isComposing'>, value: string) {
      if (!value || ['insertFromPaste', 'insertFromDrop', 'historyUndo', 'historyRedo'].includes(event.inputType)) {
        reset(value);
      } else if (!enterHandled) {
        // A non-composing final input must keep a committed or reset state.
        if (event.isComposing) phase = 'composing';
        // WK can commit marked text without composition events, before Enter,
        // by replacing the existing text with the same value after a 229 key.
        else if (phase === 'composing' && (event.inputType === 'insertFromComposition'
          || (event.inputType === 'insertReplacementText' && value === previousValue))) phase = 'committed';
      }
      previousValue = value;
    },
    keyDown(event: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing'>) {
      if (event.isComposing || event.keyCode === 229) {
        if (event.key === 'Enter') { phase = 'idle'; enterHandled = true; }
        else { phase = 'composing'; enterHandled = false; }
        return { skipSend: true, preventDefault: false };
      }
      if (event.key === 'Enter' && (phase !== 'idle' || enterHandled)) {
        // Before commit, native default still needs to confirm marked text.
        // After commit, default would insert a newline into the settled draft.
        const preventDefault = phase === 'committed' || enterHandled;
        phase = 'idle';
        enterHandled = true;
        return { skipSend: true, preventDefault };
      }
      if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) reset();
      return { skipSend: false, preventDefault: false };
    },
    keyUp(event: Pick<KeyboardEvent, 'key'>) {
      if (event.key === 'Enter') enterHandled = false;
    },
  };
}
