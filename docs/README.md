# AioLM documentation

Guides, technical reference, and policies for the current AioLM implementation.

## Guides

| Topic | English | 한국어 | 日本語 | 中文 |
| --- | --- | --- | --- | --- |
| Project overview | [English](../README.md) | [한국어](guides/overview.ko.md) | [日本語](guides/overview.ja.md) | [中文](guides/overview.zh.md) |
| Installation | [English](guides/install.md) | [한국어](guides/install.ko.md) | [日本語](guides/install.ja.md) | [中文](guides/install.zh.md) |
| Command-line interface | [English](guides/cli.md) | [한국어](guides/cli.ko.md) | [日本語](guides/cli.ja.md) | [中文](guides/cli.zh.md) |
| Development | [English](guides/development.md) | [한국어](guides/development.ko.md) | [日本語](guides/development.ja.md) | [中文](guides/development.zh.md) |

## Technical reference

- [Source architecture](reference/architecture.md): folder layout, module responsibilities, and dependency rules.
- [Server options](reference/server-options.md): tuning controls and runtime option behavior.
- [Data migration](reference/migration.md): storage migration and compatibility.

## Repository policies

- Security: [English](SECURITY.md) · [한국어](policies/security.ko.md) · [日本語](policies/security.ja.md) · [中文](policies/security.zh.md).
- [Privacy policy](policies/privacy.md).
- [License](../LICENSE) and [third-party notices](../NOTICE).

## Adding documentation

```text
README.md                 Repository introduction (English)
LICENSE, NOTICE           Repository license and third-party notices
docs/
  README.md               Documentation index
  SECURITY.md             Canonical security policy
  guides/                 Installation, CLI, development, translated overviews
  reference/              Architecture, server options, migration behavior
  policies/               Privacy and security translations
```

Keep each topic in one document per language. The `.ko.md`, `.ja.md`, and `.zh.md`
files are translations, not separate versions of the same guide. Update relevant
translations when changing shared instructions. Overviews link to detailed guides
instead of repeating installation commands and migration procedures.

Document current behavior and reproducible validation commands. Remove superseded
plans, one-off verification logs, and obsolete audit findings instead of keeping
them alongside active guides.

Only the repository introduction and repository-wide license/notices stay at the
root. Bundled asset licenses stay with their assets. Local tool metadata and build
outputs are not project documentation. Keep the canonical security policy at
`docs/SECURITY.md` for [GitHub discovery](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file).

Add new documents to this index and use relative links. When moving a document,
update incoming links, release URLs, and CODEOWNERS paths in the same change.
