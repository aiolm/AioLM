# Data migration and compatibility

AioLM is installed as a separate application (`com.aiolm.desktop`). The old application and its original data are retained.

## Project identity

The canonical repository is [joowon-jang/AioLM](https://github.com/joowon-jang/AioLM). App branding uses **AioLM — All-In-One LM**; package names, command names and new data directories use `aiolm`. Installation, source and runtime-artifact links use the canonical repository.

Existing checkouts can update their remote with `git remote set-url origin https://github.com/joowon-jang/AioLM.git`. A checkout's local directory name is independent of the remote; new clones can use `git clone https://github.com/joowon-jang/AioLM.git AioLM`.

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

The localStorage entry `aiolm-model-execution` uses version 1 and stores the last saved execution configuration by normalized model path. It includes runtime/build, GPU placement, tuning defaults and overrides, projector and LoRA settings. App preferences, ports, authentication fields and independent session definitions are excluded; raw server arguments use the existing profile credential filter. Shared presets remain separate snapshots and are not modified by ordinary model edits.

Existing `aiolm-model-profiles` versions 2–4 remain readable. The version 4 record now retains an optional `activeModelIds` map alongside the existing per-model server selection. Older records without that map inherit the current shared sampling selection on first use. Profile definitions and IDs are preserved, including the existing legacy duplicate-name migration.

Returning to a model restores its saved configuration. A model without a record uses the existing profile defaults. Applying a project explicitly overrides the model record with the project configuration. Missing runtime builds are shown for installation or reselection; they are never silently replaced.

## Session execution settings

Configuration version 11 adds optional `execution` and `model_profile_id` fields to saved sessions. Sessions without execution overrides retain their previous inheritance behavior. Editing a session stores only that session's execution options; model paths and GPU placement remain in their existing fields. Application preferences, ports and other session definitions are excluded from the overrides.

Running-session status includes an allowlisted execution snapshot captured at launch. Saving a different model, projector or server configuration for the next launch does not replace that snapshot. Request-only changes can be applied to the current session separately. Settings dialogs keep unapplied changes in memory; opening or cancelling them does not migrate or rewrite profile selections.
