# Project and data ownership

Related projects can live in separate repositories under one GitHub organization.
Each repository owns its release process and runtime responsibilities. Organization
membership does not make repository files or package versions automatically shared.
Use an explicit versioned dependency for the benchmark contract.

| Project | Responsibilities |
| --- | --- |
| Desktop app | Model execution, measurement, environment capture, public review, anonymous publish client, owner recovery data and recent acknowledged cache |
| Website | Web UI, anonymous owner-proof benchmark API, database schema/migrations, result validation, queries, moderation and deletion |
| Benchmark contracts | Public request/response schemas, wire types, validation and deterministic comparison utilities |

The website may keep its UI and API in one repository. Its backend is the authority
for accepted results and owns the database connection. The desktop app receives
only a configured service origin; the native runner keeps the owner key and
attaches owner proof plus a browser-verified upload permit per attempt. A server
receipt is stored before the app treats the local result as an acknowledged copy.
Local removal never issues a website deletion request.

## Sharing contracts between repositories

The contract currently lives in `packages/benchmark-contracts` as an independent
workspace package. `@aiolm/benchmark-contracts` is its local package identifier;
it does not assert ownership of a GitHub organization or registry scope. The
package is private until a publication destination and access policy are chosen.
No organization, remote repository, release or registry publication is created by
the app build.

The package builds JavaScript and TypeScript declarations and includes JSON
Schema, OpenAPI and its license. It does not import desktop source files or depend
on a particular web framework, database or operating system. A packed archive can
be consumed by a separate website repository today. When the organization is
ready, the same package directory can move to a dedicated contracts repository
without moving measurement code or server code with it.

```text
GitHub organization
├── desktop-app          App and its native measurement engine
├── website              Web UI, API service and database migrations
└── benchmark-contracts  Optional independent package repository
```

The names above describe roles, not required repository names. A third repository
is optional: the package can remain in one owner repository while consumers use
versioned release artifacts. Do not copy schemas into both app and website
repositories and then edit them independently.

## Contract changes and releases

Package versions and the payload's `schema_version` serve different purposes.
Package versions identify the library artifact; wire versions identify accepted
payload structures and semantics. A breaking wire change needs a new wire version
and a server rollout that still accepts supported older app versions. Release the
server's compatible reader before distributing an app that sends a new format.

The app keeps the local-record-to-public conversion because local paths, runtime
arguments and diagnostics are private app details. The shared package defines the
public allowlist and validation used by both callers and the website API. Database
entities remain in the website project and can evolve independently of native
journals, IndexedDB entries and UI state.

Run `npm run build:contracts` to build the package and `npm run test:contracts` to
verify a packed, independently installed consumer. App development, typechecking,
tests and production builds prepare the workspace dependency automatically. After
editing contract source during a running dev server, rebuild the contract package
so the app consumes the updated generated modules.
