import {
  RECOVERY_MAX_FILE_BYTES,
  RECOVERY_PREFIX,
  decodeRecoveryCode,
  encodeRecoveryCode,
  normalizeServiceOrigin,
  type BenchmarkRecoveryPayload,
} from '@aiolm/benchmark-contracts';

export { RECOVERY_MAX_FILE_BYTES, RECOVERY_PREFIX, type BenchmarkRecoveryPayload };
export { decodeRecoveryCode, encodeRecoveryCode, normalizeServiceOrigin };

/** Strict file guard for native recovery import: oversized files never reach the decoder. */
export function validateRecoveryFileBytes(text: string): string {
  if (new TextEncoder().encode(text).length > RECOVERY_MAX_FILE_BYTES) {
    throw new Error('Recovery file is too large.');
  }
  return text;
}

/** Read a recovery code pasted into the management form; never place raw secrets in navigation URLs. */
export function parsePastedRecoveryCode(input: string, expectedOrigin?: string): BenchmarkRecoveryPayload {
  const code = input.trim();
  if (!code) throw new Error('Enter a recovery code.');
  return decodeRecoveryCode(validateRecoveryFileBytes(code), expectedOrigin);
}
