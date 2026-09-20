import { invoke, isNativeRuntimeAvailable } from "../api/transport.ts";
import type { QueuedBenchmark } from "./outbox.ts";

interface LocalAcknowledgement {
  acknowledged: boolean;
  pruned: number;
  warnings: string[];
}

const maintenanceWarnings = new Set<string>();

/** History displays maintenance warnings independently of durable upload acceptance. */
export function takeBenchmarkMaintenanceWarnings(): string[] {
  const warnings = [...maintenanceWarnings];
  maintenanceWarnings.clear();
  return warnings;
}

/** The server owns the accepted result; this operation only maintains its local copy. */
export async function acknowledgeUploadedBenchmark(entry: QueuedBenchmark): Promise<void> {
  if (!entry.source) return;
  if (!isNativeRuntimeAvailable()) throw new Error("Local benchmark recovery storage is unavailable.");
  if (entry.state !== "sent" || !entry.receipt || !entry.destination) {
    throw new Error("A saved server receipt is required before acknowledging local benchmark data.");
  }
  const result = await invoke<LocalAcknowledgement>("benchmark_acknowledge_upload", {
    runId: entry.source.runId,
    receipt: { ...entry.receipt, destination: entry.destination },
  });
  if (!result.acknowledged) {
    // The outbox retains the server receipt and retries only this local operation.
    throw new Error("The result was uploaded, but local cache maintenance is not yet complete.");
  }
  // A protected or locked older journal must not prevent this receipt's acknowledgement.
  // The native store retries cache maintenance on later acknowledgements.
  for (const warning of result.warnings) {
    if (maintenanceWarnings.size >= 100) break;
    maintenanceWarnings.add(warning);
  }
}
