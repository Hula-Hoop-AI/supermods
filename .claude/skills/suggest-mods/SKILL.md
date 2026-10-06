---
name: suggest-mods
description: Use when the user asks what mods to build or install next, wants mod ideas from their own Claude Code history, or asks what mods people are talking about online — before scaffolding anything with create-mod.
---

# Suggest mods from past conversations

## Overview

Past sessions show where the user repeats themselves, waits, gets blocked or loses track. Each
such pattern is a candidate mod. This skill turns the evidence into a short ranked list, each
item with proof, then hands the chosen one to `create-mod`.

**The transcripts contain secrets and private content. Never read raw `.jsonl` files into
context and never paste tool output from them. Only the digest script's counts and prompt
snippets leave the disk.**

## Workflow

### 1. Digest the history (one command, ~2 s)

```bash
python3 .claude/skills/suggest-mods/scripts/digest.py --days 30
```

`--project <substring>` narrows to one project, `--days 0` scans everything, `--prompts N` sets how
many recent prompts are listed verbatim (default 40), `--json` for raw counts. `--help` lists all.

The report has: sessions and prompts per project, tool and shell-verb counts, MCP servers,
slash commands and skills, friction (user rejections, interrupts, policy blocks), tool errors
with the most repeated error lines, prompt themes, prompts by hour, session titles, recent prompts.

### 2. Read the signals

| Signal in the digest | What it suggests |
|---|---|
| A shell verb or MCP tool called hundreds of times (`gh`, `gt`, `docker`, `psql`, a connector) | A pane or hint line that shows that system's state without a tool call |
| The same error line repeated | A hook that catches or rewrites the call, or a toast that explains it |
| Many "rejected by user" or "blocked by policy" on one tool | A confirm gate or a safer rewrite for that tool; or a band that shows the risky context (prod, branch, profile) |
| Prompts that repeat an instruction ("don't…", "always…", "check X first") | A hook that enforces it, not a mod the user must remember to open |
| Prompts that paste a link or ID (PR, issue, alert, URL) | A pane that lists those and inserts them into the prompt on press |
| Many `/compact`, interrupts, long sessions | Context, cost or progress surfaces in the band or status line |
| Prompts asking "where are we", "what did you do", "status" | A pane or band with live progress |
| Work at odd hours, long gaps | Focus, timer, reminder, or hand-off surfaces |

List every candidate, with the digest rows that back it.

### 3. Check what already exists

- `.claude-plugin/marketplace.json` and `plugins/*/README.md`: if a mod overlaps, propose a
  provider, tab or option on it (`observe/hooks/providers/`, `trace/hooks/recorders/`), not a
  new mod.
- `references/landscape.md` in this skill: mods other people have published, what they ask
  for, and the pains they mention, each with a URL. Check its "Last refreshed" date. If it is
  missing or older than a month, refresh it before suggesting: run at most four `WebSearch`
  calls ("Claude Code mods", "claude code mod pane band status line", "awesome-claude-code-mods",
  "site:reddit.com Claude Code mods"), fetch the two or three richest pages, and rewrite the
  file in the same sections with today's date. Searches that return nothing are normal; note
  them in the file rather than retrying.
- The official docs, read by `.md` URL: `events` for the event list and `reference` for the
  `$` capabilities, at `https://code.claude.com/docs/en/plugins/mods/<page>.md`. A candidate
  that needs an event or capability that does not exist is a "later" item, not a suggestion.

### 4. Decide whether it is a mod at all

A mod earns its place when it needs live UI (pane, band, status line, hint line, toast) or a
hook that runs on every event. If a CLAUDE.md line, a skill, a settings.json hook or an
allowlist entry solves it, say so instead and do not list it as a mod.

### 5. Present 3–5 suggestions, ranked

Use this shape for each:

```
### <name> (new | extends <existing mod>)  — category: session | observability | git | work | fun
One sentence: what it shows or changes, and the surface it uses.
Evidence: <digest rows, with counts> · <prompt snippets, at most two>
Elsewhere: <existing mods or discussions it resembles, with URL> | none found
Events and capabilities: <from the docs>
```

Rank by (friction count × how often the user hits it) and say in one line why #1 is first.
State the window and scope you used ("30 days, all projects, N sessions").
End with: "Pick one and I'll scaffold it with create-mod." Do not scaffold without that pick.

### 6. Hand off

When the user picks one, invoke `create-mod` with the suggestion text as its brief.

## Common mistakes

| Mistake | Instead |
|---|---|
| Ad-hoc `jq`, `grep` or Python over `~/.claude/projects` | Run `digest.py`; extend it if a signal is missing |
| Counting only one project or only the last few sessions | Default is 30 days across all projects; say which window you used |
| Suggesting a near-duplicate of `ci`, `issues`, `observe`, `trace`, `worktrees` | Propose a provider or tab on the existing mod |
| Suggesting what a CLAUDE.md line or settings hook already solves | Say that in one line; it is not a mod |
| Suggestions without counts | Every suggestion carries its digest rows |
| Quoting a tool result or error body from a transcript | Only the digest's one-line error summaries (secrets redacted; paths are not) |
| Skipping the online check | `references/landscape.md`, refreshed when stale |
| Scaffolding right away | Stop after the list; the user picks |
