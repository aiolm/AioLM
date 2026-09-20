import { getTaskSnapshot, subscribeTasks } from "../state/taskRegistry.ts";
import { createIndexedDbOutbox } from "./indexedDbOutbox.ts";
import { createBenchmarkOutbox } from "./outbox.ts";
import { acknowledgeUploadedBenchmark } from "./desktopBenchmarkStorage.ts";
import { isNativeRuntimeAvailable } from "../api/transport.ts";

/** Desktop wiring; the outbox engine and HTTP client have no native or UI dependency. */
const outbox = createBenchmarkOutbox({
  store: createIndexedDbOutbox(),
  measurement: {
    isActive: () => getTaskSnapshot().some((task) => task.kind === "benchmark" && (task.state === "running" || task.state === "cancelling")),
    subscribe: subscribeTasks,
  },
  onAccepted: acknowledgeUploadedBenchmark,
});

export const enqueuePublicBenchmark = outbox.enqueue;
export const enqueuePublicationBenchmark = outbox.enqueuePublication;
export const getQueuedBenchmark = outbox.get;
export const listQueuedBenchmarks = outbox.list;
export const removeQueuedBenchmark = outbox.remove;
export const retryQueuedBenchmark = outbox.retry;
export const dispatchSelectedBenchmark = outbox.dispatchSelected;
/** Reconcile durable receipts with local recovery storage without any network request. */
export const reconcileAcceptedBenchmarks = (maxItems = 100) => isNativeRuntimeAvailable()
  ? outbox.reconcileAccepted(maxItems)
  : Promise.resolve(0);
/** Requires an explicitly configured client; no service URL or credentials are defaulted. */
export const dispatchQueuedBenchmarks = outbox.flush;
