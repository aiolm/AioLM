# Data folder and migration

This page explains where AioLM keeps your data, how to back it up, and what happens when you upgrade, downgrade or move from the previous application. AioLM is installed as a separate application (`com.aiolm.desktop`). Upgrading never deletes the previous application or its original data.

AioLM — All-In-One LM is published at [aiolm/AioLM](https://github.com/aiolm/AioLM). Its website, which also hosts optional [benchmark sharing](benchmark-sharing.md), is [https://aiolm.vercel.app](https://aiolm.vercel.app).

## Data folder

AioLM keeps its data in one folder: `.aiolm` in your home folder (`%USERPROFILE%\.aiolm` on Windows), or the absolute path in the `AIOLM_HOME` environment variable. If `AIOLM_HOME` is a relative path, or your home folder cannot be determined, AioLM stops at startup with an error instead of writing into the current working directory.

| Path | Contents |
| --- | --- |
| `config.json` | Configuration, settings profiles and saved sessions |
| `mcp-servers.json` | MCP servers |
| `models` | Default model folder |
| `runtimes` | Managed runtimes |
| `runtimes/providers` | Python runtime registrations and isolated environments |
| `media` | Imported image, audio and video files referenced by chat history |
| `verification.json`, `verification` | Numerical verification records and overrides, the canary model and its baseline |
| `benchmarks` | Benchmark history, model identities and download receipts |
| `cli` | CLI server state and log |
| `conversations` | Conversations: one folder each, with `thread.json` and its images in `attachments` |
| `downloads` | Transient downloads |

Some data lives outside this folder:

- **Models you added from elsewhere** stay where they are. AioLM records their location and never moves or copies them, including during upgrades.
- **Interface data** such as interface preferences, projects and the document embedding cache is kept in the application's WebView profile (on Windows, `%LOCALAPPDATA%\com.aiolm.desktop\EBWebView`).
- **Credentials**, including endpoint credentials and benchmark owner keys, are kept in your operating system's credential store.

Conversations are kept with the existing limits: the newest 100 conversations, each with its last 100 messages. Message text, reasoning and system prompts are cut at 16 KiB, and an image whose data URL exceeds 512 KiB is not kept. A conversation past the limit is removed from the data folder.

If conversation changes cannot be saved, Chat keeps them in the current session and displays a **Retry saving** action. Check available storage space and permissions, then retry before closing AioLM. The warning clears only after a successful save; changes that have not been saved are not guaranteed to survive a restart.

A conversation whose stored image cannot be read is skipped with a load warning instead of being loaded with an empty image. Its original JSON and attachments remain untouched. Restore the attachment or its read permissions and reopen Chat to recover it. Deleting a single conversation also refuses unreadable or unrecognized data; the explicit **Delete all conversation data** action can still remove it.

**Delete all conversation data** attempts removal from the native conversation folder, every supported browser conversation store and the document index. A failed conversation-store removal is reported as a failure, not success, even if other stores were cleared. Check the reported error and retry; a failed operation can leave a partially cleared workspace.

## Backing up and moving your data

To back up your data, quit AioLM, stop any server started with `aiolm-cli server start`, and copy the whole data folder. The `downloads` folder only holds unfinished downloads and does not need to be kept. To restore, quit AioLM and copy the backup back to the same location.

Saved locations, such as the model folder and models added from elsewhere, are stored as full paths. If you restore the folder to a different location or computer (using `~/.aiolm` there or `AIOLM_HOME`), those paths still point to the original locations; copy external models separately and check the model folder and model locations in AioLM afterwards.

Keep these limits in mind:

- A folder copy does not include credentials from the operating system's credential store. Enter endpoint credentials again after restoring. Benchmark owner keys have their own backup: see [Backup and restore](benchmark-sharing.md#backup-and-restore) for shared benchmark results. Without that backup, a lost owner key cannot be recovered.
- A folder copy does not include the WebView profile described above.
- Do not edit conversation files while AioLM is running; the next save of that conversation can overwrite your changes.

## Upgrading

The current configuration version is 14. Before upgrading an older configuration, AioLM saves its original contents as `config.v<previous-version>-before-v14.json` beside `config.json`, for example `config.v13-before-v14.json`. An existing backup with that name is never replaced.

Upgrades keep your existing settings:

- Existing installations skip first-run setup after an upgrade.
- Settings profiles become shared profiles of their inference engine, keeping their names, values and prompts. Profiles and saved sessions that predate engine selection belong to llama.cpp. Each engine (llama.cpp, vLLM and MLX) receives its own default profile if it has none; an existing llama.cpp default is kept. Older settings that were not saved under a profile name are preserved in a named recovered profile. See [Settings profiles](model-settings.md#settings-profiles) and [Existing data and resources](model-settings.md#existing-data-and-resources) for how profiles behave after the upgrade.
- Saved sessions keep their own execution settings and profile assignments.
- Conversations that earlier releases kept in browser storage move into the `conversations` folder the first time the chat opens. A conversation already in the data folder is never overwritten, and the browser copies are removed only after every conversation has been found in the data folder. If the move is interrupted, it is tried again at the next start.
- Benchmark results from earlier versions are imported the first time benchmark history opens; see [Local history](benchmark-sharing.md#local-history).

### 0.3.5 benchmark records

New measurements use one `openai-chat-serving@1` workload for every connected
streaming text-chat engine. They write local journal schema2 and publish
schema3 with exact UTF-8 input bytes/hashes, client-observed text/reasoning
timings and nullable reported token/cache counts. Engine launch settings are
preserved; the workload no longer forces context, parallel capacity or cold
caches. Optional usage and warmup are explicit conditions.

Existing local schema1 journals and frozen schema1/2 publication bytes remain
unchanged, including IDs, hashes and receipts. Their original token/PP/TG/TTFT/
TPOT units stay in Legacy views/columns; they are not converted to byte results.
Profile imports now choose and confirm a checked destination schema and retain
existing user-edited imports for the same source/destination. No model paths,
GPU IDs, installations or connections are restored from public settings.

Back up before downgrading: older releases may not understand local schema2
journals or newly declared adapter metadata. Do not rewrite journals or frozen
publication requests to make an older release accept them.

Journal replay preserves recorded floating-point timings exactly across restarts.

## Going back to an older release

An older AioLM release refuses to open a configuration written by a newer one instead of overwriting it. To go back:

1. Quit AioLM.
2. Restore the matching `config.v<version>-before-v14.json` backup as `config.json` yourself.
3. Start the older release.

Settings made after the upgrade are not in that backup. On Windows, releases from before the data folder keep reading their earlier locations (below): they show the configuration as it was when the data folder was prepared, need their runtimes installed again and do not see conversations moved into the data folder.

## Upgrading on Windows from earlier installations

On Windows, AioLM brings older data into place at startup in two steps: first from the previous application, then from earlier AioLM releases. In both steps your original data is left in place, and existing AioLM data always takes priority as a whole: it is never merged with or replaced by older data.

### From the previous application

On first launch, AioLM copies these folders when their AioLM counterparts do not exist yet:

| Previous location | AioLM location | Contents |
| --- | --- | --- |
| `%APPDATA%\llama-board` | `%APPDATA%\aiolm` | Configuration and managed runtimes |
| `%LOCALAPPDATA%\llama-board` | `%LOCALAPPDATA%\aiolm` | CLI storage |
| `%LOCALAPPDATA%\com.llamaboard.desktop\EBWebView` | `%LOCALAPPDATA%\com.aiolm.desktop\EBWebView` | Interface preferences, projects, conversations and other browser storage |

Paths to the copied runtimes and data are updated to the new locations; external model and document paths remain unchanged. Running-process state, transient downloads and caches are not copied, so a runtime whose download had not finished in the previous application may need to be installed again. MCP servers from the previous application are brought into the data folder in the next step, unless AioLM already has its own.

If copying fails, AioLM stops at a retry screen before applying default settings, starting servers or cleaning up runtimes. Close the previous application, make sure no other program is locking its profile, free disk space or repair a damaged configuration file, then retry. A retry starts the incomplete copy again without touching the original. Do not uninstall AioLM or retry migration as a way to delete the old data; remove the previous application's data yourself once you no longer need it.

### From earlier AioLM releases

Earlier AioLM releases kept their data in `%APPDATA%\aiolm`, `%APPDATA%\com.aiolm.desktop` and `%LOCALAPPDATA%\aiolm`. At startup, AioLM brings it into the data folder:

| Earlier location | Data folder | Transfer |
| --- | --- | --- |
| `%APPDATA%\aiolm\config.json` | `config.json` | Copied |
| `%APPDATA%\com.aiolm.desktop\mcp-servers.json` | `mcp-servers.json` | Copied; the previous application's file is used when AioLM has none |
| `%APPDATA%\aiolm\verification.json` and `verification` | Same names | Copied |
| `%APPDATA%\com.aiolm.desktop\benchmarks` | `benchmarks` | Copied |
| `%APPDATA%\aiolm\runtimes` | `runtimes` | Moved |

Copies leave their originals in place. Runtimes can take gigabytes, so they are moved instead, keeping each file's modification time so existing verification records still apply. When the data folder is on another drive, runtimes are copied and the original folder is removed afterwards. A server running from the earlier runtime folder blocks the move: stop it, including one started with `aiolm-cli server start`, and restart AioLM to retry. Models are never moved, not even a model folder inside `%APPDATA%\aiolm`; the configuration keeps pointing at it.

Transient downloads and CLI process state are not carried over. `aiolm-cli` still finds, reports and stops a server started before the upgrade; its log is shown again once the server is restarted.

## Earlier names

Names from the previous application remain accepted so that upgrading does not strand earlier installations or data:

- Environment variables use the `AIOLM_` prefix. The previous `LLAMA_BOARD_` names are still accepted; when both are set, the `AIOLM_` name wins.
- Project exports use `aiolm.project.v1`, and runtime manifests are named `aiolm-runtime*.json`. Project files and `llama-board-runtime*.json` manifests from the previous application remain readable.
- Windows installers include `aiolm.exe` and `aiolm-cli.exe`.
