# Data migration and compatibility

AioLM is installed as a separate application (`com.aiolm.desktop`). The old application and its original data are retained.

## Project identity

The canonical repository is [aiolm/AioLM](https://github.com/aiolm/AioLM). App branding uses **AioLM — All-In-One LM**; package names, command names and new data directories use `aiolm`. Installation, source and runtime-artifact links use the canonical repository.

The website repository is [aiolm/AioLm-Web](https://github.com/aiolm/AioLm-Web), and the public site is [https://aiolm.vercel.app](https://aiolm.vercel.app).

Benchmark publishing uses the native build-time `AIOLM_BENCHMARK_API_URL` setting. Set the app repository Actions variable to `https://aiolm.vercel.app` before the next approved release build; the release workflow passes it to native compilation. Local native builds use the same environment variable at compile time. An absent or blank value keeps publishing disabled, and existing binaries retain the origin compiled into them.

Existing checkouts can update their remote with `git remote set-url origin https://github.com/aiolm/AioLM.git`. A checkout's local directory name is independent of the remote; new clones can use `git clone https://github.com/aiolm/AioLM.git AioLM`.

Previous product names below are compatibility identifiers used to discover and import existing data, environment variables and exports. They are deliberately retained so upgrading does not strand earlier installations or user data.

## First launch on Windows

Before Tauri creates a WebView, AioLM copies these roots when their destinations do not exist:

| Previous root | AioLM root | Contents |
| --- | --- | --- |
| `%APPDATA%\llama-board` | `%APPDATA%\aiolm` | Configuration, managed runtimes and MCP settings |
| `%LOCALAPPDATA%\llama-board` | `%LOCALAPPDATA%\aiolm` | CLI storage; live process state is excluded |
| `%LOCALAPPDATA%\com.llamaboard.desktop\EBWebView` | `%LOCALAPPDATA%\com.aiolm.desktop\EBWebView` | WebView profile, including localStorage and IndexedDB |

Owned paths inside configuration and runtime manifests are updated to their copied destinations. External model and document paths remain unchanged. Running-process state, PID/lock files, transient downloads and cache directories are excluded. A copied runtime can therefore be installed again if an interrupted download had not completed in the previous application.

Each root is copied into a sibling staging directory and committed by rename only after the copy and JSON validation succeed. Destination existence is the native completion record. An OS lock serializes concurrent imports and is released on process termination. A retry rebuilds incomplete staging; it never edits the original root. Existing destination roots are left intact and never merged or overwritten automatically.

The copied browser profile is migrated before application modules read settings or initialize stores. The `llama-board-storage`, `llama-board-chat` and `llama-board-document-index` databases and prefixed localStorage entries are copied to `aiolm` names, preserving structured values and binary attachments. The `aiolm.migration.v1` journal records `copying`, `complete` or `existing`. Web Locks serialize concurrent windows; incomplete copies can retry. Existing AioLM browser data takes priority as a whole, without merging older preferences or conversations.

If copying fails, the application stops at a retry screen/dialog before default settings, automatic server startup or runtime cleanup can run. Close the previous application, release a locked profile, free disk space or repair invalid JSON, then retry. Neither uninstalling AioLM nor retrying migration should be used to delete the old data.

## Compatibility

- New environment variables use `AIOLM_`. Existing `LLAMA_BOARD_` inputs remain accepted; the new name wins when both are present. This includes the CUDA override, CLI smoke inputs, PR artifact repository override and installation-script options.
- New exports use `aiolm.project.v1` and `aiolm-runtime*.json`. Existing project JSON and `llama-board-runtime*.json` manifests remain readable. Previously published PR artifact names remain accepted with the same digest and provenance checks.
- Existing IPC command names remain available. New commands support launch validation and session-scoped request settings.
- Runtime and desktop package names are `aiolm`; the Rust library is `aiolm_lib`. Installers include `aiolm.exe` and `aiolm-cli.exe`.

## Model execution workspace

The model page manages the model library. Runtime selection, profiles, GPU placement and tuning are available in a shared settings dialog from the header, chat, sessions, benchmark and project editor. Existing tuning, profile and LoRA shortcuts open the corresponding dialog section. Runtime installation and independent sessions retain their own pages.

The localStorage entry `aiolm-model-execution` uses version 1 and stores the last saved execution configuration by normalized model path. It includes runtime/build, GPU placement, tuning defaults and overrides, projector and LoRA settings. App preferences, ports, authentication fields and independent session definitions are excluded; raw server arguments use the existing profile credential filter. Both Global and Model profiles save all editable execution options. Imported profiles retain their original field coverage until explicitly saved; changing their default designation preserves that coverage.

At configuration load, `aiolm-model-profiles` versions 2–4 and `aiolm.loading-profiles.v1` are imported into the optional native `settings_profiles` library (library version 1). Every stored server, generation and loading entry is retained as an individual profile with stable import IDs and its original field coverage. The original localStorage records are left intact. The import marker and library are committed in the same atomic native write; invalid input or a failed write leaves the originals available for retry. Existing configuration, per-model records and session execution values take priority over old selected-profile values.

Model copies of Global profiles and previously saved presets may include `source_id` and `source_scope` (`preset` or `global`). These optional fields preserve the source shown in the profile workspace; they do not make target settings depend on a live template lookup. Both fields are validated together on model-scoped profiles. Existing version 1 libraries without them remain readable, with their entries and application snapshots preserved.

New installations create one global `profile-default` entry with a localized Default display name, runtime-default markers and an empty prompt. It covers every tuning field, including the model-scoped ones (`ngl`, `n_cpu_moe` and the speculative decoding fields), so a new installation inherits the runtime default for each of them rather than a captured value. GPU layers and context size keep their documented app defaults on launch; see [Server options](server-options.md). Runtime identity, projector, draft model, device, GPU placement, LoRA adapters and extra server arguments stay outside its coverage and are not reset when it is applied. The library stores its designation in `default_profile_id`, independently of its name. The initial empty workspace is assigned to that profile. No additional presets are generated. Loading an absent or empty library creates this entry while preserving its revision and import status. Existing libraries without a valid designation select their original Default entry, a Global profile, or their first entry. A model-scoped default is made global without changing its ID or saved values. Every model and session application is assigned to a valid profile. Older anonymous applications reuse a matching profile or receive a deterministic recovered profile containing their saved settings and prompt. Missing fields use product defaults; explicitly saved values remain manual. This repair also runs for libraries whose legacy import is already complete.

Opening a model's editor restores its copied native application snapshot, falling back to its local model record. Explicit selection and the next launch use its assigned profile's latest saved values. A model without saved settings uses the designated default's values and prompt. This includes model-specific fields such as projectors, draft models and LoRA adapters when the designated profile owns them. Applying a project explicitly overrides the model record with the project configuration. A project with no saved profile identity preserves its snapshot through recovery. An explicit reference to a deleted profile uses the designated default's settings and prompt when opened in the settings editor or applied. Missing runtime builds are shown for installation or reselection; they are never silently replaced.

## Session execution settings

Configuration version 11 adds optional `execution` and `model_profile_id` fields to saved sessions. Sessions without execution overrides retain their previous inheritance behavior. Editing a session stores only that session's execution options; model paths and GPU placement remain in their existing fields. Application preferences, ports and other session definitions are excluded from the overrides.

Older files may omit the settings-profile library; loading initializes it without requiring another configuration-version change. New session saves use named profile applications with copied values and prompts. A monotonic library revision is checked under the native configuration write lock to reject stale replacement or removal. Saves reject missing or invalid profile references. Only the designated default profile is protected from deletion. Deleting any other profile replaces affected model and session assignments, settings and prompts with the designated default in the same write. Valid application snapshots from older revisions remain unchanged until explicitly updated or their assigned profile is deleted.

Running-session status includes an allowlisted execution snapshot captured at launch. Saving a different model, projector or server configuration for the next launch does not replace that snapshot. Request-only changes can be applied to the current session separately. Profile chips only open a preview. Explicit profile actions save immediately, while option edits remain unsaved changes within the selected named profile. Setting a default profile saves the designation and preserves the editor's unsaved option values, prompt and validation state. Applying execution edits saves that profile and its target snapshot atomically. Cancelling the dialog preserves completed profile actions. Revert reads the target's saved settings and copied prompt rather than reconstructing them from the current reusable profile.
