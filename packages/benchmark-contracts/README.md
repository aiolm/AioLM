# Benchmark contracts

This package defines the data exchanged by the desktop benchmark client and the website backend. The website owns accepted results. The app collects measurements, submits reviewed snapshots and retains recovery data and a recent acknowledged-result cache.

The package contains public submission and receipt types, publication wrapper validation, owner recovery encoding, service error/session helpers, runtime validation, measurement aggregation, JSON Schema and OpenAPI. It has no runtime dependencies and imports no app, filesystem, UI or native-runtime code. Local records, private paths, diagnostic text, upload credentials and cache policies remain in their respective applications.

```ts
import {
  validatePublicBenchmark,
  validatePublicationRequest,
  validateBenchmarkReceipt,
  summarizePublicBenchmarkRows,
  encodeRecoveryCode,
  decodeRecoveryCode,
  parseServiceError,
  type PublicBenchmarkSubmission,
  type BenchmarkPublicationRequest,
} from '@aiolm/benchmark-contracts';

const submission: PublicBenchmarkSubmission = validatePublicBenchmark(untrustedBody);
const publication: BenchmarkPublicationRequest = validatePublicationRequest({ benchmark: submission, description_md: notes });
const summary = summarizePublicBenchmarkRows(submission.measurements.rows);
const receipt = validateBenchmarkReceipt(responseBody, submission.submission_id);
```

Publication requests are `{benchmark, description_md}`; legacy bare submissions are accepted with an empty description. Descriptions allow Markdown paragraphs/lists/HTTP(S) links/code blocks only (max 4000 codepoints, no HTML/images/executable URLs/MDX). Whole requests must stay within 4MiB UTF-8 with at most 10000 rows; overlimit input is rejected, never truncated. Recovery codes use `aiolm-recovery-v1.` plus base64url JSON `{version, origin, submission_id, secret}` and reject unknown fields, oversized files, and unexpected origins. Service errors use `{error:{code,message}}` with `verification_required`/`ownership_missing` as recoverable blocks and `submission_deleted` as terminal.

`publicBenchmarkSchema` and `benchmarkReceiptSchema` are also available as immutable JavaScript values. The `@aiolm/benchmark-contracts/schema` and `@aiolm/benchmark-contracts/openapi` exports address the corresponding JSON files for server tooling. Runtime JavaScript imports work in browsers and Node without JSON import attributes.

`summarizeBenchmarkTrials` accepts local trial IDs and failure labels when a collecting client needs to deduplicate progress events. These fields are aggregation inputs only; the public submission schema excludes them. Failed samples and missing measurements never become zero-speed samples, and cache-contaminated samples do not establish speedups.

Run `npm run build` in this directory to produce ESM JavaScript and TypeScript declarations. `npm pack` creates an archive containing only the runtime, declarations, schemas, README and license. `npm test` builds and packs the package, installs the archive into an isolated offline consumer, checks Node and browser-like ESM imports, and compiles a consumer against the packed declarations.

The package is private and has not been published. Its current local namespace does not reserve or identify a GitHub organization or npm owner. It can be extracted into a separate repository or included in a future shared-contract release without copying app sources. Choose the actual organization, registry and publishing policy separately.

The package version tracks implementation releases; `schema_version` and the `/v1/benchmark-runs` route track the public protocol. Incompatible public fields require a new protocol version. Both repositories should pin the same contract release, and the backend must validate incoming data rather than relying on client TypeScript types.

Version 0.3.0 accepts optional `model.metadata` on version 1 submissions. Older records remain valid with this field absent or null. Deploy the accepting service before enabling metadata uploads: older validators intentionally reject fields they do not recognize. Existing frozen publication snapshots must not be rewritten.

Version 0.4.0 adds optional `environment.system_memory_bytes`: the physical RAM capacity reported by the operating system when the measurement starts. It is separate from selected GPU VRAM and `peak_memory_bytes`, which measures the server process. An absent value on older records stays absent; it must never be filled from the viewer's current machine. The website accepts only non-empty, complete runs with no failed measurements. Local history and schema readers retain support for failed or partial records for diagnosis; those records cannot be published as successful runs.

Version 0.5.0 adds optional `execution.effective_args`: the llama-server options the measured run was started with, in order, as separate tokens, so a reader can reproduce the setup instead of inferring it from the curated `execution.settings` fields. The two describe the same launch; `settings` stays the queryable form. As with metadata, deploy the accepting service before enabling uploads, because older validators reject fields they do not recognize. An absent value on older records stays absent and must never be reconstructed from the viewer's machine. Publishing clients remove every option that carries a path, a listening address or a credential — model, projector, draft model and LoRA files, host and port, API keys and tokens — together with its value, and the schema pattern rejects any remaining token that could still hold one. What survives is the tuning configuration: context, batch, cache, offload, threading, sampling and reasoning options plus the client's own extra arguments.

Model metadata separates the declared GGUF name, architecture, size label, weight quantization and quantizer from the public Hugging Face repository, base model repositories and downloaded artifact. The repository namespace identifies the distributor; `quantized_by` identifies a different role and is never substituted for it. A repository-relative artifact requires a matching download origin, and local paths are excluded. A GGUF file type is a weight encoding category, not a promise of identical tensors, quantization recipes or model quality. Use the complete SHA-256 where available to distinguish exact artifacts; multipart identities remain explicitly incomplete. Missing metadata stays unknown, including on older records.

Public origin evidence must match the measured file: an app download receipt or an operator-verified registry artifact with the same SHA-256 and byte size. A filename or local folder alone does not establish a publisher. Such origin evidence describes the model artifact, not independent verification of the benchmark measurement.
