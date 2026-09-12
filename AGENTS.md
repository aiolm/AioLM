# Repository Instructions

These instructions apply throughout the repository. If `tmp/AGENTS.local.md` exists, also read and follow its local instructions.

## Implementation and Documentation

- Stay within the requested scope and preserve existing changes and user data.
- Write comments, test names, project documentation, and commit messages around this project's behavior, design decisions, resolved problems, and validation results.
- Keep API, protocol, and dependency information accurate, and preserve required license, copyright, and legal notices.
- Consult `package.json` and `src-tauri/Cargo.toml` for verification commands and run the checks appropriate to the change.

## Defaults and Personal Data

- Do not copy or hardcode personal environment paths, account or device identifiers, credentials, or personal data into source code, committed artifacts, or distribution packages. This does not prohibit the app's normal reading and saving of user settings and data at runtime.
- Define defaults and initialization, recovery, and migration fallback values according to product policy. Where no policy exists, follow existing behavior and repository conventions. Do not use the development machine's current settings or files as defaults. Resolve user-specific paths at runtime through standard operating system directory APIs, user settings, or explicit user selection.
- Use synthetic data and temporary directories for tests and examples. Run integration checks against real environments explicitly, and do not copy personal settings, records, credentials, or results from those runs into test data or distribution files.
- Validate changes to defaults and initialization without existing user settings or files from the development machine, using temporary directories where appropriate. Before committing or distributing, also check included configuration, examples, and generated files for personal environment values.

## Commits

- Include only the requested implementation code, tests, configuration, and documentation needed to use or develop the project.
- Keep documents that should not be committed, local working notes, and temporary materials in the repository-root `tmp/` directory. Exclude `tmp/` and build artifacts from commits.
- Do not force-stage files under `tmp/` or delete original user materials merely to exclude them from a commit. You may clean up unnecessary temporary files you created during the current task.
- Do not unilaterally rewrite existing commit history.
- Inspect changes with `git status --short` and stage only the required paths.
- Before committing, review the file list with `git diff --cached --name-only` and the actual changes with `git diff --cached`.
- Check for whitespace errors with `git diff --cached --check`.
- After committing, check `git status --short` and accurately report the completed commit and any remaining work.
