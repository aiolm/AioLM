export function configExport<T>(preferences: T): { schemaVersion: 1; exportedAt: string; preferences: T } {
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), preferences };
}

export function parseConfigExport<T>(raw: string): T {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) throw new Error("Unsupported settings export format.");
  return (parsed as { preferences?: T }).preferences as T;
}

export function safeTextExport(value: string): string {
  return value.replace(/(api[_-]?key|token|password|secret|credential|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}
