# Benchmark history and sharing

The website backend owns accepted benchmark results: database writes, anonymous
owner-proof authorization, public queries, edits and deletion belong to that
service. There are no user accounts in v1; management uses the owner recovery
secret, never a stored access token. The app measures workloads, prepares
reviewed submissions and calls the service. It does not contain the website API
server, database migrations or database credentials. The website owns its
PostgreSQL schema, migrations and runtime roles. Repository ownership is
described in [Project boundaries](project-boundaries.md).

Benchmark recovery data is saved by the native runner in `benchmarks/runs` under Tauri's
OS app data directory. Each journal contains launch metadata, completed trials
and final status. A completed trial is synced outside the timed interval before
the progress event is emitted. Local results are loaded in pages of at most 100
records. An interrupted journal recovers its
complete events; corrupt records are preserved and reported without blocking
other history. Active runs are excluded until the runner releases their journal.

The first history read imports valid legacy browser records in batches of 100.
Imports preserve existing native run IDs and leave the original localStorage
bytes intact. Retrying an interrupted migration is safe. CSV exports retain
local diagnostic context; the public JSON export uses a separate contract.

## Public data contract

- `packages/benchmark-contracts/schema/public-benchmark.schema.json` defines public version 1.
- `packages/benchmark-contracts/schema/openapi.json` defines `POST /v1/benchmark-runs`.
- `@aiolm/benchmark-contracts` provides standalone DTOs, validation and measurement
  summaries, with no app, Tauri, React, HTTP or database dependency.
- `shared/contracts/benchmark/publicBenchmark.ts` is the app-specific adapter
  that constructs public fields from local measurement records.

Submissions contain numeric measurements, workload and corpus identity, model
identity, runtime version, selected execution settings, the measured launch
options and an environment snapshot. They exclude local filenames and paths,
error messages, machine fingerprints, persistent device identifiers and local
record IDs. Unknown values remain null. Public labels are bounded and reject
path-like content. A reviewed submission has its own UUID; changing its content
requires a new UUID.

Contract 0.5.0 additionally accepts optional `execution.effective_args`: the
llama-server options the measured run was started with, in order, as separate
tokens, so a reader can reproduce the setup rather than infer it from the
curated `execution.settings` fields. The adapter publishes an option only with
the value it was given, and drops every option that names the publisher's
machine: model, projector, draft model, LoRA and other file arguments, the
listening host and port, aliases, prompt text, and anything whose option name
reads as a credential. A token that would still contain a path separator,
scheme or address is refused by the schema, so an option a newer runtime adds
cannot leak one either. What remains is the tuning configuration. The website
must accept contract 0.5.0 before an app build starts sending this field: older
validators reject fields they do not recognize.

Contract 0.3.0 additionally accepts optional `model.metadata`. New runs can record
declared GGUF name, architecture, parameter size label, weight quantization,
quantizer and public base-model repositories. A public repository identifies its
distributor; the quantizer is a separate field. A file-matched download receipt
may add a repository-relative artifact name, which is not a local filename or
filesystem path. Filename guesses never supply a publisher or quantization.
These declarations do not establish model quality or identical tensors; use the
model digest to distinguish exact files. Old records and frozen publication
snapshots keep their original metadata. Roll out the accepting web contract
before distributing an app that submits the optional metadata.

The method and corpus versions identify how a result was produced. SHA256 model
identification is an explicit preparation action performed while execution is
idle. Later runs read its metadata-validated cache without hashing the model
again. Multipart models remain `multipart` with an unknown digest until a complete
shard-manifest format is implemented. Legacy records without provenance remain
unidentified. These values describe reported local measurements; they do not
provide server-verified authenticity or a universal hardware ranking.

Installed GPUs are recorded separately from configured selection. CPU mode,
explicit selections, automatic placement and unconfirmed overrides remain
distinct. A selected GPU is a launch configuration fact, not telemetry proving
that every layer or kernel ran there. Missing runtime-default settings remain
unknown instead of being inferred from the current UI. Only compare speedups
with matching prompt size, output size and timing method; cached prompts and
failed or missing samples cannot establish an uncontaminated speedup.

## Connecting a service

The app offers publication-wrapper review/export, local queue management, and
anonymous publishing through a configured service origin. There is no default
sharing service and no stored access token. The service origin comes from the
`AIOLM_BENCHMARK_API_URL` build environment through the native configuration
command; publishing stays disabled when it is absent or invalid, while review,
export and queueing still work offline. Packaged Windows releases receive it
from the release workflow's `AIOLM_BENCHMARK_API_URL` repository variable, and
build verification rejects a configured value a release build cannot use, so an
enabled release cannot ship with publishing silently off. See
[Development](../guides/development.md) for packaging a build with or without a
service. Publishing is opt-in per configured
origin in this order: the reviewer writes a Markdown description (max 4000
characters, paragraphs/lists/HTTP(S) links/code blocks only), the app durably
persists the exact unbound `{benchmark, description_md}` wrapper first, the
native runner then binds the OS-vault owner key to that body hash and the
binding metadata attaches idempotently to the same wrapper, and a browser
verification binds a short-lived upload permit before the identical bytes are
submitted. A cancelled or late native binding never attaches or sends, but the
original unbound wrapper stays queued for retry and restart. The frozen
snapshot never changes afterwards, and retries resend the identical bytes under
the `Idempotency-Key` equal to `submission_id`. Owner secrets and upload
permits stay in the native runner and never enter WebView state. Review
hydrates the persisted wrapper before export or publishing becomes usable, so a
reload restores the exact frozen bytes rather than a re-derived draft.

```ts
import { createNativeSelectedTransport } from '../../shared/sharing/nativeTransport';
import { createPublicationController } from '../../shared/sharing/publicationController';
import { dispatchSelectedBenchmark } from '../../shared/sharing/benchmarkOutbox';

// The controller persists the exact unbound wrapper, binds the native
// owner key, runs browser verification, then dispatches the exact selected
// entry. Owner secrets and upload permits never cross into WebView state.
const controller = createPublicationController({ measurement, outbox });
await controller.prepare({ benchmark, description_md }, { runId });
await controller.publishSelected(submissionId, createNativeSelectedTransport(destination), abortController.signal);
```

Legacy bare submissions keep working through the offline queue path below.
Selected publication entries never travel it: the legacy HTTP client cannot
carry descriptions or exact frozen bytes.

The native transport accepts a configured origin over HTTPS; loopback HTTP is
allowed for local integration tests. It refuses credential-bearing URLs and
redirects, omits browser cookies and referrers, and attaches the owner proof
and single-use upload permit inside the native runner for each attempt. The
reviewed bytes are frozen before the owner key is bound. Requests carry
`Idempotency-Key` equal to `submission_id`; the service must atomically enforce
that key within the owner scope. Identical retries return the same receipt,
including accepted-request replay without a fresh permit. Reusing a key with a
different payload returns 409. Both 200 and 201 return `{submission_id, id, url?}`;
the client verifies the submission ID and only retains same-origin result URLs.
Permission expiry surfaces a recoverable verification block rather than a
permanent rejection; deleted submissions are terminal and never retried.
The website must configure CORS for its supported clients.

The outbox is stored in IndexedDB separately from native history. A queue success
means the write transaction committed; unavailable storage and quota failures are
reported instead of silently falling back to memory. Entries are independently
addressable, and reads return cursor pages of at most 100 entries. Browser storage
clearing or eviction can remove the queue; the native run history is independent
and can be used to prepare another public export.

Ownership records live in a permanent native registry outside the queue, so
pruning the acknowledged cache never strands owner keys. The app lists them
through a paginated native command independent of queue/history and offers
per-entry recovery file export/import, clipboard copy and management-page
controls; recovery codes use `aiolm-recovery-v1.` base64url JSON
`{version, origin, submission_id, secret}`, are handled by native file dialogs
and pasted-code validation, and never kept in WebView state or navigation URLs.
A recovered secret conveys exactly the original authority. A lost key and a
lost backup cannot be recovered automatically.

Edits and deletion belong to the website: descriptions change only through a
revision-checked request, and deletion removes payload data while the service
retains a minimal tombstone. Retrying an accepted deleted submission reports a
terminal state. Local queue removal or cache eviction never deletes website
results and never calls the website deletion API.

## Accepted results and local cache

The reviewed queue entry keeps an optional local run reference outside the
public request. After a successful response, the outbox commits the server receipt
before acknowledging it to the native recovery store. A local write failure
leaves the item uploaded; later reconciliation retries only the local operation
and never resends an accepted submission. Cache cleanup warnings are reported
separately and do not block acknowledgement of a durable receipt. Later native
acknowledgements retry cache maintenance. History initialization and
explicit dispatch perform bounded reconciliation while measurement is idle.

Only records created by the native runner under the new cache policy, finalized
as complete or partial, and newly acknowledged by the service are eligible for
automatic eviction. The app retains the 100 most recent eligible local copies.
Native receipt files remain after eviction so migration cannot resurrect an
evicted journal. The native store verifies a journal still matches the acknowledged
copy before deleting it. Active, interrupted, unuploaded, failed, cancelled,
legacy-imported and existing records without the new origin marker are protected.
These protections can leave more than 100 total local records.
Operating-system file locks serialize storage changes across app processes and
protect active journals until their owner exits. Lock filenames remain stable;
process exit releases the lock without requiring stale-file deletion. Before
eviction, the store confirms both the receipt and its directory entries are durable,
including retries after an earlier sync failure.
Activity markers keep lock checks limited to current/recovering runs and the
requested history page; reading a page does not open every archived journal's lock.

New source-linked queue entries that have completed local acknowledgement also
retain at most the latest 100 eligible entries after bounded maintenance. Pending,
rejected, unacknowledged and pre-policy entries are retained. Eviction and manual
queue removal affect local copies only: neither action deletes the website's
result. Server-side deletion is a separate owner-proof website operation.

Dispatch uses atomic leases so concurrent workers cannot claim the same active
entry. A lease expires after 120 seconds; a single dispatch attempt is cancelled
after 60 seconds, including a stalled credential provider. The HTTP attempt has
its own 30-second default deadline and a 16 KiB receipt limit. Network and retryable
HTTP failures use exponential backoff with jitter; `Retry-After` can extend that
delay. The retry deadline is persisted per destination and stops subsequent jobs
and workers from immediately retrying the same service. Permanent failures remain
rejected until explicitly retried. An entry stays bound to its first destination.

The desktop adapter observes benchmark tasks: it defers dispatch while measuring
and aborts an in-flight upload when measurement starts. Other hosts can inject
their own measurement activity source. No implementation can guarantee that a
cancelled request was not accepted remotely; idempotent receipt replay is required
to handle response loss, cancellation and process restarts correctly.

## Validation

Unit tests cover public-field exclusion, malformed data, aggregation, migration,
recovery UI, leases, cancellation, retries and errors. HTTP integration tests use
a synthetic loopback server. Native persistence and identity tests use unique
temporary directories and synthetic model files, including acknowledged-cache
eviction and protection of recovery data. Package tests install a packed archive
offline into an isolated consumer and check Node/browser imports and declarations.
Browser checks use a distinct
test database to verify transaction rollback, concurrent claims, cursor pages and
reload persistence, including the v1-to-v2 queue migration, without altering the
app's queue.
