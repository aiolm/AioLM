# Chat personalization

In **Settings → Personalization → Instruction files to apply**, select the shared
`~/.agents/AGENTS.md`, the AioLM-specific `~/.aiolm/AGENTS.md`, both, or neither.
The choices are saved automatically and apply to the next new chat turn. Both
start enabled on a new installation and when upgrading settings without these
choices, preserving the previous behavior.

Only selected instruction files are read for a new turn. When both are enabled,
the shared file is applied first and the AioLM-specific file takes precedence
over conflicting shared guidance. The conversation or project's existing system
prompt remains the more specific context. When `AIOLM_HOME` is set, its directory
replaces `~/.aiolm`, following the app's existing home policy. The shared `.agents`
directory stays under the operating system's user home.

Missing files are normal. Reading instructions does not create directories or
files. An unreadable, invalid or oversized selected file is reported rather than
treated as successfully loaded; a disabled instruction file is not read or checked.
A turn captures its instructions so a retry or tool follow-up continues with the
same guidance even after the selection changes. Instructions that exceed the
configured chat context need to be reduced or the context increased before sending.

## Editing instructions

Under **File to edit**, choose the shared or AioLM instructions file and edit its
text. This editing selection is independent of which files apply to chat. Each
file keeps its own draft while switching between them or changing application
choices. **Save** writes only the editor's selected file, creating a missing file
on explicit save. **Reload** reads its current contents and asks before discarding
a draft. If another program changes the file after it was loaded, saving fails
and keeps the draft so the external edit is not overwritten.

The source application choices are included in preference backups. Resetting all
app preferences enables both sources again. Neither backup nor reset changes the
instruction files themselves. The browser preview can change application choices
but cannot edit the computer's files; use the desktop app for file editing.

## Skills

Instruction-file application choices do not control skills. Even with both
AGENTS.md files disabled, skills are still discovered under both roots.

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
preference exports.
