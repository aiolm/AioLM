import { validateBenchmarkReceipt } from "@aiolm/benchmark-contracts";
import { benchmarkSharingCancel, benchmarkSharingSubmit, throwForNativeSubmit } from "../api/benchmarkSharing.ts";
import { HttpError } from "../api/http.ts";
import type { QueuedBenchmark, SelectedEntryTransport } from "./outbox.ts";

/** Native transport adapter: owner/permit headers stay in Rust; WebView sees only status/body. */
export function createNativeSelectedTransport(destination: string): SelectedEntryTransport {
  if (typeof destination !== "string" || !destination) throw new Error("Invalid publication destination.");
  return {
    destination,
    async submitSnapshot(entry: QueuedBenchmark, signal?: AbortSignal) {
      if (signal?.aborted) throw new HttpError("aborted", "Upload interrupted.");
      // Exact persisted body; never re-serialize the parsed payload for dispatch.
      const body = entry.requestBody ?? JSON.stringify(entry.payload);
      let onAbort: (() => void) | undefined;
      try {
        const response = await Promise.race([
          benchmarkSharingSubmit(entry.id, body),
          new Promise<never>((_, reject) => {
            onAbort = () => {
              // Forward cancellation to native pending work and clear the ephemeral permit.
              benchmarkSharingCancel(entry.id).catch(() => undefined);
              reject(new HttpError("aborted", "Upload interrupted."));
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
        return throwForNativeSubmit(response, entry.id, (value) => validateBenchmarkReceipt(value, entry.id));
      } finally {
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
