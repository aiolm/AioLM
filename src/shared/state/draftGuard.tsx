import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import ConfirmDialog from '../ui/ConfirmDialog';
import { useI18n } from '../i18n/i18n';
import { executionText } from '../i18n/executionI18n';

export interface EditorDraft {
  dirty: boolean;
  priority?: number;
  save: () => Promise<boolean>;
  discard: () => void;
}
type Guard = {
  register: (get: () => EditorDraft) => () => void;
  run: (action: () => Promise<void>) => Promise<boolean>;
};
const DraftContext = createContext<Guard>({ register: () => () => {}, run: async action => { await action(); return true; } });
export const useDraftGuard = () => useContext(DraftContext);

export function useEditorDraft(draft: EditorDraft) {
  const latest = useRef(draft);
  latest.current = draft;
  const { register } = useDraftGuard();
  useEffect(() => register(() => latest.current), [register]);
}

export function DraftGuardProvider({ children }: { children: ReactNode }) {
  const { locale, t } = useI18n();
  const copy = executionText[locale];
  const editors = useRef(new Set<() => EditorDraft>());
  const locked = useRef(false);
  const [pending, setPending] = useState<{ action: () => Promise<void>; resolve: (value: boolean) => void; reject: (error: unknown) => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [guard] = useState<Guard>(() => ({
    register: get => { editors.current.add(get); return () => { editors.current.delete(get); }; },
    run: async action => {
      if (locked.current) return false;
      locked.current = true;
      if ([...editors.current].some(get => get().dirty)) {
        return new Promise<boolean>((resolve, reject) => { setError(''); setPending({ action, resolve, reject }); });
      }
      try { await action(); return true; } finally { locked.current = false; }
    },
  }));
  const finish = async (save: boolean) => {
    if (!pending || busy) return;
    setBusy(true); setError('');
    try {
      for (const get of [...editors.current].sort((a, b) => (a().priority ?? 0) - (b().priority ?? 0))) {
        const editor = get();
        if (!editor.dirty) continue;
        if (save) { if (!await editor.save()) { setError(copy.invalidDraft); return; } }
        else editor.discard();
      }
      await pending.action();
      pending.resolve(true); setPending(null); locked.current = false;
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <DraftContext.Provider value={guard}>
    {children}
    <ConfirmDialog open={!!pending} title={copy.unsavedTitle} tone="primary" busy={busy}
      description={<><p>{copy.unsavedBody}</p>{error && <p role="alert" className="text-error">{error}</p>}
        <button type="button" className="app-button app-button--ghost" disabled={busy} onClick={() => void finish(false)}>{copy.discardContinue}</button></>}
      confirmLabel={copy.saveContinue} cancelLabel={t('common.cancel')} onConfirm={() => void finish(true)}
      onCancel={() => { pending?.resolve(false); setPending(null); locked.current = false; }} />
  </DraftContext.Provider>;
}
