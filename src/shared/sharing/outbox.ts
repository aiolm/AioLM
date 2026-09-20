import { HttpError } from "../api/http.ts";
import {
  isRecoverableServiceCode,
  isTerminalServiceCode,
  normalizePublicationInput,
  serializePublicationRequest,
  type BenchmarkPublicationRequest,
  type PublicBenchmarkSubmission,
} from "@aiolm/benchmark-contracts";
import { validatePublicBenchmark } from "@aiolm/benchmark-contracts";
import type { BenchmarkReceipt, BenchmarkUploadClient } from "./benchmarkClient.ts";

export interface BenchmarkLocalSource { runId: string }

export interface QueuedBenchmark {
  id: string;
  payload: PublicBenchmarkSubmission;
  state: "pending" | "sending" | "sent" | "rejected";
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  destination?: string;
  leaseToken?: string;
  leaseUntil?: number;
  error?: { code: string; status?: number };
  receipt?: BenchmarkReceipt;
  /** App-local linkage. It is never included in the public submission payload. */
  source?: BenchmarkLocalSource;
  localAcknowledgedAt?: number;
  /** Present only while an accepted receipt needs local reconciliation. */
  localReconcileAt?: number;
  /** Only newly linked entries opt into the acknowledged local-cache retention policy. */
  localCachePolicy?: "acknowledged-v1";
  /** Exact frozen publication bytes for new explicit publishing; legacy entries omit this. */
  requestBody?: string;
  /** SHA-256 hex of requestBody, bound to the upload session. */
  bodySha256?: string;
  /** Optional description snapshot; never mutated after binding. */
  descriptionMd?: string;
  /** Nonsecret native credential reference; owner secrets are never stored in IndexedDB. */
  credentialRef?: string;
  /** Normalized service origin for the bound publication. */
  origin?: string;
}

export interface PublicationEnqueueOptions {
  source?: BenchmarkLocalSource;
  credentialRef?: string;
  origin?: string;
  bodySha256?: string;
}

/** Transport for one exact selected entry; preserves HTTP status, error body, and Retry-After. */
export interface SelectedEntryTransport {
  readonly destination: string;
  submitSnapshot(entry: QueuedBenchmark, signal?: AbortSignal): Promise<BenchmarkReceipt>;
}

function serviceCodeOf(error: unknown): string | undefined {
  const record = error as { serviceCode?: unknown; code?: unknown } | null;
  if (record && typeof record.serviceCode === "string") return record.serviceCode;
  if (record && typeof record.code === "string"
    && (isRecoverableServiceCode(record.code) || isTerminalServiceCode(record.code) || record.code === "submission_deleted")) {
    return record.code;
  }
  return undefined;
}

/** Terminal record state; explicit retry must never reopen it. */
function isTerminalEntry(entry: QueuedBenchmark): boolean {
  return entry.error !== undefined
    && (isTerminalServiceCode(entry.error.code) || entry.error.code === "submission_deleted" || entry.error.status === 410);
}

/** Preserve validated retry metadata carried by structured native errors. */
function toHttpFailure(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const record = error as { status?: unknown; retryAfterMs?: unknown } | null;
  const status = typeof record?.status === "number" && Number.isInteger(record.status) && record.status >= 100 && record.status <= 599
    ? record.status
    : undefined;
  const retryAfterMs = typeof record?.retryAfterMs === "number" && Number.isFinite(record.retryAfterMs) && record.retryAfterMs >= 0
    ? Math.min(record.retryAfterMs, 3_600_000)
    : undefined;
  return new HttpError("network", "Upload failed.", true, status, retryAfterMs);
}

/** Derive the bound origin the first time a destination is attached; never overwrite. */
function originOfDestination(destination: string): string | undefined {
  const origin = destination.replace(/\/v1\/benchmark-runs\/?$/, "");
  return origin && origin !== destination ? origin : undefined;
}

export interface OutboxPage {
  limit?: number;
  state?: QueuedBenchmark["state"];
  dueBefore?: number;
  pendingAcknowledgement?: boolean;
  acknowledgedCache?: boolean;
  /** Skip at most the retained 100 acknowledged cache entries without loading their payloads. */
  skip?: number;
  /** Timestamp and ID of the last row (nextAttemptAt for state, localReconcileAt for acknowledgements). */
  after?: [number, string];
}

export interface BenchmarkOutboxStore {
  list(page?: OutboxPage): Promise<QueuedBenchmark[]>;
  /** Direct primary-key lookup; selected entries must resolve past any page limit. */
  get(id: string): Promise<QueuedBenchmark | undefined>;
  /** Persist a service-wide retry deadline using max(existing, until). */
  cooldown(destination: string, until?: number): Promise<number>;
  /** A synchronous read/modify/write inside one storage transaction. */
  mutate(id: string, update: (current: QueuedBenchmark | undefined) => QueuedBenchmark | undefined): Promise<QueuedBenchmark | undefined>;
}

export interface MeasurementActivity {
  isActive(): boolean;
  subscribe(listener: () => void): () => void;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Dispatch is explicit. Enqueuing or reading history never starts network activity. */
export function createBenchmarkOutbox(options: {
  store: BenchmarkOutboxStore;
  measurement: MeasurementActivity;
  now?: () => number;
  uuid?: () => string;
  random?: () => number;
  /** Idempotent app-local work after the server receipt has committed. */
  onAccepted?: (entry: QueuedBenchmark) => Promise<void>;
}) {
  const { store, measurement } = options;
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const random = options.random ?? Math.random;
  const acknowledgements = new Map<string, Promise<boolean>>();

  const needsAcknowledgement = (entry: QueuedBenchmark) => entry.state === "sent" && !!entry.source && !!entry.receipt && entry.localAcknowledgedAt === undefined;
  const sameAcceptance = (current: QueuedBenchmark | undefined, expected: QueuedBenchmark) => !!current
    && needsAcknowledgement(current) && current.source?.runId === expected.source?.runId
    && current.destination === expected.destination && current.receipt?.id === expected.receipt?.id
    && current.receipt?.submission_id === expected.receipt?.submission_id;
  const acknowledge = (entry: QueuedBenchmark): Promise<boolean> => {
    if (!options.onAccepted || !needsAcknowledgement(entry) || measurement.isActive()) return Promise.resolve(false);
    const pending = acknowledgements.get(entry.id);
    if (pending) return pending.then(() => false);
    const onAccepted = options.onAccepted;
    const work = (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => onAccepted(structuredClone(entry))),
          new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Local acknowledgement timed out.")), 30_000); }),
        ]);
        let committed = false;
        await store.mutate(entry.id, current => {
          if (!sameAcceptance(current, entry)) return current;
          committed = true;
          return { ...current!, localAcknowledgedAt: now(), localReconcileAt: undefined };
        });
        return committed;
      } catch {
        // Server acceptance remains authoritative even if local storage is unavailable.
        // A later explicit reconciliation retries only the local callback.
        try {
          await store.mutate(entry.id, current => sameAcceptance(current, entry)
            ? { ...current!, localReconcileAt: now() + 1000 }
            : current);
        } catch { /* The committed receipt already retains its reconciliation marker. */ }
        return false;
      } finally {
        clearTimeout(deadline);
      }
    })().finally(() => { acknowledgements.delete(entry.id); });
    acknowledgements.set(entry.id, work);
    return work;
  };

  const reconcile = async (maxItems: number): Promise<number> => {
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) throw new RangeError("Invalid reconciliation batch size.");
    if (!options.onAccepted || measurement.isActive()) return 0;
    const entries = await store.list({ pendingAcknowledgement: true, dueBefore: now(), limit: maxItems });
    let acknowledged = 0;
    for (const entry of entries) {
      if (measurement.isActive()) break;
      if (await acknowledge(entry)) acknowledged += 1;
    }
    return acknowledged;
  };

  /** Keep the newest 100 opted-in, acknowledged submissions; legacy and unsent entries are protected. */
  const pruneAcknowledged = async (maxItems = 100): Promise<number> => {
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) throw new RangeError("Invalid cache cleanup batch size.");
    if (measurement.isActive()) return 0;
    let removed = 0;
    try {
      const entries = await store.list({ acknowledgedCache: true, skip: 100, limit: maxItems });
      for (const candidate of entries) {
        if (measurement.isActive()) break;
        let deleted = false;
        await store.mutate(candidate.id, current => {
          if (!current || current.localCachePolicy !== "acknowledged-v1" || current.state !== "sent" || !current.source || !current.receipt
            || current.localAcknowledgedAt === undefined || current.localAcknowledgedAt !== candidate.localAcknowledgedAt
            || current.createdAt !== candidate.createdAt || current.source.runId !== candidate.source?.runId
            || current.destination !== candidate.destination || current.receipt.id !== candidate.receipt?.id
            || current.receipt.submission_id !== candidate.receipt?.submission_id) return current;
          deleted = true;
          return undefined;
        });
        if (deleted) removed += 1;
      }
    } catch { /* Cache cleanup retries on a later invocation; accepted receipts are never resent. */ }
    return removed;
  };

  const reconcileAccepted = async (maxItems = 10): Promise<number> => {
    const acknowledged = await reconcile(maxItems);
    await pruneAcknowledged(maxItems);
    return acknowledged;
  };

  /** Shared claim/send/settle pipeline for flush and selected dispatch. */
  const claimForDestination = async (id: string, destination: string, signal?: AbortSignal): Promise<{ entry: QueuedBenchmark; token: string } | undefined> => {
    const token = uuid();
    const claimed = await store.mutate(id, (entry) => {
      if (measurement.isActive() || signal?.aborted) return entry;
      if (!entry || entry.state === "sent" || entry.state === "rejected" || entry.nextAttemptAt > now()) return entry;
      if (entry.state === "sending" && (entry.leaseUntil ?? 0) > now()) return entry;
      if (entry.destination && entry.destination !== destination) return entry;
      // A bound origin must agree with the destination being attached.
      if (!entry.destination && entry.origin !== undefined) {
        const derived = originOfDestination(destination);
        if (derived !== undefined && derived !== entry.origin) return entry;
      }
      const next: QueuedBenchmark = { ...entry, state: "sending", destination, leaseToken: token, leaseUntil: now() + 120_000, nextAttemptAt: now() + 120_000, attempts: entry.attempts + 1 };
      // Preserve origin/body-hash bindings when the first dispatch attaches a destination.
      if (next.origin === undefined) {
        const origin = originOfDestination(destination);
        if (origin !== undefined) next.origin = origin;
      }
      return next;
    });
    if (claimed?.leaseToken !== token) return undefined;
    return { entry: claimed, token };
  };

  const sendWithLease = async (submit: (signal: AbortSignal) => Promise<BenchmarkReceipt>, signal?: AbortSignal): Promise<BenchmarkReceipt> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onActivity = () => { if (measurement.isActive()) abort(); };
    const unsubscribe = measurement.subscribe(onActivity);
    signal?.addEventListener("abort", abort, { once: true });
    // Bound even an injected transport or credential provider that fails to finish.
    const deadline = setTimeout(abort, 60_000);
    onActivity();
    if (signal?.aborted) abort();
    let detachAbort = () => {};
    try {
      const interrupted = new Promise<never>((_, reject) => {
        const rejectAbort = () => reject(new HttpError("aborted", "Upload interrupted."));
        detachAbort = () => controller.signal.removeEventListener("abort", rejectAbort);
        if (controller.signal.aborted) rejectAbort();
        else controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      return await Promise.race([
        controller.signal.aborted ? interrupted : submit(controller.signal),
        interrupted,
      ]);
    } finally {
      clearTimeout(deadline);
      detachAbort();
      unsubscribe();
      signal?.removeEventListener("abort", abort);
    }
  };

  const settleSuccess = async (id: string, token: string, receipt: BenchmarkReceipt): Promise<boolean> => {
    let committed = false;
    const accepted = await store.mutate(id, (entry) => {
      if (entry?.leaseToken !== token) return entry;
      committed = true;
      return { ...entry, state: "sent", receipt, error: undefined, leaseToken: undefined, leaseUntil: undefined,
        ...(entry.source && entry.localAcknowledgedAt === undefined ? { localReconcileAt: 0 } : {}) };
    });
    if (!committed) return false;
    if (accepted) await acknowledge(accepted);
    return true;
  };

  const settleFailure = async (id: string, token: string, attempts: number, error: unknown, destination: string): Promise<{ code: string; terminal: boolean; failure: HttpError }> => {
    const failure = toHttpFailure(error);
    const code = serviceCodeOf(error) ?? failure.code;
    const recoverableBlock = isRecoverableServiceCode(code);
    const terminal = isTerminalServiceCode(code) || code === "submission_deleted" || failure.status === 410;
    const interrupted = failure.code === "aborted";
    const backoff = Math.min(300_000, 1000 * 2 ** Math.min(attempts - 1, 8)) * (0.75 + random() * 0.5);
    // Recoverable verification blocks stay eligible once verification completes,
    // even while the original exponential delay would still be pending.
    const nextAttemptAt = recoverableBlock && !terminal ? now() : now() + (interrupted ? 1000 : Math.max(backoff, failure.retryAfterMs ?? 0));
    if (failure.retryable && !recoverableBlock && !terminal) await store.cooldown(destination, nextAttemptAt);
    await store.mutate(id, (entry) => entry?.leaseToken === token ? {
      ...entry,
      state: terminal ? "rejected" : interrupted || failure.retryable || recoverableBlock ? "pending" : "rejected",
      nextAttemptAt,
      error: { code, ...(failure.status !== undefined ? { status: failure.status } : {}) },
      leaseToken: undefined,
      leaseUntil: undefined,
    } : entry);
    return { code, terminal, failure };
  };

  return {
    async enqueue(value: PublicBenchmarkSubmission, source?: BenchmarkLocalSource): Promise<QueuedBenchmark> {
      const payload = validatePublicBenchmark(JSON.parse(JSON.stringify(validatePublicBenchmark(value))));
      if (source && (typeof source.runId !== "string" || !source.runId || new TextEncoder().encode(source.runId).length > 128)) throw new Error("Invalid local benchmark source.");
      const localSource = source ? { runId: source.runId } : undefined;
      const result = await store.mutate(payload.submission_id, (current) => {
        if (current) {
          if (canonicalJson(current.payload) !== canonicalJson(payload)) throw new Error("This submission ID already belongs to a different reviewed payload.");
          if (localSource && current.source && current.source.runId !== localSource.runId) throw new Error("This submission ID already belongs to a different local benchmark.");
          if (localSource && !current.source) return {
            ...current, source: localSource,
            ...(current.state === "sent" && current.receipt && current.localAcknowledgedAt === undefined ? { localReconcileAt: 0 } : {}),
          };
          return current;
        }
        return { id: payload.submission_id, payload, state: "pending", createdAt: now(), attempts: 0, nextAttemptAt: 0,
          ...(localSource ? { source: localSource, localCachePolicy: "acknowledged-v1" as const } : {}) };
      });
      return result!;
    },
    /** Explicit publication with frozen exact bytes; legacy attempted rows are never auto-wrapped. */
    async enqueuePublication(request: BenchmarkPublicationRequest, options: PublicationEnqueueOptions = {}): Promise<QueuedBenchmark> {
      const normalized = normalizePublicationInput(request);
      const body = serializePublicationRequest(normalized);
      const submissionId = normalized.benchmark.submission_id;
      if (options.source && (typeof options.source.runId !== "string" || !options.source.runId || new TextEncoder().encode(options.source.runId).length > 128)) {
        throw new Error("Invalid local benchmark source.");
      }
      if (options.credentialRef !== undefined && (typeof options.credentialRef !== "string" || !options.credentialRef || options.credentialRef.length > 256)) {
        throw new Error("Invalid publication credential reference.");
      }
      const localSource = options.source ? { runId: options.source.runId } : undefined;
      const result = await store.mutate(submissionId, (current) => {
        if (current) {
          if (current.requestBody !== undefined) {
            if (current.requestBody !== body) throw new Error("This submission ID already belongs to a different reviewed payload.");
            if (options.credentialRef !== undefined && current.credentialRef !== undefined && current.credentialRef !== options.credentialRef) {
              throw new Error("This submission is already bound to a different credential.");
            }
            if (options.origin !== undefined && current.origin !== undefined && current.origin !== options.origin) {
              throw new Error("This submission is already bound to a different destination.");
            }
            if (options.bodySha256 !== undefined && current.bodySha256 !== undefined && current.bodySha256 !== options.bodySha256) {
              throw new Error("This submission is already bound to a different body hash.");
            }
            if (localSource && current.source && current.source.runId !== localSource.runId) throw new Error("This submission ID already belongs to a different local benchmark.");
            const next = { ...current };
            let changed = false;
            if (options.credentialRef !== undefined && next.credentialRef === undefined) { next.credentialRef = options.credentialRef; changed = true; }
            if (options.origin !== undefined && next.origin === undefined) { next.origin = options.origin; changed = true; }
            if (options.bodySha256 !== undefined && next.bodySha256 === undefined) { next.bodySha256 = options.bodySha256; changed = true; }
            if (localSource && !next.source) {
              next.source = localSource;
              if (!next.localCachePolicy) next.localCachePolicy = "acknowledged-v1";
              if (next.state === "sent" && next.receipt && next.localAcknowledgedAt === undefined && next.localReconcileAt === undefined) next.localReconcileAt = 0;
              changed = true;
            }
            return changed ? next : current;
          }
          // Legacy row: preserve shape unless it never attempted dispatch.
          const attempted = current.attempts > 0 || current.state === "sending" || current.state === "sent";
          if (attempted) throw new Error("This submission was already attempted as a legacy request and cannot be rewrapped automatically.");
          if (canonicalJson(current.payload) !== canonicalJson(normalized.benchmark)) {
            throw new Error("This submission ID already belongs to a different reviewed payload.");
          }
          if (localSource && current.source && current.source.runId !== localSource.runId) throw new Error("This submission ID already belongs to a different local benchmark.");
          return {
            ...current,
            payload: normalized.benchmark,
            requestBody: body,
            ...(options.bodySha256 ? { bodySha256: options.bodySha256 } : {}),
            ...(normalized.description_md ? { descriptionMd: normalized.description_md } : {}),
            ...(options.credentialRef ? { credentialRef: options.credentialRef } : {}),
            ...(options.origin ? { origin: options.origin } : {}),
            ...(localSource && !current.source ? { source: localSource, localCachePolicy: "acknowledged-v1" as const } : {}),
          };
        }
        return {
          id: submissionId, payload: normalized.benchmark, state: "pending", createdAt: now(), attempts: 0, nextAttemptAt: 0,
          requestBody: body,
          ...(options.bodySha256 ? { bodySha256: options.bodySha256 } : {}),
          ...(normalized.description_md ? { descriptionMd: normalized.description_md } : {}),
          ...(options.credentialRef ? { credentialRef: options.credentialRef } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
          ...(localSource ? { source: localSource, localCachePolicy: "acknowledged-v1" as const } : {}),
        };
      });
      return result!;
    },
    async get(id: string): Promise<QueuedBenchmark | undefined> {
      if (typeof id !== "string" || !id) throw new Error("Invalid submission lookup.");
      return store.get(id);
    },
    list: (page?: OutboxPage) => store.list(page),
    reconcileAccepted,
    pruneAcknowledged,
    async remove(id: string): Promise<void> {
      await store.mutate(id, (entry) => {
        if (entry?.state === "sending" && (entry.leaseUntil ?? 0) > now()) throw new Error("Cancel the active upload before removing this submission.");
        return undefined;
      });
    },
    async retry(id: string): Promise<void> {
      await store.mutate(id, (entry) => {
        if (!entry || entry.state !== "rejected") return entry;
        // Terminal deletes never dispatch again, even on explicit retry.
        if (isTerminalEntry(entry)) return entry;
        return { ...entry, state: "pending", nextAttemptAt: 0, error: undefined };
      });
    },
    /** Dispatch one exact selected entry; never selects another row like flush(maxItems=1) could. */
    async dispatchSelected(id: string, transport: SelectedEntryTransport, signal?: AbortSignal): Promise<number> {
      if (typeof id !== "string" || !id) throw new Error("Invalid selected submission.");
      if (measurement.isActive() || signal?.aborted) return 0;
      await reconcile(10);
      if (await store.cooldown(transport.destination) > now()) return 0;
      const claim = await claimForDestination(id, transport.destination, signal);
      if (!claim) return 0;
      try {
        const receipt = await sendWithLease((attemptSignal) => transport.submitSnapshot(claim.entry, attemptSignal), signal);
        if (await settleSuccess(id, claim.token, receipt)) {
          await pruneAcknowledged(10);
          return 1;
        }
        return 0;
      } catch (error) {
        await settleFailure(id, claim.token, claim.entry.attempts, error, transport.destination);
        return 0;
      }
    },
    async flush(client: BenchmarkUploadClient, signal?: AbortSignal, maxItems = 10): Promise<number> {
      if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) throw new RangeError("Invalid dispatch batch size.");
      if (measurement.isActive() || signal?.aborted) return 0;
      await reconcile(maxItems);
      let sent = 0;
      let attempted = 0;
      if (await store.cooldown(client.destination) > now()) { await pruneAcknowledged(maxItems); return 0; }
      const entries = (await Promise.all([
        store.list({ state: "pending", dueBefore: now(), limit: maxItems }),
        store.list({ state: "sending", dueBefore: now(), limit: maxItems }),
      ])).flat().sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt);
      for (const candidate of entries) {
        if (attempted >= maxItems || measurement.isActive() || signal?.aborted) break;
        if (await store.cooldown(client.destination) > now()) break;
        // Wrapper publications carry exact bytes plus descriptions and dispatch only
        // through the selected native path; the legacy client must not drop them.
        if (candidate.requestBody !== undefined) continue;
        const claim = await claimForDestination(candidate.id, client.destination, signal);
        if (!claim) continue;
        attempted += 1;
        try {
          const receipt = await sendWithLease((attemptSignal) => client.submit(claim.entry.payload, attemptSignal), signal);
          if (await settleSuccess(candidate.id, claim.token, receipt)) sent += 1;
        } catch (error) {
          const { failure } = await settleFailure(candidate.id, claim.token, claim.entry.attempts, error, client.destination);
          if (failure.retryable || failure.status === 401 || failure.status === 403) break;
        }
      }
      await pruneAcknowledged(maxItems);
      return sent;
    },
  };
}
