/** Readable text for both JavaScript errors and serialized native rejections. */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  if (cause !== null && typeof cause === 'object') {
    const record = cause as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
    try {
      const serialized = JSON.stringify(cause);
      if (serialized) return serialized;
    } catch {
      // A cyclic rejection still needs a usable message.
    }
    return 'An unexpected error occurred.';
  }
  return String(cause);
}
