import { BenchmarkSharingError } from '../../shared/api/benchmarkSharing';
import type { benchmarkCopy } from './benchmarkCopy';

type Copy = ReturnType<typeof benchmarkCopy>;

/** Vault recovery advice is localized; native error details never enter the UI. */
function vaultActionError(error: unknown, copy: Copy): string | undefined {
  if (!(error instanceof BenchmarkSharingError)) return undefined;
  if (error.kind === 'vault-locked') return copy.vaultLocked;
  if (error.kind === 'vault-missing' || error.kind === 'credential-missing') return copy.publishOwnershipMissing;
  return undefined;
}

export function benchmarkRecoveryError(error: unknown, copy: Copy, action: 'import' | 'export' | 'copy'): string {
  // Native vault-unavailable also covers file and clipboard failures, so it
  // cannot establish which dependency needs attention.
  const fallback = { import: copy.recoveryImportError, export: copy.recoveryExportError, copy: copy.recoveryCopyError };
  return vaultActionError(error, copy) ?? fallback[action];
}

/** Management errors describe the next action without exposing native credentials or URLs. */
export function benchmarkManagementError(error: unknown, copy: Copy): string {
  const vaultError = vaultActionError(error, copy);
  if (vaultError) return vaultError;
  if (error instanceof BenchmarkSharingError) {
    if (error.status === 404 || error.serviceCode === 'not_found') return copy.managementUnavailable;
    if (error.serviceCode === 'submission_deleted') return copy.managementDeleted;
    if (error.serviceCode === 'ownership_missing' || error.kind === 'credential-missing') return copy.publishOwnershipMissing;
  }
  return copy.managementError;
}
