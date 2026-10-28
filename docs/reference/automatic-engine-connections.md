# Automatic external engine connections

This connection flow is available starting with v0.3.3. Published v0.3.2 assets
remain unchanged. It uses execution evidence and a common protocol rather than an engine
catalog, package name or implementation language.

## User flow

1. Open **Inference engines → Add inference engine → Find automatically**.
2. Select a discovered installation and a model. If nothing is found, choose the
   installation folder, not an individual executable or JSON file.
3. Choose **Connect**. Only a successful model response and SSE check publishes
   an internal registration. Existing execution selections and profiles remain
   unchanged; choose the registered engine and model in an execution profile.

No `.engine.json`, `.setup.json` or user-written probe is required by this flow.
Advanced registration still accepts explicit provider/developer contracts.

## Common boundary

- Discovery reads current-user process/listener evidence and bounded installation
  metadata. It does not execute every binary, import modules or read process
  environments. Process creation identity and listener ownership are checked
  again before connecting.
- A running local server must actually answer an OpenAI v1 model-list request.
  A selected model must then pass JSON chat and complete SSE response checks.
  Only text generation and chat streaming are established. Model routing is
  checked; this is not cryptographic proof of the server's loaded weight bytes.
- A running server is attached through an app-owned loopback proxy. Stopping an
  AioLM connection stops the proxy and its requests, leaving the original server
  and container alone.
- A stopped installation needs a discoverable native entry point or an explicit
  interpreter declaration and unambiguous documented launch bindings. A trial
  launch must establish the selected model routing and private listener ownership.
  The same shell-free process contract applies to all implementation languages.
- The app hashes the captured executable, scripts and connection metadata.
  Updating AioLM can revalidate its own helper through the current app/CLI;
  changed external files still require explicit registration again.

Unknown module/subcommand roles, proprietary protocols, credentials that need
configuration, ambiguous model IDs, and unmanaged container creation remain
unverified. An existing container server may connect through the same local
protocol as any other server. No engine-specific automatic flags, package
installation or privileged container lifecycle is supplied.

## Validation scope

Synthetic tests exercise discovery, changed process/file identity, bounded help,
literal argument handling, model checks, JSON/SSE parsing, cancellation and
proxy ownership. Protocol checks against three existing Linux CPU installations
are separate evidence from packaged-app installation, GUI inference, hardware
acceptance and the full automatic journey.

The original Linux validation scope is unchanged. SmolVLM media-quality failure
F09, the full Linux acceptance work, and actual v0.3.1-to-v0.3.2 update installation
and UI checks remain open as recorded in
[the resume document](linux-validation-resume.ko.md) and
[the device results](linux-device-validation-results.ko.md).
