// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../api/http.ts";
import type { LegacyPublicBenchmarkSubmission, PublicBenchmarkSubmission } from "../contracts/benchmark/publicBenchmark.ts";
import { createBenchmarkOutbox, type BenchmarkLocalSource, type BenchmarkOutboxStore, type MeasurementActivity, type QueuedBenchmark, type SelectedEntryTransport } from "./outbox.ts";
import { createIndexedDbOutbox } from "./indexedDbOutbox.ts";

const payload = (): LegacyPublicBenchmarkSubmission => ({
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

type Fixture = ReturnType<typeof fixture>;

const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const destination = "https://example.test/v1/benchmark-runs";

const benchmarkFor = (id = firstId): LegacyPublicBenchmarkSubmission => ({ ...payload(), submission_id: id });

/** A bare row as earlier app versions persisted it in IndexedDB: no frozen wrapper bytes. */
function legacyRow(f: Fixture, id = firstId, extra: Partial<QueuedBenchmark> = {}): QueuedBenchmark {
  const row: QueuedBenchmark = { id, payload: benchmarkFor(id), state: "pending", createdAt: 1000, attempts: 0, nextAttemptAt: 0, ...extra };
  f.rows.set(id, structuredClone(row));
  return row;
}

function publish(queue: Fixture["queue"], id = firstId, source?: BenchmarkLocalSource) {
  return queue.enqueuePublication({ benchmark: benchmarkFor(id), description_md: "" }, source ? { source } : {});
}

function transport(submit?: SelectedEntryTransport["submitSnapshot"], target = destination): SelectedEntryTransport {
  return { destination: target, submitSnapshot: submit ?? (async (entry) => ({ id: "run-1", submission_id: entry.id })) };
}

describe("reviewed benchmark outbox", () => {
  it("deduplicates a reviewed publication, rejects changed content and copies caller data", async () => {
    const f = fixture(); const input = payload();
    await f.queue.enqueuePublication({ benchmark: input, description_md: "" });
    await f.queue.enqueuePublication({ benchmark: payload(), description_md: "" });
    input.execution.parallel = 4;
    await expect(f.queue.enqueuePublication({ benchmark: input, description_md: "" })).rejects.toThrow("different reviewed payload");
    expect((f.rows.get(firstId)?.payload as LegacyPublicBenchmarkSubmission).execution.parallel).toBe(2);
    expect(f.rows.size).toBe(1);
    await expect(f.queue.enqueuePublication({ benchmark: { ...payload(), local_path: "private" } as unknown as PublicBenchmarkSubmission, description_md: "" }))
      .rejects.toThrow("Invalid public benchmark");
  });

  it("fails visibly when durable storage is unavailable or a transaction fails", async () => {
    await expect(createIndexedDbOutbox(undefined).list()).rejects.toThrow("unavailable");
    const f = fixture();
    const queue = createBenchmarkOutbox({ ...f.options, store: { ...f.store, mutate: async () => { throw new Error("Quota exceeded"); } } });
    await expect(publish(queue)).rejects.toThrow("Quota exceeded");
  });

  it("claims an existing bare entry atomically across workers and recovers an expired interrupted upload", async () => {
    const f = fixture(); legacyRow(f);
    const second = createBenchmarkOutbox(f.options);
    const submit = vi.fn(transport().submitSnapshot);
    await Promise.all([f.queue.dispatchSelected(firstId, transport(submit)), second.dispatchSelected(firstId, transport(submit))]);
    expect(submit).toHaveBeenCalledOnce();
    expect(f.rows.get(firstId)?.state).toBe("sent");
    const row = f.rows.get(firstId)!;
    f.rows.set(row.id, { ...row, state: "sending", leaseToken: "expired", leaseUntil: 500, nextAttemptAt: 0 });
    await second.dispatchSelected(firstId, transport(submit));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][0]).toMatchObject({ id: firstId, payload: payload() });
    expect(submit.mock.calls[1][0].requestBody).toBeUndefined();
  });

  it("waits for Retry-After and never retries a permanent rejection without a request", async () => {
    const f = fixture(); legacyRow(f);
    const submit = vi.fn<SelectedEntryTransport["submitSnapshot"]>()
      .mockRejectedValueOnce(new HttpError("http", "HTTP 429", true, 429, 20_000))
      .mockRejectedValueOnce(new HttpError("http", "HTTP 401", false, 401))
      .mockImplementation(transport().submitSnapshot);
    await f.queue.dispatchSelected(firstId, transport(submit));
    f.advance(19_999); await f.queue.dispatchSelected(firstId, transport(submit)); expect(submit).toHaveBeenCalledOnce();
    f.advance(1); await f.queue.dispatchSelected(firstId, transport(submit)); expect(f.rows.get(firstId)?.state).toBe("rejected");
    f.advance(100_000); await f.queue.dispatchSelected(firstId, transport(submit)); expect(submit).toHaveBeenCalledTimes(2);
    await f.queue.retry(firstId); await f.queue.dispatchSelected(firstId, transport(submit)); expect(f.rows.get(firstId)?.state).toBe("sent");
  });

  it("pauses during measurement and aborts a running upload when a benchmark starts", async () => {
    const f = fixture(); legacyRow(f); f.setActive(true);
    const submit = vi.fn<SelectedEntryTransport["submitSnapshot"]>().mockImplementation(async (_entry, signal) => {
      f.setActive(true); expect(signal?.aborted).toBe(true);
      return new Promise(() => {});
    });
    await f.queue.dispatchSelected(firstId, transport(submit)); expect(submit).not.toHaveBeenCalled();
    f.setActive(false); await f.queue.dispatchSelected(firstId, transport(submit));
    expect(submit).toHaveBeenCalledOnce(); expect(f.rows.get(firstId)?.state).toBe("pending");
  });

  it("binds retries of an existing bare entry to its original service", async () => {
    const f = fixture(); legacyRow(f);
    await f.queue.dispatchSelected(firstId, transport(async () => { throw new HttpError("network", "Unavailable", true); }));
    f.advance(100_000);
    const submit = vi.fn(transport().submitSnapshot);
    expect(await f.queue.dispatchSelected(firstId, transport(submit, "https://another.test/v1/benchmark-runs"))).toBe(0);
    expect(submit).not.toHaveBeenCalled();
    expect(f.rows.get(firstId)?.destination).toBe(destination);
  });

  it("applies a server cooldown to other pending submissions and worker restarts", async () => {
    const f = fixture(); legacyRow(f); legacyRow(f, secondId);
    const submit = vi.fn<SelectedEntryTransport["submitSnapshot"]>().mockRejectedValueOnce(new HttpError("http", "Busy", true, 429, 5000)).mockImplementation(transport().submitSnapshot);
    await f.queue.dispatchSelected(firstId, transport(submit)); expect(submit).toHaveBeenCalledOnce();
    const restarted = createBenchmarkOutbox(f.options);
    f.advance(4999); expect(await restarted.dispatchSelected(secondId, transport(submit))).toBe(0); expect(submit).toHaveBeenCalledOnce();
    f.advance(1);
    expect(await restarted.dispatchSelected(secondId, transport(submit))).toBe(1);
    expect(await restarted.dispatchSelected(firstId, transport(submit))).toBe(1);
  });

  it("does not count or overwrite a receipt after another worker recovers its lease", async () => {
    const f = fixture(); legacyRow(f);
    let deliver!: (value: { id: string; submission_id: string }) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const first = f.queue.dispatchSelected(firstId, transport(async () => new Promise((resolve) => { deliver = resolve; started(); })));
    await waiting; f.advance(120_001);
    const second = createBenchmarkOutbox(f.options);
    expect(await second.dispatchSelected(firstId, transport())).toBe(1);
    deliver({ id: "late-receipt", submission_id: firstId });
    expect(await first).toBe(0);
    expect(f.rows.get(firstId)?.receipt?.id).toBe("run-1");
  });

  it("keeps remote acceptance when local acknowledgement fails and reconciles after restart without another POST", async () => {
    const f = fixture();
    const failedAcknowledgement = vi.fn(async (entry: QueuedBenchmark) => {
      expect(f.rows.get(entry.id)?.state).toBe("sent");
      throw new Error("Local record is temporarily unavailable");
    });
    const queue = createBenchmarkOutbox({ ...f.options, onAccepted: failedAcknowledgement });
    const source = { runId: "local-run-1" };
    await publish(queue, firstId, source);
    source.runId = "changed-after-enqueue";
    const submit = vi.fn(transport().submitSnapshot);
    expect(await queue.dispatchSelected(firstId, transport(submit))).toBe(1);
    expect(submit).toHaveBeenCalledOnce();
    const sentBody = submit.mock.calls[0][0].requestBody!;
    expect(JSON.parse(sentBody).benchmark).toEqual(payload());
    expect(sentBody).not.toContain("local-run");
    expect(f.rows.get(firstId)).toMatchObject({ state: "sent", attempts: 1, source: { runId: "local-run-1" }, receipt: { id: "run-1" } });
    expect(f.rows.get(firstId)?.localAcknowledgedAt).toBeUndefined();
    const onAccepted = vi.fn(async () => undefined);
    const restarted = createBenchmarkOutbox({ ...f.options, onAccepted });
    f.advance(1000);
    expect(await restarted.reconcileAccepted()).toBe(1);
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(f.rows.get(firstId)?.localAcknowledgedAt).toBe(2000);
    expect(f.rows.get(firstId)?.localReconcileAt).toBeUndefined();
    expect(await restarted.dispatchSelected(firstId, transport(submit))).toBe(0);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("leaves source-less legacy receipts untouched and refuses to rewrap an attempted bare submission", async () => {
    const f = fixture();
    legacyRow(f, firstId, { state: "sent", attempts: 1, destination, receipt: { id: "legacy-receipt", submission_id: firstId } });
    const original = structuredClone(f.rows.get(firstId));
    const onAccepted = vi.fn(async () => undefined);
    const queue = createBenchmarkOutbox({ ...f.options, onAccepted });
    expect(await queue.reconcileAccepted()).toBe(0);
    expect(onAccepted).not.toHaveBeenCalled();
    await expect(publish(queue, firstId, { runId: "local-run" })).rejects.toThrow("already attempted as a legacy request");
    const submit = vi.fn(transport().submitSnapshot);
    expect(await queue.dispatchSelected(firstId, transport(submit))).toBe(0);
    expect(submit).not.toHaveBeenCalled();
    expect(f.rows.get(firstId)).toEqual(original);
  });

  it("wraps a never-attempted bare entry in place only for the same reviewed payload and local source", async () => {
    const f = fixture(); legacyRow(f, firstId, { createdAt: 500 });
    const changed = { ...payload(), execution: { ...payload().execution, parallel: 4 } };
    await expect(f.queue.enqueuePublication({ benchmark: changed, description_md: "" })).rejects.toThrow("different reviewed payload");
    expect(f.rows.get(firstId)?.requestBody).toBeUndefined();
    const wrapped = await f.queue.enqueuePublication({ benchmark: payload(), description_md: "notes" }, { source: { runId: "local-run" } });
    expect(wrapped).toMatchObject({ id: firstId, createdAt: 500, state: "pending", attempts: 0, descriptionMd: "notes", source: { runId: "local-run" }, localCachePolicy: "acknowledged-v1" });
    expect(JSON.parse(wrapped.requestBody!)).toMatchObject({ benchmark: payload(), description_md: "notes" });
    await expect(f.queue.enqueuePublication({ benchmark: payload(), description_md: "notes" }, { source: { runId: "other-run" } })).rejects.toThrow("different local benchmark");
    await expect(publish(f.queue, firstId, { runId: "x".repeat(129) })).rejects.toThrow("Invalid local benchmark source");
    await expect(publish(f.queue, firstId, { runId: "가".repeat(43) })).rejects.toThrow("Invalid local benchmark source");
  });

  it("attaches an explicit local source to an accepted publication once without rebinding it", async () => {
    const f = fixture(); await publish(f.queue); await f.queue.dispatchSelected(firstId, transport());
    const onAccepted = vi.fn(async () => undefined);
    const queue = createBenchmarkOutbox({ ...f.options, onAccepted });
    expect(await queue.reconcileAccepted()).toBe(0);
    expect(onAccepted).not.toHaveBeenCalled();
    await publish(queue, firstId, { runId: "local-run" });
    await publish(queue, firstId, { runId: "local-run" });
    await expect(publish(queue, firstId, { runId: "other-run" })).rejects.toThrow("different local benchmark");
    expect(await queue.reconcileAccepted()).toBe(1);
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(f.rows.get(firstId)?.source).toEqual({ runId: "local-run" });
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
    await publish(queue, firstId, { runId: "local-run" });
    const submit = vi.fn(transport().submitSnapshot);
    expect(await queue.dispatchSelected(firstId, transport(submit))).toBe(1);
    expect(f.rows.get(firstId)?.state).toBe("sent");
    failAcknowledgement = false; f.advance(1000);
    expect(await queue.reconcileAccepted()).toBe(1);
    expect(onAccepted).toHaveBeenCalledTimes(2);
    expect(await queue.dispatchSelected(firstId, transport(submit))).toBe(0);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("bounds local reconciliation and pauses it during measurement", async () => {
    const f = fixture();
    for (let index = 1; index <= 3; index += 1) {
      const id = `00000000-0000-4000-8000-00000000000${index}`;
      await publish(f.queue, id, { runId: `local-${index}` });
      await f.queue.dispatchSelected(id, transport());
    }
    const onAccepted = vi.fn(async () => undefined);
    const queue = createBenchmarkOutbox({ ...f.options, onAccepted });
    f.setActive(true); expect(await queue.reconcileAccepted(2)).toBe(0);
    f.setActive(false); expect(await queue.reconcileAccepted(2)).toBe(2);
    expect(onAccepted).toHaveBeenCalledTimes(2);
    expect(await queue.reconcileAccepted(2)).toBe(1);
    expect(onAccepted).toHaveBeenCalledTimes(3);
  });

  it("shares a local acknowledgement attempt between concurrent reconciliation calls", async () => {
    const f = fixture(); await publish(f.queue, firstId, { runId: "local-run" }); await f.queue.dispatchSelected(firstId, transport());
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
    const f = fixture(); await publish(f.queue, firstId, { runId: "local-run" });
    let fail!: (error: Error) => void; let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const first = createBenchmarkOutbox({ ...f.options, onAccepted: () => new Promise<void>((_, reject) => { fail = reject; began(); }) });
    const sending = first.dispatchSelected(firstId, transport());
    await started;
    const second = createBenchmarkOutbox({ ...f.options, onAccepted: async () => undefined });
    expect(await second.reconcileAccepted()).toBe(1);
    fail(new Error("Late local failure"));
    expect(await sending).toBe(1);
    expect(f.rows.get(firstId)).toMatchObject({ state: "sent", localAcknowledgedAt: 1000 });
    expect(f.rows.get(firstId)?.localReconcileAt).toBeUndefined();
  });

  it("retains the newest 100 acknowledged cache entries and protects legacy and unsent rows", async () => {
    const f = fixture();
    const template = await publish(f.queue, firstId, { runId: "local-template" });
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
    const entry = await publish(f.queue, firstId, { runId: "old-run" });
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
    const f = fixture(); await publish(f.queue);
    const limited = createBenchmarkOutbox({ ...f.options, store: { ...f.store, list: async () => [] } });
    expect(await limited.get(payload().submission_id)).toMatchObject({ id: payload().submission_id });
    expect(await limited.get("00000000-0000-4000-8000-000000009999")).toBeUndefined();
  });

  it("never reopens terminal deletes on explicit retry or selected dispatch", async () => {
    const f = fixture(); await publish(f.queue);
    const id = payload().submission_id;
    f.rows.set(id, { ...f.rows.get(id)!, state: "rejected", error: { code: "submission_deleted", status: 410 } });
    await f.queue.retry(id);
    expect((await f.queue.get(id))?.state).toBe("rejected");
    expect((await f.queue.get(id))?.error).toMatchObject({ code: "submission_deleted" });
    const submit = vi.fn(async () => ({ id: "run-1", submission_id: id }));
    expect(await f.queue.dispatchSelected(id, { destination: "https://example.test/v1/benchmark-runs", submitSnapshot: submit })).toBe(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it("dispatches only the selected entry and sends an existing bare entry without inventing wrapper bytes", async () => {
    const f = fixture();
    await publish(f.queue);
    legacyRow(f, secondId);
    const submit = vi.fn(transport().submitSnapshot);
    expect(await f.queue.dispatchSelected(secondId, transport(submit))).toBe(1);
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][0]).toMatchObject({ id: secondId, payload: benchmarkFor(secondId) });
    expect(submit.mock.calls[0][0].requestBody).toBeUndefined();
    expect(f.rows.get(firstId)).toMatchObject({ state: "pending", attempts: 0 });
    expect(f.rows.get(secondId)).toMatchObject({ state: "sent", receipt: { id: "run-1", submission_id: secondId } });
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
