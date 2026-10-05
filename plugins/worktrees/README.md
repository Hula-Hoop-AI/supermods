# worktrees

Shows the current worktree as `repo@branch`, and the ports it is listening on, in the dim hint
line under the prompt, and adds a `/worktrees` pane that lists every worktree of the repository
and clears the finished ones.

```
? for shortcuts · supermods@modal-logs-metrics · :3000 :5173
```

## Install

```
/plugin marketplace add Hula-Hoop-AI/supermods
/plugin install worktrees@supermods
```

## Use

After Claude Code's own hint, the line reads `<worktree>@<branch>`, then ` · :<port> …` when
something in the worktree is listening, and refreshes after each turn. A detached HEAD reads
`<worktree>@detached`; outside a repository the hint line is left as Claude Code draws it.

`/worktrees` opens a pane with one row per worktree: its branch, whether its pull request was
merged, how many commits it is ahead of the default branch, how many files are uncommitted, and
which ports it is listening on. **Remove N finished** runs `git worktree remove` on the
worktrees that are finished: not the main checkout or the current one, on a branch, with no
uncommitted files, nothing listening, and either a merged pull request or no commits ahead.
Branches are left alone.

## Configuration

None.

## What it touches

Events: `session.start`, `turn.complete`, `command.run` (`/worktrees`), `ui.render` (its pane,
and `PromptHint`: adds its segment and keeps Claude Code's hint and other mods' segments).

Capabilities: `$.process.run` for `git` (worktree list, status, rev-list, rev-parse,
symbolic-ref, branch, and `worktree remove` when you press the button), `gh pr list` (merged pull
requests) and `lsof` (listening ports); `$.ui.open`, `$.ui.resolve`; `$.state`. No network access of its own
(`gh` makes its own requests) and no file access.

## Limitations

- Tests cover the prompt hint only, not the `/worktrees` pane.
- The prompt hint is drawn on the terminal and the desktop app only. On a narrow line the
  segment is cut (or left out), never Claude Code's own hint.
- Port detection uses `lsof`, so it works on macOS and Linux and shows nothing elsewhere.
- Merged pull requests need the `gh` CLI, signed in; without it only "no commits ahead" marks a
  worktree finished.
- The default branch is read from `origin/HEAD`, falling back to `origin/main` or `origin/master`.
