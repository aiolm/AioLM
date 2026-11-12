export function defined<T>(
  value: T | undefined | null,
  label = 'Expected value',
): T {
  if (value === undefined || value === null) {
    throw new Error(`${label} must be defined`);
  }

  return value;
}
