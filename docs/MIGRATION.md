# AioLM — All-In-One LM

AioLM 0.1.6 is installed as a separate application (`com.aiolm.desktop`). The old application and its original data are retained. The working folder, GitHub repository and SignPath service are not renamed by this change.

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
- IPC command names and feature data schemas are preserved. Only the bootstrap command `migration_paths` was added.
- Runtime and desktop package names are `aiolm`; the Rust library is `aiolm_lib`. Installers include `aiolm.exe` and `aiolm-cli.exe`.

## UI

All fifteen views use one labeled navigation. The desktop sidebar is 224 px; below 960 px, navigation opens in a modal drawer. Views stay mounted after their first visit so drafts, selections and running operations survive navigation. Sidebar, header and panel shortcuts share the same task-leave guard.

Theme, density, reduced motion and four languages are retained. Pretendard Variable is bundled locally under the SIL Open Font License (`public/fonts/OFL.txt`). UI tokens are defined in `src/styles/app-tokens.css`; shared components and responsive rules replace the previous global palette and shell.

See [verification results](AIOLM_VERIFICATION.md) for automated checks, rendered checks and remaining native-installation limits.
