# Source architecture

AioLM separates application composition, feature workflows, shared frontend
infrastructure, and native commands. Keep code next to the feature that owns it;
promote it to `shared` when multiple features need the same contract or behavior.

```text
src/
  main.tsx                  React mount and global styles
  app/                      Bootstrap, app shell, navigation, shell tests
  features/
    chat/                   Conversations, attachments, document retrieval, streaming
    models/                 GGUF library and remembered per-model settings
    model-settings/         Shared model selection and execution settings editor
    discover/               Hugging Face search and download UI
    runtimes/               Runtime installation and device assignment UI
    sessions/               Independent running sessions
    tuning/                 Configuration editors and their controllers
    profiles/               Saved execution profiles
    projects/               Project bindings and persistence
    bench/                  Benchmark UI and result records
    developer/              API, gateway and diagnostic views
    mcp/                    Tool servers and approval policy
    settings/               User preference editor
  shared/
    api/                    Native/HTTP boundary and wire types
    config/                 Defaults, option catalogs, validation, preferences
    state/                  App store, serialized config saves, draft guard, task registry
    storage/                Storage adapter and legacy-data migration
    runtime/                Runtime and session data helpers
    i18n/                   React provider and translation catalogs
    ui/                     Reusable components and initial layout tracking
    hooks/                  Shared React hooks
    lib/                    Display paths, lifecycle, metrics, export helpers
    types/                  Cross-feature navigation contract
  styles/                   Global CSS entrypoints and ordered style layers
  testing/                  Shared fixtures and cross-feature data tests
tests/direct/               Node assertion tests and their sequential runner
scripts/                    Build, packaging and catalog-maintenance tools
src-tauri/src/
  lib.rs                    Public library API, Tauri registration, startup/shutdown
  state.rs                  Native shared state and initial values
  tray.rs                   System-tray icon behind the close-to-tray setting
  commands/                 IPC handlers and command-level coordination
  process_output.rs         Bounded diagnostic buffers and asynchronous pipe draining
  *.rs                      Runtime, server, session and other backend services
```

## Desktop startup and window close

Startup resolves the user's home directory through the operating system and
creates the application-owned model folder there when the configuration still
points at it, so the first scan after an installation lists an empty folder
rather than failing on a path that was never made. Running it again changes
nothing and keeps whatever is already stored. A model folder the user chose
themselves is never created: the picker only offers folders that already exist,
so a missing one means the volume holding it is not attached, and an empty
folder put in its place would hide the models behind it. `list_models` reports
why the application's own folder could not be created.

Closing the main window exits the application and stops every managed
llama-server, the gateway and the background jobs, unless `close_to_tray` is
on. That setting is saved in `config.json`, defaults to off, and is absent from
configurations written before it existed, so an upgrade keeps closing the way it
always has. While it is on, a tray icon is present and closing the main window
hides it instead; the tray menu restores the window or quits, and quitting runs
the same shutdown the window close would have. The window only hides while the
tray icon is actually on screen, so a machine where the tray could not be
created can still close the application.

## Dependency boundaries

- `app` composes features and shared modules. Feature navigation is passed through
  callbacks using `shared/types/navigation.ts`; features do not import the shell.
- `features` own their components, controllers, persistence helpers and tests.
  Use explicit imports when features collaborate; avoid feature-wide barrels that
  accidentally load unrelated screens or create import cycles.
- Production `shared` modules do not import `app`, `features`, or test helpers.
  ESLint checks these boundaries for static imports, including type imports.
- Shared UI owns its input contracts. For example, `TooltipContent` belongs to
  `Tooltip`, while tuning metadata supplies values that implement that contract.
- Use `import type` for contracts. Chat attachment, chunk and citation types live
  in `features/chat/chatTypes.ts` so history and document utilities do not depend
  on each other.

## Frontend API

`shared/api/index.ts` is the public facade for operations and existing mocks.
Consumers that only need wire types import `shared/api/types.ts` directly.
Internal API modules import their dependencies directly, never through the facade.

| Module | Responsibility |
| --- | --- |
| `types.ts` | Native and HTTP request/response contracts |
| `transport.ts` | Native-runtime check, invoke wrapper and native initial-read tracking |
| `http.ts` | UI-independent bounded responses, cancellation, deadlines and typed HTTP failures |
| `commands.ts` | Tauri commands and event subscriptions |
| `models.ts` | HTTP model listing, embeddings and LoRA operations |
| `chat.ts` | Chat request building and streaming operations |
| `sse.ts` | Incremental SSE parsing |
| `endpointAdapters.ts` | Native llama.cpp and Anthropic wire adapters |

The bootstrap migrates storage **before** dynamically importing the application,
preferences and translation catalogs. Preserve that ordering: some modules read
stored values during initialization. `App` also keeps feature screens lazy-loaded.

## Native command layer

`commands/` contains configuration, models, discovery, documents, MCP, server,
sessions, gateway, benchmark and runtime handlers. `files.rs` owns file identity
checks, and `launch.rs` owns launch validation. Backend service modules remain
independent of frontend paths except for the shared tuning-default catalog.

Tauri command names are registered explicitly in `lib.rs`. When moving handlers,
preserve their IPC names and arguments. The crate root re-exports the public
validation functions used by the CLI and integration tests.

## Performance and platform boundaries

- Process diagnostics use `process_output.rs` for head/tail retention. Tail
  buffers discard old bytes without shifting the retained log on each read.
  Readers continue draining a child's pipes after the retention limit is reached;
  output limits must not block the child or discard diagnostics on cancellation.
- Document retrieval splits only the searchable prefix for vector requests and
  shares one ranking between prompt context, source labels and citations. Cache
  lookup hashes each document once per request and indexes its stored offsets.
  Keep these caches request-local so edited attachments are checked again.
- Profile assignment repair indexes named profiles and session bindings once per
  pass. Compatible assignments retain their execution snapshots and revisions;
  legacy recovery remains separate from the normal saved-profile path. Work on a
  detached library so editing a result cannot change a caller's saved settings.
- OS APIs stay behind Rust conditional compilation. Direct Windows bindings are
  target-specific dependencies. Platform-neutral helpers must not infer defaults
  from the development machine or change persisted path identities as part of a
  performance refactor.

CI compiles the native library, binaries, examples and tests on Linux and macOS
in addition to the Windows test gate. These compile checks guard against platform
drift; they do not establish runtime installation, packaging or WebView support.

## Benchmark persistence and sharing

`src-tauri/src/benchmark/` owns native run journals, content identity caches and
launch provenance. The runner persists each completed trial outside its timing
interval before emitting progress. History reads decode one bounded page, hide
active journals and recover completed trials after an interrupted run. Data lives
under the operating system's app data directory; existing browser history is
imported in idempotent batches while preserving its original bytes.

`packages/benchmark-contracts/` owns reusable DTOs, validation, aggregation,
JSON Schema and the service-neutral OpenAPI contract. It builds and packs independently
for use by the future website project. `shared/contracts/benchmark/` contains the
app's conversion adapter and compatibility exports.
Public submissions are assembled field by field and exclude local paths, raw
arguments, diagnostics and device identifiers. Installed GPUs and selected GPUs
are distinct; automatic placement stays unconfirmed. Model hashing is explicit
and cached, with unknown identities retained as unknown.

`shared/sharing/` separates the HTTP client, durable outbox and desktop task
activity adapter. Enqueue commits a reviewed snapshot without sending it. Dispatch
requires an explicitly configured client, uses idempotency keys and transactional
leases, honors a persisted service retry deadline, and pauses while benchmarks
run. The website owns accepted results; the app keeps recovery data and a bounded
cache of newly acknowledged results, while protecting existing and unuploaded data.
IndexedDB queries use bounded cursor pages and indexes for due work. See
[Benchmark sharing](benchmark-sharing.md) for the integration contract and limits.

Visible session consumers share one polling controller. Summary consumers avoid
log snapshots, credentials and full execution settings; detailed consumers select
the full endpoint while active. Model scans have per-request cancellation and a
total directory-entry budget, including files that are not models. The local
gateway reuses its HTTP client and limits connection and idle read time without
imposing a total duration on a progressing stream.

## Tests and maintenance

- Component, hook and utility Vitest tests live beside the code they exercise.
- `tests/direct/run.ts` runs the existing Node assertion tests in order and stops
  at the first failure. `npm test` runs that suite and Vitest coverage.
- `src/testing` contains reusable fixtures and cross-feature persistence tests;
  production code must not import it.
- Rust unit tests stay inside their owning modules. Native integration tests
  remain under `src-tauri/tests`.
- `shared/config/tuningDefaultsCatalog.json` is consumed by TypeScript and Rust.
  `scripts/sync-server-options.mjs` updates the server option catalog beside it.
- Keep relative imports so both Vite and direct Node TypeScript tests resolve the
  same files. Direct Node tests use explicit `.ts` extensions.

Run the validation commands in [Development](../guides/development.md) after structural
changes. Verify lazy-loaded screens in a browser as well as running the build.
