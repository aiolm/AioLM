/** Classification sent with every typed native command rejection. */
export type IpcErrorKind =
  | 'cancelled'
  | 'not_found'
  | 'busy'
  | 'validation'
  | 'timeout'
  | 'denied'
  | 'unavailable'
  | 'internal';

const KINDS: Record<IpcErrorKind, true> = {
  cancelled: true, not_found: true, busy: true, validation: true, timeout: true, denied: true, unavailable: true, internal: true,
};

function isIpcErrorKindName(value: string): value is IpcErrorKind {
  return Object.prototype.hasOwnProperty.call(KINDS, value);
}

/**
 * A native command failure. `message` is the readable text the backend
 * produced; `toString()` returns it unchanged so code that formats a caught
 * value with `String(cause)` shows the same text as before typed errors.
 */
export class IpcError extends Error {
  readonly kind: IpcErrorKind;

  constructor(kind: IpcErrorKind, message: string) {
    super(message);
    this.name = 'IpcError';
    this.kind = kind;
  }

  override toString(): string {
    return this.message;
  }
}

/** Convert a serialized `{ kind, message }` rejection; other values pass through. */
export function toIpcError(cause: unknown): unknown {
  if (cause === null || typeof cause !== 'object' || cause instanceof Error) return cause;
  const record = cause as Record<string, unknown>;
  const { kind, message } = record;
  if (typeof kind !== 'string' || !isIpcErrorKindName(kind) || typeof message !== 'string') return cause;
  return new IpcError(kind, message);
}

export function isIpcErrorKind(cause: unknown, kind: IpcErrorKind): boolean {
  return cause instanceof IpcError && cause.kind === kind;
}
