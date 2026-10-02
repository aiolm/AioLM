# Chat personalization

The desktop app reads global instructions from `~/.agents/AGENTS.md` and then
`~/.aiolm/AGENTS.md` for each new chat turn. The AioLM-specific file takes
precedence over conflicting shared guidance; the conversation or project's
existing system prompt remains the more specific context. When `AIOLM_HOME` is
set, its directory replaces `~/.aiolm`, following the app's existing home policy.
The shared `.agents` directory stays under the operating system's user home.

Missing files are normal. Reading instructions does not create directories or
files. An unreadable, invalid or oversized file is reported rather than treated
as successfully loaded. A turn captures its instructions so a retry or tool
follow-up continues with the same guidance; saved changes apply to the next new
turn. Instructions that exceed the configured chat context need to be reduced
or the context increased before sending.

## Editing instructions

Open **Settings → Personalization**, choose the shared or AioLM instructions
file, and edit its text. Each file keeps its own draft while switching between
them. **Save** writes only the selected file, creating a missing file on explicit
save. **Reload** reads its current contents and asks before discarding a draft.
If another program changes the file after it was loaded, saving fails and keeps
the draft so the external edit is not overwritten.

Instruction files are separate from the preference backup and reset controls.
The browser preview cannot edit the computer's files; use the desktop app.

## Skills

Place each skill in its own directory with a `SKILL.md` entry point under
`~/.agents/skills/` or `~/.aiolm/skills/`. The entry point must define a `name` and
`description` in its frontmatter:

```markdown
---
name: concise-summary
description: Summarize a passage in a few clear sentences.
---
Identify the main idea and the details needed to understand it.
```

When both roots contain the same skill name, the AioLM-specific skill is used.
Discovery reads the catalog's names and descriptions first. Chat can request the
full entry point through the read-only `aiolm_read_skill` tool when it needs a
skill. For manual invocation, choose a skill in the composer or include
`$concise-summary` in a message. Selecting a skill and naming it in the same
message includes its instructions once. Refresh the skill list after adding or
changing files outside the app.

Skills provide instructions to the model. Loading a skill does not execute its
scripts or add unrestricted file or shell tools. Existing MCP tools keep their
approval flow. Skill reads accept only discovered identifiers, and file access
stays within the configured skill entry points. Individual instruction and skill
files are limited to 64 KiB; the effective catalog is limited to 128 skills.
Skipped entries are reported.

AGENTS.md and loaded skill text become part of the request to the selected chat
endpoint. They are not copied into the conversation's stored system prompt or
preference exports. Tests use synthetic files in temporary directories; the
development machine's personal instructions and skills are never fixtures or
distribution assets.
