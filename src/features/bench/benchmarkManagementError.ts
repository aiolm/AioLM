import { BenchmarkSharingError } from '../../shared/api/benchmarkSharing';
import type { benchmarkCopy } from './benchmarkCopy';

/** Management errors describe the next action without exposing native credentials or URLs. */
export function benchmarkManagementError(error: unknown, copy: ReturnType<typeof benchmarkCopy>): string {
  if (error instanceof BenchmarkSharingError) {
    if (error.status === 404 || error.serviceCode === 'not_found') return copy.managementUnavailable;
    if (error.serviceCode === 'submission_deleted') return copy.managementDeleted;
    if (error.serviceCode === 'ownership_missing' || error.kind === 'credential-missing') return copy.publishOwnershipMissing;
  }
  return copy.managementError;
}
