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
    model-settings/         Shared model picker, draft editor and target-scoped apply
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
  commands/                 IPC handlers and command-level coordination
  *.rs                      Runtime, server, session and other backend services
```

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
| `transport.ts` | Native-runtime check, invoke wrapper, initial-read tracking, bounded responses |
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
