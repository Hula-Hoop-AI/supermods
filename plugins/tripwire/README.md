# tripwire

Holds a destructive Bash command before it runs and opens a pane that names the rule it tripped,
shows the command, and estimates what it would destroy: the size of what `rm -rf` would delete,
the uncommitted files a hard reset would lose, the remote commits a force push would overwrite.
You then run it once, block it, or allow that rule for the rest of the session.

```
⚠ recursive delete
rm -rf ./build ./node_modules
 12K   ./build
1.2G   ./node_modules
[ Run once ] [ Block ] [ Allow this rule for the session ]
```

Blocked, the command never runs and Claude reads a note saying who blocked it and not to retry.

## Install

```
/plugin marketplace add Hula-Hoop-AI/supermods
/plugin install tripwire@supermods
```

## What trips it

Each command in a chain (`a && b; c | d`) is checked on its own.

| Rule | Matches | Impact shown |
|---|---|---|
| recursive delete | `rm` with `-r`, `-R` or `--recursive` | `du -sh` of the named paths |
| hard reset | `git reset --hard` | count of uncommitted files |
| discard changes | `git checkout -- .`, `git restore .`, `git restore --worktree .` | count of uncommitted files |
| untracked clean | `git clean` with `-f`, `-d` or `--force`, unless `-n`/`--dry-run` | count of paths `git clean -nd` would remove |
| force push | `git push` with `--force`, `--force-with-lease`, `--force-if-includes`, `-f` (also in a cluster like `-fu`), or a `+branch` refspec | local commits, and remote-only commits that would be overwritten |
| force branch delete | `git branch -D`, or `--delete`/`-d` together with `--force`/`-f` | |
| sql wipe | `DROP TABLE/DATABASE/SCHEMA`, `TRUNCATE TABLE` | |
| world-writable | `chmod` with `-R` and `777`, in either order | |
| disk overwrite | `mkfs`, `dd if=` | |

Hotkeys while the pane has focus: `y` run once, `n` block, `a` allow the rule for the session.
Closing the pane blocks every held command. Several tripped commands at once (a parallel batch)
queue in the pane and are decided one at a time, oldest first. Where the terminal is too narrow
for a pane, the same question is asked in Claude Code's question dialog; dismissing it blocks.
With nobody to ask (`claude -p`), or when the hold itself fails (no `sleep` on the machine), the
command is blocked and Claude is told to ask you first: the wire fails closed.

## Configuration

| Option | Default | Effect |
|---|---|---|
| `extra_patterns` | none | More regular expressions (JavaScript syntax) that trip the wire, one per entry. An invalid one is ignored. |
| `hold_seconds` | `300` | Seconds to wait for your answer before the command is blocked. |

## What it touches

Events: `tool.call` for the Bash tool (held until you answer; passed on unchanged or denied),
`ui.close` (its own pane), `ui.render` (its own pane).

Capabilities: `$.process.run` for `du`, `git status --porcelain`, `git clean -nd` and
`git rev-list` (read-only estimates, never the held command itself) and for `sleep` while it
waits; `$.ui.open`, `$.ui.close`, `$.ui.ask`; `$.clock`; `$.state`. No network, file or model
access.

It can only make Claude run fewer commands, never more: a command the wire does not trip goes
through your permission settings as before.

## Limitations

- Patterns match the command text, so a destructive command built from shell variables or run
  through a script is not caught. It is a seat belt, not a sandbox.
- `du` cannot resolve shell variables or globs, so the impact line shows its error for those.
- The hold waits with `sleep`, so it needs a POSIX `sleep` on the machine (macOS, Linux, WSL).
- Allowing a rule lasts until the session ends.
