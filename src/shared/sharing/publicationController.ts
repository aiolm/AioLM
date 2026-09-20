import type { MeasurementActivity, QueuedBenchmark, SelectedEntryTransport } from "./outbox.ts";
import {
  benchmarkSharingBeginVerification,
  benchmarkSharingCancel,
  benchmarkSharingPollVerification,
  benchmarkSharingPrepare,
  BenchmarkSharingError,
} from "../api/benchmarkSharing.ts";
import { createPublicationBody } from "../contracts/benchmark/publication.ts";
import type { BenchmarkPublicationRequest } from "@aiolm/benchmark-contracts";

export interface PublicationOutbox {
  enqueuePublication(request: BenchmarkPublicationRequest, options?: { source?: { runId: string }; credentialRef?: string; origin?: string; bodySha256?: string }): Promise<QueuedBenchmark>;
  dispatchSelected(id: string, transport: SelectedEntryTransport, signal?: AbortSignal): Promise<number>;
  get(id: string): Promise<QueuedBenchmark | undefined>;
}

export interface PublicationNative {
  prepare(submissionId: string, body: string): Promise<{ credential_ref: string; body_sha256: string; destination: string }>;
  beginVerification(submissionId: string): Promise<{ session_id: string; verification_url: string; expires_at: string }>;
  pollVerification(submissionId: string, sessionId: string): Promise<{ status: "pending" | "verified" | "expired"; expires_at: string }>;
  cancel(submissionId: string): Promise<void>;
}

const defaultNative: PublicationNative = {
  prepare: (submissionId, body) => benchmarkSharingPrepare(submissionId, body),
  beginVerification: (submissionId) => benchmarkSharingBeginVerification(submissionId),
  pollVerification: (submissionId, sessionId) => benchmarkSharingPollVerification(submissionId, sessionId),
  cancel: (submissionId) => benchmarkSharingCancel(submissionId),
};

export type PublicationPhase = "preparing" | "verifying" | "submitting" | "done";

/** Explicit publishing controller; challenge/poll runs before the dispatch lease. */
export function createPublicationController(options: {
  measurement: MeasurementActivity;
  outbox: PublicationOutbox;
  native?: PublicationNative;
  now?: () => number;
}) {
  const measurement = options.measurement;
  const outbox = options.outbox;
  const native = options.native ?? defaultNative;
  const now = options.now ?? Date.now;

  const ensureIdle = () => {
    if (measurement.isActive()) throw new BenchmarkSharingError("transport", "Pause sharing while a measurement is active.", true);
  };
  const cancelNative = (submissionId: string) => native.cancel(submissionId).catch(() => undefined);

  /**
   * Race pending workflow work against user abort, measurement start, and an
   * optional deadline. Listeners live for the whole wait, not just the sleep
   * between polls; any trigger cancels native work, cleans up, and rejects.
   */
  const raceWorkflow = async <T>(submissionId: string, work: Promise<T>, signal?: AbortSignal, timeoutMs?: number): Promise<T> => {
    let settled = false;
    let rejectGuard: ((error: BenchmarkSharingError) => void) | undefined;
    const guard = new Promise<never>((_, reject) => { rejectGuard = reject; });
    const onAbort = () => {
      if (settled) return;
      settled = true;
      void cancelNative(submissionId);
      rejectGuard?.(new BenchmarkSharingError("transport", "Verification was cancelled.", true));
    };
    const onActivity = () => {
      if (settled || !measurement.isActive()) return;
      settled = true;
      void cancelNative(submissionId);
      rejectGuard?.(new BenchmarkSharingError("transport", "Pause sharing while a measurement is active.", true));
    };
    const unsubscribe = measurement.subscribe(onActivity);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = timeoutMs !== undefined
      ? setTimeout(() => {
        if (settled) return;
        settled = true;
        void cancelNative(submissionId);
        rejectGuard?.(new BenchmarkSharingError("verification", "Verification timed out after 5 minutes.", true));
      }, timeoutMs)
      : undefined;
    try {
      if (signal?.aborted) throw new BenchmarkSharingError("transport", "Verification was cancelled.", true);
      onActivity();
      return await Promise.race([
        work.then((value) => { settled = true; return value; }, (error: unknown) => { settled = true; throw error; }),
        guard,
      ]);
    } catch (error) {
      if (!settled) {
        settled = true;
        await cancelNative(submissionId);
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }
  };

  return {
    /**
     * Persist the exact unbound wrapper before any native binding or network
     * work, then idempotently attach the returned metadata. A storage failure
     * makes zero native calls; a cancelled or late native completion never
     * attaches or sends, but the original unbound wrapper stays durable for
     * retry and restart. Returns the queued entry with the native destination,
     * since freshly persisted entries have no destination bound yet.
     */
    async prepare(request: BenchmarkPublicationRequest, source?: { runId: string }, signal?: AbortSignal): Promise<{ entry: QueuedBenchmark; destination: string }> {
      ensureIdle();
      if (signal?.aborted) throw new BenchmarkSharingError("transport", "Verification was cancelled.", true);
      const { body, submissionId } = createPublicationBody(request);
      // No network yet: a local write failure here leaves native ownership untouched.
      await outbox.enqueuePublication(request, { ...(source ? { source } : {}) });
      ensureIdle();
      if (signal?.aborted) throw new BenchmarkSharingError("transport", "Verification was cancelled.", true);
      const binding = await raceWorkflow(submissionId, native.prepare(submissionId, body), signal);
      if (signal?.aborted) {
        await cancelNative(submissionId);
        throw new BenchmarkSharingError("transport", "Verification was cancelled.", true);
      }
      ensureIdle();
      const entry = await outbox.enqueuePublication(request, {
        ...(source ? { source } : {}),
        credentialRef: binding.credential_ref,
        origin: binding.destination.replace(/\/v1\/benchmark-runs$/, ""),
        bodySha256: binding.body_sha256,
      });
      return { entry, destination: binding.destination };
    },
    async beginVerification(submissionId: string) {
      ensureIdle();
      return native.beginVerification(submissionId);
    },
    /** Poll verification; native work is cancelled on timeout, abort, or measurement start. */
    async pollUntilVerified(submissionId: string, sessionId: string, signal?: AbortSignal, timeoutMs = 300_000, intervalMs = 2000): Promise<void> {
      const deadline = now() + timeoutMs;
      try {
        while (true) {
          if (signal?.aborted) throw new BenchmarkSharingError("transport", "Verification was cancelled.", true);
          ensureIdle();
          const remaining = deadline - now();
          if (remaining <= 0) throw new BenchmarkSharingError("verification", "Verification timed out after 5 minutes.", true);
          const poll = await raceWorkflow(submissionId, native.pollVerification(submissionId, sessionId), signal, remaining);
          if (poll.status === "verified") return;
          if (poll.status === "expired") throw new BenchmarkSharingError("verification", "Verification expired. Start verification again.", true);
          let sleepTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await raceWorkflow(submissionId, new Promise<void>((resolve) => { sleepTimer = setTimeout(resolve, intervalMs); }), signal);
          } finally {
            clearTimeout(sleepTimer);
          }
        }
      } catch (error) {
        await cancelNative(submissionId);
        throw error;
      }
    },
    /**
     * Accepted replay first; CAPTCHA verification only for verification_required.
     * ownership_missing means the owner key is gone or mismatched and needs key
     * recovery, not another CAPTCHA round, so it surfaces to the recovery UI.
     */
    async publishSelected(id: string, transport: SelectedEntryTransport, signal?: AbortSignal): Promise<number> {
      ensureIdle();
      const sent = await outbox.dispatchSelected(id, transport, signal);
      if (sent === 1) return 1;
      const entry = await outbox.get(id);
      const code = entry?.error?.code;
      if (code !== "verification_required") return 0;
      const verification = await raceWorkflow(id, native.beginVerification(id), signal, 60_000);
      await this.pollUntilVerified(id, verification.session_id, signal);
      ensureIdle();
      return outbox.dispatchSelected(id, transport, signal);
    },
    async cancel(submissionId: string): Promise<void> {
      await native.cancel(submissionId).catch(() => undefined);
    },
  };
}
