import type { StreamingDraft } from "./chatSendTypes";

export interface StreamingDraftStore {
  getSnapshot: () => StreamingDraft | null;
  subscribe: (listener: () => void) => () => void;
  setDraft: (next: StreamingDraft | null) => void;
}

/** Only the in-flight bubble subscribes; the panel keeps a stable store handle. */
export function createStreamingDraftStore(): StreamingDraftStore {
  let draft: StreamingDraft | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => draft,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setDraft: (next: StreamingDraft | null) => {
      if (draft === next) return;
      draft = next;
      for (const listener of listeners) listener();
    },
  };
}
