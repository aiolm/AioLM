/** Prepare initial reads before exposing a surface. Refreshes preserve the
 * displayed surface, including its selection, draft and scroll position. */
let sequence = 0;
const pending = new Set<number>();
export const currentLayoutRead = () => sequence;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export async function trackInitialRead<T>(read: () => Promise<T>): Promise<T> {
  const id = ++sequence;
  pending.add(id);
  notify();
  try { return await read(); }
  finally { pending.delete(id); notify(); }
}

export function afterInitialLayout(
  ready: () => void,
  frame: typeof requestAnimationFrame = requestAnimationFrame,
  cancel: typeof cancelAnimationFrame = cancelAnimationFrame,
  afterRead = 0,
): () => void {
  let frameId = 0;
  let disposed = false;
  const waiting = () => [...pending].some(id => id > afterRead);
  const dispose = () => { disposed = true; cancel(frameId); listeners.delete(check); };
  const check = () => {
    cancel(frameId);
    if (disposed || waiting()) return;
    // React must commit results and start dependent reads before exposure.
    // Paint boundaries replace guessed network/loading delays.
    frameId = frame(() => {
      if (disposed || waiting()) return;
      frameId = frame(() => {
        if (disposed || waiting()) return;
        dispose();
        ready();
      });
    });
  };
  listeners.add(check);
  check();
  return dispose;
}
