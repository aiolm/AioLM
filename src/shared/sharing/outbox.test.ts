// @vitest-environment node
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../api/http.ts";
import type { PublicBenchmarkSubmission } from "../contracts/benchmark/publicBenchmark.ts";
import { createBenchmarkClient, type BenchmarkUploadClient } from "./benchmarkClient.ts";
import { createBenchmarkOutbox, type BenchmarkOutboxStore, type MeasurementActivity, type QueuedBenchmark } from "./outbox.ts";
import { createIndexedDbOutbox } from "./indexedDbOutbox.ts";

const payload = (): PublicBenchmarkSubmission => ({
  schema_version: 1, submission_id: "00000000-0000-4000-8000-000000000001", app_version: "0.1.9", method: null,
  workload: { corpus: "novel_ko", corpus_version: null, corpus_sha256: null, prompt_lengths: [1024], generation_length: 128, batch_sizes: [2], repetitions: 1, warmup: true },
  model: { status: "unidentified", sha256: null, size_bytes: null },
  runtime: { name: "llama.cpp", version: "10840", backend: "cpu", build: "b10840" },
  environment: null, execution: { context_size: 4096, parallel: 2, settings: null },
  measurements: { status: "complete", rows: [{ prompt_tokens: 1024, generation_length: 128, concurrency: 1, repetition: 1, completion_tokens: 128, cached_tokens: 0, ttft_ms: 100, tpot_ms: 10, pp_tps: 100, tg_tps: 100, e2e_ms: 1380, total_tps: 93, peak_memory_bytes: null, timing_source: "client", failed: false }] },
});

function fixture() {
  const rows = new Map<string, QueuedBenchmark>();
  const deadlines = new Map<string, number>();
  const store: BenchmarkOutboxStore = {
    get: async (id) => structuredClone(rows.get(id)),
    list: async (page = {}) => [...rows.values()]
      .filter((row) => page.acknowledgedCache ? row.localCachePolicy === "acknowledged-v1" && row.localAcknowledgedAt !== undefined
        : page.pendingAcknowledgement ? row.localReconcileAt !== undefined && row.localReconcileAt <= (page.dueBefore ?? Infinity)
          : (!page.state || row.state === page.state) && row.nextAttemptAt <= (page.dueBefore ?? Infinity))
      .sort((a, b) => page.acknowledgedCache ? b.localAcknowledgedAt! - a.localAcknowledgedAt!
        : page.pendingAcknowledgement ? a.localReconcileAt! - b.localReconcileAt! : a.nextAttemptAt - b.nextAttemptAt)
      .slice(page.skip ?? 0, (page.skip ?? 0) + (page.limit ?? 100)).map((row) => structuredClone(row)),
    cooldown: async (destination, until) => { const deadline = Math.max(deadlines.get(destination) ?? 0, until ?? 0); deadlines.set(destination, deadline); return deadline; },
    mutate: async (id, update) => {
      const row = update(structuredClone(rows.get(id)));
      if (row) rows.set(id, structuredClone(row)); else rows.delete(id);
      return structuredClone(row);
    },
  };
  let active = false;
  let time = 1000;
  const listeners = new Set<() => void>();
  const measurement: MeasurementActivity = { isActive: () => active, subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; } };
  const options = { store, measurement, now: () => time, random: () => 0.5 };
  return { rows, store, options, queue: createBenchmarkOutbox(options), advance: (ms: number) => { time += ms; }, setActive: (value: boolean) => { active = value; listeners.forEach((cb) => cb()); } };
}

function client(submit?: BenchmarkUploadClient["submit"]): BenchmarkUploadClient {
  return { destination: "https://example.test/v1/benchmark-runs", submit: submit ?? (async (p) => ({ id: "run-1", submission_id: p.submission_id })) };
}

describe("reviewed benchmark outbox", () => {
  it("deduplicates reviewed payloads, rejects changed content and copies caller data", async () => {
    const f = fixture(); const input = payload();
    await f.queue.enqueue(input); await f.queue.enqueue(payload());
    input.execution.parallel = 4;
    await expect(f.queue.enqueue(input)).rejects.toThrow("different reviewed payload");
    expect((await f.queue.list())[0].payload.execution.parallel).toBe(2);
    expect(f.rows.size).toBe(1);
    await expect(f.queue.enqueue({ ...payload(), local_path: "private" } as PublicBenchmarkSubmission)).rejects.toThrow("Invalid public benchmark");
  });

  it("fails visibly when durable storage is unavailable or a transaction fails", async () => {
    await expect(createIndexedDbOutbox(undefined).list()).rejects.toThrow("unavailable");
    const f = fixture();
    const queue = createBenchmarkOutbox({ ...f.options, store: { ...f.store, mutate: async () => { throw new Error("Quota exceeded"); } } });
    await expect(queue.enqueue(payload())).rejects.toThrow("Quota exceeded");
  });

  it("claims atomically across workers and recovers an expired interrupted upload", async () => {
    const f = fixture(); await f.queue.enqueue(payload());
    const second = createBenchmarkOutbox(f.options);
    const submit = vi.fn(client().submit);
    await Promise.all([f.queue.flush(client(submit)), second.flush(client(submit))]);
    expect(submit).toHaveBeenCalledOnce();
    expect((await second.list())[0].state).toBe("sent");
    const row = f.rows.get(payload().submission_id)!;
    f.rows.set(row.id, { ...row, state: "sending", leaseToken: "expired", leaseUntil: 500, nextAttemptAt: 0 });
    await second.flush(client(submit));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0][0].submission_id).toBe(submit.mock.calls[1][0].submission_id);
  });

  it("waits for Retry-After and never retries a permanent rejection without a request", async () => {
    const f = fixture(); await f.queue.enqueue(payload());
    const submit = vi.fn<BenchmarkUploadClient["submit"]>()
      .mockRejectedValueOnce(new HttpError("http", "HTTP 429", true, 429, 20_000))
      .mockRejectedValueOnce(new HttpError("http", "HTTP 401", false, 401))
      .mockImplementation(client().submit);
    await f.queue.flush(client(submit));
    f.advance(19_999); await f.queue.flush(client(submit)); expect(submit).toHaveBeenCalledOnce();
    f.advance(1); await f.queue.flush(client(submit)); expect((await f.queue.list())[0].state).toBe("rejected");
    f.advance(100_000); await f.queue.flush(client(submit)); expect(submit).toHaveBeenCalledTimes(2);
    await f.queue.retry(payload().submission_id); await f.queue.flush(client(submit)); expect((await f.queue.list())[0].state).toBe("sent");
  });

  it("pauses during measurement and aborts a running upload when a benchmark starts", async () => {
    const f = fixture(); await f.queue.enqueue(payload()); f.setActive(true);
    const submit = vi.fn<BenchmarkUploadClient["submit"]>().mockImplementation(async (_p, signal) => {
      f.setActive(true); expect(signal?.aborted).toBe(true);
      return new Promise(() => {});
    });
    await f.queue.flush(client(submit)); expect(submit).not.toHaveBeenCalled();
    f.setActive(false); await f.queue.flush(client(submit));
    expect(submit).toHaveBeenCalledOnce(); expect((await f.queue.list())[0].state).toBe("pending");
  });

  it("binds retries to the original service and supports deletion", async () => {
    const f = fixture(); await f.queue.enqueue(payload());
    await f.queue.flush(client(async () => { throw new HttpError("network", "Unavailable", true); }));
    f.advance(100_000);
    const submit = vi.fn(client().submit);
    await f.queue.flush({ destination: "https://another.test/v1/benchmark-runs", submit });
    expect(submit).not.toHaveBeenCalled();
    await f.queue.remove(payload().submission_id); expect(await f.queue.list()).toEqual([]);
  });

  it("applies a server cooldown to other pending submissions and worker restarts", async () => {
    const f = fixture(); await f.queue.enqueue(payload());
    await f.queue.enqueue({ ...payload(), submission_id: "00000000-0000-4000-8000-000000000002" });
    const submit = vi.fn<BenchmarkUploadClient["submit"]>().mockRejectedValueOnce(new HttpError("http", "Busy", true, 429, 5000)).mockImplementation(client().submit);
    await f.queue.flush(client(submit)); expect(submit).toHaveBeenCalledOnce();
    const restarted = createBenchmarkOutbox(f.options);
    f.advance(4999); await restarted.flush(client(submit)); expect(submit).toHaveBeenCalledOnce();
    f.advance(1); expect(await restarted.flush(client(submit))).toBe(2);
  });

  it("does not count or overwrite a receipt after another worker recovers its lease", async () => {
    const f = fixture(); await f.queue.enqueue(payload());
    let deliver!: (value: { id: string; submission_id: string }) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const first = f.queue.flush(client(async () => new Promise((resolve) => { deliver = resolve; started(); })));
    await waiting; f.advance(120_001);
    const second = createBenchmarkOutbox(f.options);
    expect(await second.flush(client())).toBe(1);
    deliver({ id: "late-receipt", submission_id: payload().submission_id });
    expect(await first).toBe(0);
    expect((await f.queue.list())[0].receipt?.id).toBe("run-1");
  });

  it("revalidates a snapshot after custom JSON serialization", async () => {
    const f = fixture(); const value = payload();
    Object.defineProperty(value, "toJSON", { value: () => ({ ...payload(), local_path: "synthetic-private.gguf" }) });
    await expect(f.queue.enqueue(value)).rejects.toThrow("Invalid public benchmark");
    expect(await f.queue.list()).toEqual([]);
  });

  it("keeps remote acceptance when local acknowledgement fails and reconciles after restart without another POST", async () => {
    const f = fixture();
    const failedAcknowledgement = vi.fn(async (entry: QueuedBenchmark) => {
      expect(f.rows.get(entry.id)?.state).toBe("sent");
      throw new Error("Local record is temporarily unavailable");
    });
    const queue = createBenchmarkOutbox({ ...f.options, onAccepted: failedAcknowledgement });
    const source = { runId: "local-run-1" };
    await queue.enqueue(payload(), source);
    source.runId = "changed-after-enqueue";
    const submit = vi.fn(client().submit);
    expect(await queue.flush(client(submit))).toBe(1);
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][0]).toEqual(payload());
    expect(JSON.stringify(submit.mock.calls[0][0])).not.toContain("local-run");
    expect(f.rows.get(payload().submission_id)).toMatchObject({ state: "sent", attempts: 1, source: { runId: "local-run-1" }, receipt: { id: "run-1" } });
    expect(f.rows.get(payload().submission_id)?.localAcknowledgedAt).toBeUndefined();
    const onAccepted = vi.fn(async () => undefined);
    const restarted = createBenchmarkOutbox({ ...f.options, onAccepted });
    f.advance(1000);
    expect(await restarted.reconcileAccepted()).toBe(1);
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(f.rows.get(payload().submission_id)?.localAcknowledgedAt).toBe(2000);
    expect(f.rows.get(payload().submission_id)?.localReconcileAt).toBeUndefined();
    expect(await restarted.flush(client(submit))).toBe(0);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("attaches an explicit local source without rebinding it and leaves source-less legacy receipts untouched", async () => {
    const f = fixture(); await f.queue.enqueue(payload()); await f.queue.flush(client());
    const original = structuredClone(f.rows.get(payload().submission_id));
    const onAccepted = vi.fn(async () => undefined);
    const queue = createBenchmarkOutbox({ ...f.options, onAccepted });
    expect(await queue.reconcileAccepted()).toBe(0);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(f.rows.get(payload().submission_id)).toEqual(original);
    await queue.enqueue(payload(), { runId: "local-run" });
    await queue.enqueue(payload(), { runId: "local-run" });
    await expect(queue.enqueue(payload(), { runId: "x".repeat(129) })).rejects.toThrow("Invalid local benchmark source");
    await expect(queue.enqueue(payload(), { runId: "가".repeat(43) })).rejects.toThrow("Invalid local benchmark source");
    await expect(queue.enqueue(payload(), { runId: "other-run" })).rejects.toThrow("different local benchmark");
    expect(await queue.reconcileAccepted()).toBe(1);
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(f.rows.get(payload().submission_id)?.localCachePolicy).toBeUndefined();
  });

  it("retries the idempotent local callback when its acknowledgement transaction fails", async () => {
    const f = fixture(); let failAcknowledgement = true;
    const store: BenchmarkOutboxStore = {
      ...f.store,
      mutate: (id, update) => f.store.mutate(id, current => {
        const result = update(current);
        if (failAcknowledgement && result?.localAcknowledgedAt !== undefined) throw new Error("Local storage did not commit");
        return result;
      }),
    };
    const onAccepted = vi.fn(async () => undefined);
    const queue = createBenchmarkOutbox({ ...f.options, store, onAccepted });
    await queue.enqueue(payload(), { runId: "local-run" });
    const submit = vi.fn(client().submit);
    expect(await queue.flush(client(submit))).toBe(1);
    expect(f.rows.get(payload().submission_id)?.state).toBe("sent");
    failAcknowledgement = false; f.advance(1000);
    expect(await queue.reconcileAccepted()).toBe(1);
    expect(onAccepted).toHaveBeenCalledTimes(2);
    expect(await queue.flush(client(submit))).toBe(0);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("bounds local reconciliation and pauses it during measurement", async () => {
    const f = fixture();
    for (let index = 1; index <= 3; index += 1) {
      await f.queue.enqueue({ ...payload(), submission_id: `00000000-0000-4000-8000-00000000000${index}` }, { runId: `local-${index}` });
    }
    await f.queue.flush(client());
    const onAccepted = vi.fn(async () => undefined);
    const queue = createBenchmarkOutbox({ ...f.options, onAccepted });
    f.setActive(true); expect(await queue.reconcileAccepted(2)).toBe(0);
    f.setActive(false); expect(await queue.reconcileAccepted(2)).toBe(2);
    expect(onAccepted).toHaveBeenCalledTimes(2);
    expect(await queue.reconcileAccepted(2)).toBe(1);
    expect(onAccepted).toHaveBeenCalledTimes(3);
  });

  it("shares a local acknowledgement attempt between concurrent reconciliation calls", async () => {
    const f = fixture(); await f.queue.enqueue(payload(), { runId: "local-run" }); await f.queue.flush(client());
    let complete!: () => void; let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const onAccepted = vi.fn(async () => new Promise<void>(resolve => { complete = resolve; began(); }));
    const queue = createBenchmarkOutbox({ ...f.options, onAccepted });
    const first = queue.reconcileAccepted(); const second = queue.reconcileAccepted();
    await started; complete();
    expect((await first) + (await second)).toBe(1);
    expect(onAccepted).toHaveBeenCalledOnce();
  });

  it("does not undo another worker's successful local acknowledgement after a late failure", async () => {
    const f = fixture(); await f.queue.enqueue(payload(), { runId: "local-run" });
    let fail!: (error: Error) => void; let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const first = createBenchmarkOutbox({ ...f.options, onAccepted: () => new Promise<void>((_, reject) => { fail = reject; began(); }) });
    const sending = first.flush(client());
    await started;
    const second = createBenchmarkOutbox({ ...f.options, onAccepted: async () => undefined });
    expect(await second.reconcileAccepted()).toBe(1);
    fail(new Error("Late local failure"));
    expect(await sending).toBe(1);
    expect(f.rows.get(payload().submission_id)).toMatchObject({ state: "sent", localAcknowledgedAt: 1000 });
    expect(f.rows.get(payload().submission_id)?.localReconcileAt).toBeUndefined();
  });

  it("retains the newest 100 acknowledged cache entries and protects legacy and unsent rows", async () => {
    const f = fixture();
    const template = await f.queue.enqueue(payload(), { runId: "local-template" });
    f.rows.clear();
    for (let index = 1; index <= 106; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      f.rows.set(id, { ...template, id, source: { runId: `local-${index}` }, state: "sent", localAcknowledgedAt: index, receipt: { id: `accepted-${index}`, submission_id: id } });
    }
    f.rows.set("legacy", { ...template, id: "legacy", state: "sent", localCachePolicy: undefined, localAcknowledgedAt: 0, receipt: { id: "legacy", submission_id: "legacy" } });
    f.rows.set("unlinked", { ...template, id: "unlinked", state: "sent", source: undefined, localCachePolicy: undefined, receipt: { id: "unlinked", submission_id: "unlinked" } });
    f.rows.set("pending", { ...template, id: "pending", state: "pending" });
    expect(await f.queue.pruneAcknowledged(5)).toBe(5);
    expect(f.rows.size).toBe(104);
    expect(await f.queue.pruneAcknowledged(5)).toBe(1);
    expect(f.rows.size).toBe(103);
    expect(f.rows.has("00000000-0000-4000-8000-000000000007")).toBe(true);
    expect(f.rows.has("00000000-0000-4000-8000-000000000006")).toBe(false);
    expect(f.rows.has("legacy") && f.rows.has("unlinked") && f.rows.has("pending")).toBe(true);
  });

  it("rechecks the local source before pruning a queued cache candidate", async () => {
    const f = fixture();
    const entry = await f.queue.enqueue(payload(), { runId: "old-run" });
    const accepted = { ...entry, state: "sent" as const, localAcknowledgedAt: 1000, receipt: { id: "accepted", submission_id: entry.id } };
    f.rows.set(entry.id, accepted);
    const store: BenchmarkOutboxStore = { ...f.store, list: async page => {
      if (!page?.acknowledgedCache) return f.store.list(page);
      f.rows.set(entry.id, { ...accepted, source: { runId: "replacement-run" } });
      return [accepted];
    } };
    const queue = createBenchmarkOutbox({ ...f.options, store });
    expect(await queue.pruneAcknowledged()).toBe(0);
    expect(f.rows.get(entry.id)?.source?.runId).toBe("replacement-run");
  });

  it("resolves selected entries by primary key past page limits", async () => {
    const f = fixture(); await f.queue.enqueue(payload());
    const limited = createBenchmarkOutbox({ ...f.options, store: { ...f.store, list: async () => [] } });
    expect(await limited.get(payload().submission_id)).toMatchObject({ id: payload().submission_id });
    expect(await limited.get("00000000-0000-4000-8000-000000009999")).toBeUndefined();
  });

  it("never reopens terminal deletes on explicit retry or selected dispatch", async () => {
    const f = fixture(); await f.queue.enqueue(payload());
    const id = payload().submission_id;
    f.rows.set(id, { ...f.rows.get(id)!, state: "rejected", error: { code: "submission_deleted", status: 410 } });
    await f.queue.retry(id);
    expect((await f.queue.get(id))?.state).toBe("rejected");
    expect((await f.queue.get(id))?.error).toMatchObject({ code: "submission_deleted" });
    const submit = vi.fn(async () => ({ id: "run-1", submission_id: id }));
    expect(await f.queue.dispatchSelected(id, { destination: "https://example.test/v1/benchmark-runs", submitSnapshot: submit })).toBe(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps wrapper publications off the legacy flush path", async () => {
    const f = fixture();
    await f.queue.enqueuePublication({ benchmark: payload(), description_md: "hello" });
    await f.queue.enqueue({ ...payload(), submission_id: "00000000-0000-4000-8000-000000000002" });
    const submit = vi.fn(client().submit);
    expect(await f.queue.flush(client(submit))).toBe(1);
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][0].submission_id).toBe("00000000-0000-4000-8000-000000000002");
    expect((await f.queue.get(payload().submission_id))?.state).toBe("pending");
  });

  it("keeps verification blocks eligible for dispatch right after verification", async () => {
    const f = fixture();
    await f.queue.enqueuePublication({ benchmark: payload(), description_md: "" }, { origin: "https://example.test" });
    const id = payload().submission_id;
    const destination = "https://example.test/v1/benchmark-runs";
    const blocked = vi.fn(async () => { throw Object.assign(new HttpError("http", "Verify first.", true, 401), { serviceCode: "verification_required" }); });
    expect(await f.queue.dispatchSelected(id, { destination, submitSnapshot: blocked })).toBe(0);
    const pending = (await f.queue.get(id))!;
    expect(pending.state).toBe("pending");
    expect(pending.error?.code).toBe("verification_required");
    // Eligible without advancing past the old exponential delay, and no global cooldown.
    expect(await f.store.cooldown(destination)).toBe(0);
    const submit = vi.fn(async (entry: QueuedBenchmark) => ({ id: "run-1", submission_id: entry.id }));
    expect(await f.queue.dispatchSelected(id, { destination, submitSnapshot: submit })).toBe(1);
    expect(submit).toHaveBeenCalledOnce();
    expect((await f.queue.get(id))?.state).toBe("sent");
  });

  it("rejects conflicting body hashes and mismatched origin bindings", async () => {
    const f = fixture();
    await f.queue.enqueuePublication({ benchmark: payload(), description_md: "" }, { bodySha256: "a".repeat(64), origin: "https://example.test" });
    const id = payload().submission_id;
    await expect(f.queue.enqueuePublication({ benchmark: payload(), description_md: "" }, { bodySha256: "b".repeat(64) }))
      .rejects.toThrow("different body hash");
    await expect(f.queue.enqueuePublication({ benchmark: payload(), description_md: "" }, { origin: "https://other.test" }))
      .rejects.toThrow("different destination");
    // A destination whose origin disagrees with the bound origin cannot claim the entry.
    const submit = vi.fn(async (entry: QueuedBenchmark) => ({ id: "run-1", submission_id: entry.id }));
    expect(await f.queue.dispatchSelected(id, { destination: "https://other.test/v1/benchmark-runs", submitSnapshot: submit })).toBe(0);
    expect(submit).not.toHaveBeenCalled();
    expect((await f.queue.get(id))?.destination).toBeUndefined();
    expect((await f.queue.get(id))?.origin).toBe("https://example.test");
  });

  it("binds origin on first dispatch and never overwrites bound destinations", async () => {    const f = fixture();
    await f.queue.enqueuePublication({ benchmark: payload(), description_md: "notes" }, { bodySha256: "a".repeat(64), credentialRef: "cred-1" });
    const id = payload().submission_id;
    const destination = "https://example.test/v1/benchmark-runs";
    const accept = async (entry: QueuedBenchmark) => ({ id: "run-1", submission_id: entry.id });
    expect(await f.queue.dispatchSelected(id, { destination, submitSnapshot: accept })).toBe(1);
    const sent = (await f.queue.get(id))!;
    expect(sent.origin).toBe("https://example.test");
    expect(sent.bodySha256).toBe("a".repeat(64));
    expect(sent.credentialRef).toBe("cred-1");
    const other = vi.fn(async () => ({ id: "run-1", submission_id: id }));
    expect(await f.queue.dispatchSelected(id, { destination: "https://other.test/v1/benchmark-runs", submitSnapshot: other })).toBe(0);
    expect(other).not.toHaveBeenCalled();
    expect((await f.queue.get(id))?.destination).toBe(destination);
  });
});

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }))); });

describe("benchmark HTTP contract", () => {
  it("uses a stable idempotency key and fresh credentials against an HTTP server", async () => {
    const received: Array<{ authorization?: string; key?: string | string[]; body: unknown }> = [];
    const server = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      received.push({ authorization: request.headers.authorization, key: request.headers["idempotency-key"], body: JSON.parse(Buffer.concat(chunks).toString()) });
      if (received.length === 1) { response.writeHead(503, { "Retry-After": "2" }); response.end(); }
      else { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ id: "public-1", submission_id: payload().submission_id })); }
    });
    servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server port.");
    let credentials = "synthetic-first";
    const api = createBenchmarkClient({ baseUrl: `http://127.0.0.1:${address.port}`, accessToken: async () => credentials });
    const f = fixture(); await f.queue.enqueue(payload()); await f.queue.flush(api);
    credentials = "synthetic-second"; f.advance(2000); await f.queue.flush(api);
    expect(received.map((entry) => entry.key)).toEqual([payload().submission_id, payload().submission_id]);
    expect(received.map((entry) => entry.authorization)).toEqual(["Bearer synthetic-first", "Bearer synthetic-second"]);
    expect(received[1].body).toEqual(payload());
    expect((await f.queue.list())[0].receipt?.id).toBe("public-1");
    expect(JSON.stringify(await f.queue.list())).not.toContain("synthetic-");
  });

  it("rejects mismatched receipts and unsafe service URLs", async () => {
    for (const baseUrl of ["http://example.test", "https://user:password@example.test", "https://example.test?token=secret"]) {
      expect(() => createBenchmarkClient({ baseUrl })).toThrow("HTTPS");
    }
    const api = createBenchmarkClient({ baseUrl: "https://example.test", fetcher: async () => new Response(JSON.stringify({ id: "public-1", submission_id: "different" })) });
    await expect(api.submit(payload())).rejects.toMatchObject({ code: "invalid_response" });
  });
});
