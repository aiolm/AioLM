# Benchmark history and sharing

Benchmark results are saved on your computer. Sharing a result on the AioLM
website is optional and happens only when you publish it. The website stores
published results and handles their public pages, edits and deletion. There are
no user accounts: a published result is managed with an owner key that AioLM
keeps in your operating system's credential store.

## Local history

The benchmark runner saves each run in `benchmarks/runs` under the data folder
(`~/.aiolm`, or `AIOLM_HOME`). A run's journal contains its launch metadata,
completed trials and final status. Completed trials are written as they finish,
so an interrupted run keeps the measurements it completed. A damaged record is
kept and reported without hiding the rest of the history. History loads in
pages of at most 100 runs.

Serving history replay follows the journal's 16 MiB budget, so a valid large
concurrency/repetition grid is not rejected by the older 4 MiB local-record
ceiling. Legacy local records and public publication retain their 4 MiB limits.

Results that earlier versions kept in browser storage are imported the first
time history opens. The original browser data is left unchanged, and an
interrupted import is safe to retry.

Excel, CSV and Markdown exports contain a readable results report without local
paths. See [Benchmarks](benchmarks.md) for measurement details, exports and
deletion.

## Versioned public contracts

`@aiolm/benchmark-contracts` 0.11.0 accepts legacy schema1/2 snapshots and
schema3 cap-based `openai-chat-serving@1` unchanged through the same `/v1` API,
and adds fixed-output `openai-chat-serving@2` with per-request count evidence.
Schema3 identifies inputs by exact UTF-8 byte count and SHA-256, not token
length. Its runtime identity has six nullable fields and permits any safe
engine name, including an unknown name. Model format is independent of engine.

Serving measurements preserve observed content and reasoning bytes separately.
First-output timings and end-to-end batch time are client observations.
Method `@2` requires the exact selected output count for every request and
retains those reported counts in launch-slot order; prompt/cache counts may
remain unknown. Historical `@1` keeps optional token/cache counters. Output B/s
and reported tok/s use end-to-end time, not decode-only timing. Zero duration or
a non-finite rate stays unavailable. Repeated measurements use per-metric
median/min/max/sample count; missing observations are not zero. Fixed and cap
methods remain separate comparison scopes.

Schema3 settings are bounded, typed public facts with explicit target, scope,
unit and semantic role. Host snapshots are marked `aiolm_host`; attached or
unknown compute cannot attribute proxy RAM to the inference engine. HF repository
and revision identify provenance, not a weight digest or proof of unmodified
weights. Frozen legacy payloads, IDs, hashes and receipts are never upgraded in
place.

## What a shared result contains

A shared result contains numeric measurements, the workload and corpus
identity, model identity and format (plus declared metadata for GGUF models),
the recorded engine identity, typed execution settings and an AioLM-host
hardware snapshot (including logical and, when known, physical CPU cores).

Schema3 contains no local filenames or paths, raw launch arguments, error
messages, machine fingerprints, persistent device identifiers or local
provider/connection IDs. Adapter annotations must explicitly opt safe settings
into publication; masking runs before typed capture. Model/host/port/auth and
other private lifecycle bindings remain private even if metadata tries to
declare them public. Unknown observations are not filled from the current
machine or runtime defaults.

Any connected text-streaming engine can publish through the same path. Public
name, version, backend, build, variant and plugin version are independent nullable
observations, never reconstructed from process names or local IDs. Missing
identity, model format, settings or token/cache counters does not prevent sharing
a complete successful workload. Legacy snapshots retain their original fields.

New runs collect a complete single-file GGUF SHA-256 before timing, on a blocking
worker with a 64 GiB file-size and 60-second collection bound. An unchanged local
identity cache avoids rereading the file. A changed file, read failure or collection
limit leaves the digest unknown; directory snapshots, references and multipart
models are not assigned a single-file weight digest. This never updates old runs.

The native adapter records binary-reported version/build. It records a bundle's
declared backend only when the manifest version and selected server's complete
file digest match; the installation folder and configured backend are not evidence.
Absent variant/plugin metadata remains unrecorded, not a claim of inapplicability.
For new Common API runs, saved device choices remain unknown before child spawn.
Explicit selection requires a successful native-adapter spawn, resolved devices
present in the host inventory and final arguments consistent with that selection.
Custom, Python and attached profiles do not inherit a native device assignment.
The launch path has no authoritative automatic device-selection result:
automatic placement does not turn an installed GPU into a selected GPU, and
shared host RAM is never substituted for unknown GPU VRAM.

When you compare results, keep these limits in mind:

- A selected GPU records how the run was configured, not proof that every layer
  ran there. CPU mode, explicit selection and automatic placement stay distinct.
- Compare only matching methods, exact input bytes/hashes, output caps, corpus,
  concurrency, warmup and usage-request conditions. Byte rates and legacy token
  rates have different units. As-configured cache is not a cold-cache guarantee.
- For GGUF models, declared metadata states what the file says about itself; it
  does not prove identical tensors or quality. A complete SHA-256 distinguishes exact files when
  available; multipart models have no single digest.
- Results are self-reported local measurements. The website does not verify them
  and they are not a universal hardware ranking.

## Publishing a result

Select a result and expand **Share result**. It shows a readable summary of the
public model information, hardware, runtime, measurement conditions and
results, an optional description and one publish action. The description
accepts Markdown paragraphs, lists, HTTP(S) links and code blocks, up to 4000
characters.

AioLM freezes the exact reviewed content before publishing, so retries send the
identical result and cannot create duplicates. The website may ask you to
complete a browser verification first. After the upload, the publish action is
replaced by website management; reopening the result later shows the same
state without uploading again. Uploads are paused while a benchmark is
measuring, and starting a measurement cancels an upload in progress. Because a
cancelled request may already have reached the website, publishing again
returns the existing result rather than a copy.

### Publishing service

Builds publish to the official AioLM website, `https://aiolm.vercel.app`. A build
can choose another service, or disable publishing, with the
`AIOLM_BENCHMARK_API_URL` setting at build time: an unset or blank value uses
the official website, a root HTTPS origin selects another service, and `off`
disables publishing. An invalid value also disables publishing rather than
falling back to the official website. When publishing is disabled, the summary
and local exports remain available. See
[Build from source](../guides/install.md#build-from-source).

## Managing shared results

**Shared results** lists the results you have published from this computer,
with a website management action for each. Choosing it signs you in to the
website's management page in your browser without showing the owner key. The
sign-in link expires after two minutes and works once. Opening management never
edits or deletes a result by itself.

Edit a result's description or delete it on the website. Deleting removes the
result's data; the website keeps only a minimal record that it existed.
Removing local history or cached copies in AioLM never deletes a published
result.

### Backup and restore

Your owner key is the only permission to edit or delete a published result.
Expand **Backup and restore** in **Shared results** to save a backup file or
copy a recovery code for each result. Keep backups private: anyone with one has
the same permission you do.

- To manage results after reinstalling or on another computer, import the
  backup file there. Import works even when the list is empty.
- The website's management page also accepts AioLM backup `.txt` files; you can
  select several and choose a result from the list. Pasting a recovery code
  remains available as a fallback.

A lost owner key without a backup cannot be recovered.

## Local copies of published results

After the website confirms a result, AioLM records the receipt before cleaning up
local data, so a failed local step is retried without uploading again. AioLM
keeps the 100 most recent local copies of runs it measured and published; older
copies of those runs are removed automatically. Runs that are in progress,
interrupted, not uploaded, failed or cancelled, imported from earlier versions,
or saved before this policy are always kept, so history can hold more than 100
runs.

Publishing state is kept in the app's browser storage, separately from run
history. Clearing that storage can lose unfinished publishing state; your run
history and owner keys are not affected.
