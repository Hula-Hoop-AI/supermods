# sensitive-paths

## What it does

Keeps Claude from reading files that hold secrets. When Read (and Glob or Grep, in builds that
have them) targets a path matching a protected glob, the call is refused, or put to your
permission prompt if you prefer. Bash commands that read a protected path are checked too,
best effort. Writes are never blocked: Edit, Write, NotebookEdit and a Bash `>`/`>>` into a
protected file all go through. Claude gets a reason it can relay to you:

```
sensitive-paths blocked this Read call: ~/project/.env matches the protected pattern "**/.env".
Do not try to reach this file another way; tell the user. To allow it, the user adds a glob
covering it to the sensitive-paths plugin's "allowed" option.
```

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
to `protected` if yours holds more.

## Install

```
/plugin install sensitive-paths@supermods
```

## Configuration

| Option | Default | Effect |
|---|---|---|
| `protected` (list) | empty | Globs protected on top of the defaults. |
| `allowed` (list) | empty | Globs never blocked, even when a protected glob matches. Added to the built-in exceptions. |
| `check_bash` | `true` | Also check Bash commands. |
| `mode` | `deny` | A read of a protected path (Read, Glob, Grep, Bash): `deny` refuses it, `ask` puts it to your permission prompt, `off` allows it. |

`check_bash` and `mode` are rows in `/config`. The two lists are set when you
enable the plugin, or in `settings.json`:

```json
{ "pluginConfigs": { "sensitive-paths@supermods": { "options": {
  "protected": ["~/.vault-token", "**/secrets/**"],
  "allowed": ["**/fixtures/**/*.pem"]
} } } }
```

**Glob syntax:** `**` any number of folders (`dir/**` covers `dir` itself too), `*` and `?`
within one path segment, `{a,b}` alternatives. `~/` is your home, a glob starting with `/` is
absolute, and any other glob matches at any depth (`secrets.yml` means `**/secrets.yml`).

**About `ask`:** the call goes to your permission mode's decider. In the default mode that is
the permission dialog (a `-p` run refuses it). In auto mode the classifier decides, and it may
approve the call without asking you; bypass-permissions mode may approve it too. Use `deny`
when it must never happen.

## What it touches

From `claude plugin validate --strict`:

- **Events:** `tool.call` (refuses in `deny` mode, before the permission prompt, in every
  permission mode) and `tool.check` (answers `ask` or `deny` to the permission decision). Both
  hooks see every tool call; for tools it doesn't guard, the mod passes the call straight on.
- **Calls:** `$.session.cwd` (to resolve relative paths), `$.env.get` (reads `HOME` only),
  `$.fs.stat` (follows symlinks of Read, Glob and Grep paths; it never reads file contents).
- **Environment writes, processes, network, model, store:** none. Nothing leaves your machine.

## Limitations

- **Bash is best effort.** It reads the command's words (arguments, `<` targets, `$(...)`,
  `--flag=value`, `$HOME`), not what the shell will do: variables other than `HOME`,
  wildcards (`cat .en*`), scripts that open files themselves, and paths built at run time get
  through. Only `>`/`>>` targets count as writes, so a command that writes a protected file
  by naming it as an argument (`cp x .env`, `tee .env`) is still blocked. Arguments of `echo`
  and `printf` are treated as text. A word that only looks like a protected path (`grep .env
  .gitignore`) is blocked; add an `allowed` glob or turn off `check_bash` if that bites.
- **Writes show some content.** Edit's result echoes a few lines around the change, so editing
  a protected file lets Claude see part of it.
- **Symlinks** are followed only for Read, Glob and Grep paths, not inside Bash commands or
  Glob/Grep patterns. Hard links are not detected.
- **Glob and Grep:** a search rooted above a protected folder (Grep over your whole home) is
  not blocked; only a search whose folder or pattern names a protected path is. In builds where
  Glob and Grep run through Bash, the Bash check covers them.
- **macOS and Linux paths.** Windows paths (`C:\...`) are not normalized.
- Other tools that read files (MCP servers, LSP) are not checked.

## Development

```sh
claude plugin validate plugins/sensitive-paths --strict
claude plugin test plugins/sensitive-paths
npx -y -p typescript tsc -p plugins/sensitive-paths
```
