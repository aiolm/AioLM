import { HttpError, requestJson } from "../api/http.ts";
import { validatePublicBenchmark, validateBenchmarkReceipt, type PublicBenchmarkSubmission, type BenchmarkReceipt } from "@aiolm/benchmark-contracts";

export type { BenchmarkReceipt } from "@aiolm/benchmark-contracts";
export interface BenchmarkUploadClient {
  readonly destination: string;
  submit(payload: PublicBenchmarkSubmission, signal?: AbortSignal): Promise<BenchmarkReceipt>;
}

export interface BenchmarkClientOptions {
  baseUrl: string;
  /** Credentials are supplied at dispatch time and never stored in the outbox. */
  accessToken?: (signal?: AbortSignal) => Promise<string | undefined>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export function createBenchmarkClient(options: BenchmarkClientOptions): BenchmarkUploadClient {
  const base = new URL(options.baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) || base.username || base.password || base.search || base.hash) {
    throw new Error("The sharing service requires an HTTPS base URL without credentials, query, or fragment.");
  }
  const destination = `${base.href.replace(/\/+$/, "")}/v1/benchmark-runs`;
  return {
    destination,
    async submit(payload, signal) {
      // Capture the reviewed bytes before credentials introduce an async boundary.
      // Validate the serialized form too, so a custom serializer cannot add fields.
      const body = JSON.stringify(validatePublicBenchmark(payload));
      const submissionId = validatePublicBenchmark(JSON.parse(body)).submission_id;
      if (signal?.aborted) throw new HttpError("aborted", "Request cancelled.");
      const token = await options.accessToken?.(signal);
      return requestJson(destination, (value) => {
        const receipt = validateBenchmarkReceipt(value, submissionId);
        let url: string | undefined;
        if (typeof receipt.url === "string") {
          const parsed = new URL(receipt.url);
          if (parsed.origin === base.origin && !parsed.username && !parsed.password && parsed.href.length <= 2048) url = parsed.href;
        }
        return { submission_id: submissionId, id: receipt.id, ...(url ? { url } : {}) };
      }, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": submissionId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body,
        signal,
        timeoutMs: options.timeoutMs,
        maxResponseBytes: 16 * 1024,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        fetcher: options.fetcher,
      });
    },
  };
}
