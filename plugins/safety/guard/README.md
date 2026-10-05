# guard

## What it does

Two rule sets that tighten what Claude may do, each with its own switch:

**Destructive Bash commands are held.** Before one runs, a pane names the rule it tripped, shows
the command, and estimates what it would destroy: the size of what `rm -rf` would delete, the
uncommitted files a hard reset would lose, the remote commits a force push would overwrite. You
then run it once, block it, or allow that rule for the rest of the session.

```
⚠ recursive delete
rm -rf ./build ./node_modules
 12K   ./build
1.2G   ./node_modules
[ Run once ] [ Block ] [ Allow this rule for the session ]
```

Blocked, the command never runs and Claude reads a note saying who blocked it and not to retry.

**Reads of secret files are blocked.** When Read (and Glob or Grep, in builds that have them)
targets a path matching a protected glob, the call is refused, or put to your permission prompt
if you prefer. Bash commands that read a protected path are checked too, best effort. Writes are
never blocked: Edit, Write, NotebookEdit and a Bash `>`/`>>` into a protected file all go
through. Claude gets a reason it can relay to you:

```
guard blocked this Read call: ~/project/.env matches the protected pattern "**/.env".
Do not try to reach this file another way; tell the user. To allow it, the user adds a glob
covering it to the guard plugin's "secrets_allowed" option.
```

A Bash command that trips both (`rm -rf ~/.ssh`) is refused as a secret read; no hold is offered.

### What is held

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
command is blocked and Claude is told to ask you first: the hold fails closed.

### What is protected

Before matching, paths are resolved: `~` becomes your home, relative paths resolve against the
session's working directory, `.` and `..` are folded, and for Read, Glob and Grep a symlink is
followed to where it really lands. Matching ignores case.

**Protected by default:** `~/.ssh/**`, `~/.aws/credentials`, `~/.config/gcloud/**`,
`~/.netrc`, `~/.docker/config.json`, `~/.kube/config`, `~/.config/gh/hosts.yml`,
`**/.git-credentials`, `**/.env`, `**/.env.*`, `**/*.pem`,
`**/*.key`, `**/id_rsa*`, `**/id_ed25519*`, `**/*.p12`, `**/*.pfx`, `**/credentials.json`,
`**/.npmrc`, `**/.pypirc`.

**Always allowed:** `**/.env.example`, `**/.env.sample`, `**/.env.template`, `**/*.pub`.

`~/.aws/config` is deliberately not protected: it holds profiles and regions, not keys. Add it
to `secrets_protected` if yours holds more.

## Install

```
/plugin marketplace add Hula-Hoop-AI/supermods
/plugin install guard@supermods
```

## Configuration

| Option | Default | Effect |
|---|---|---|
| `destructive_bash` | `true` | Hold destructive Bash commands. Off, the rule set registers no hooks. |
| `bash_extra_patterns` (list) | empty | More regular expressions (JavaScript syntax) that hold a Bash command, one per entry. An invalid one is ignored. |
| `bash_hold_seconds` | `300` | Seconds to wait for your answer before a held command is blocked. |
| `secret_reads` | `true` | Block reads of secret files. Off, the rule set registers no hooks. |
| `secrets_protected` (list) | empty | Globs protected on top of the defaults. |
| `secrets_allowed` (list) | empty | Globs never blocked, even when a protected glob matches. Added to the built-in exceptions. |
| `secrets_check_bash` | `true` | Also check Bash commands for secret reads. |
| `secrets_mode` | `deny` | A read of a protected path (Read, Glob, Grep, Bash): `deny` refuses it, `ask` puts it to your permission prompt, `off` allows it. |

The switches, `bash_hold_seconds`, `secrets_check_bash` and `secrets_mode` are rows in `/config`.
The lists are set when you enable the plugin, or in `settings.json`:

```json
{ "pluginConfigs": { "guard@supermods": { "options": {
  "bash_extra_patterns": ["terraform\\s+destroy"],
  "secrets_protected": ["~/.vault-token", "**/secrets/**"],
  "secrets_allowed": ["**/fixtures/**/*.pem"]
} } } }
```

**Glob syntax:** `**` any number of folders (`dir/**` covers `dir` itself too), `*` and `?`
within one path segment, `{a,b}` alternatives. `~/` is your home, a glob starting with `/` is
absolute, and any other glob matches at any depth (`secrets.yml` means `**/secrets.yml`).

**About `secrets_mode: ask`:** the call goes to your permission mode's decider. In the default
mode that is the permission dialog (a `-p` run refuses it). In auto mode the classifier decides,
and it may approve the call without asking you; bypass-permissions mode may approve it too. Use
`deny` when it must never happen.

## What it touches

From `claude plugin validate --strict`:

- **Events:** `tool.call` twice: once for every tool (refuses a secret read in `deny` mode,
  before the permission prompt, in every permission mode; other calls pass straight on) and once
  for Bash (held until you answer; passed on unchanged or denied). `tool.check` (answers `ask`
  or `deny` to the permission decision for a secret read). `ui.close` and `ui.render` for its
  own pane.
- **Calls:** `$.process.run` for `du`, `git status --porcelain`, `git clean -nd` and
  `git rev-list` (read-only estimates, never the held command itself) and for `sleep` while it
  waits; `$.ui.open`, `$.ui.close`, `$.ui.ask`; `$.state`; `$.session.cwd` (to resolve relative
  paths); `$.env.get` (reads `HOME` only); `$.fs.stat` (follows symlinks of Read, Glob and Grep
  paths; it never reads file contents).
- **Network, model, store, environment writes:** none. Nothing leaves your machine.

It can only make Claude do less, never more: a call neither rule set answers goes through your
permission settings as before.

## Limitations

- **Holds match the command text**, so a destructive command built from shell variables or run
  through a script is not caught. It is a seat belt, not a sandbox.
- `du` cannot resolve shell variables or globs, so the impact line shows its error for those.
- The hold waits with `sleep`, so it needs a POSIX `sleep` on the machine (macOS, Linux, WSL).
- Allowing a rule lasts until the session ends.
- **The Bash secret check is best effort.** It reads the command's words (arguments, `<`
  targets, `$(...)`, `--flag=value`, `$HOME`), not what the shell will do: variables other than
  `HOME`, wildcards (`cat .en*`), scripts that open files themselves, and paths built at run
  time get through. Only `>`/`>>` targets count as writes, so a command that writes a protected
  file by naming it as an argument (`cp x .env`, `tee .env`) is still blocked. Arguments of
  `echo` and `printf` are treated as text. A word that only looks like a protected path (`grep
  .env .gitignore`) is blocked; add a `secrets_allowed` glob or turn off `secrets_check_bash` if
  that bites.
- **Writes show some content.** Edit's result echoes a few lines around the change, so editing
  a protected file lets Claude see part of it.
- **Symlinks** are followed only for Read, Glob and Grep paths, not inside Bash commands or
  Glob/Grep patterns. Hard links are not detected.
- **Glob and Grep:** a search rooted above a protected folder (Grep over your whole home) is
  not blocked; only a search whose folder or pattern names a protected path is. In builds where
  Glob and Grep run through Bash, the Bash check covers them.
- **macOS and Linux paths.** Windows paths (`C:\...`) are not normalized.
- Other tools that read files (MCP servers, LSP) are not checked.
