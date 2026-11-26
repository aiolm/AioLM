/**
 * Windows "Copy as path" and terminal drag-and-drop wrap a path in quotes
 * meant for a shell. Engine arguments never pass through a shell, so the
 * quotes would reach the engine as part of the file name. One pair of
 * matching quotes around an absolute path is removed; any other text, and a
 * path that itself contains that quote, stays literal. The native launcher
 * applies the same rule to values saved before this normalization.
 */
export function unquotePastedPath(text: string): string {
  const trimmed = text.trim();
  for (const quote of ['"', "'"]) {
    if (trimmed.length < 2 || !trimmed.startsWith(quote) || !trimmed.endsWith(quote)) continue;
    const inner = trimmed.slice(1, -1);
    if (!inner.includes(quote) && looksLikeAbsolutePath(inner)) return inner;
  }
  return text;
}

/** {@link unquotePastedPath} for one argv token, including `--flag="C:\path"`. */
export function unquotePastedPathArg(token: string): string {
  const equals = token.indexOf('=');
  if (equals > 0 && token.startsWith('-')) {
    const value = token.slice(equals + 1);
    const unquoted = unquotePastedPath(value);
    return unquoted === value ? token : `${token.slice(0, equals + 1)}${unquoted}`;
  }
  return unquotePastedPath(token);
}

function looksLikeAbsolutePath(text: string): boolean {
  return text.startsWith('/') || text.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(text);
}
