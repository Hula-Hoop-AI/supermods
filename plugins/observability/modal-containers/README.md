# modal-containers

## What it does

Adds `/modal`: a pane listing the [Modal](https://modal.com) containers running in your
environment, grouped by app, with who launched each run and what it has cost.

```
3 running containers · main            [ All runs ]
     12m train-llm ×2 alice $1.75
 pending batch-embed bob $3.00
updated 9:03:23 PM · cost: billed full hours, last 7d
```

- **Who launched it**: the Modal user who created each app.
- **Cost**: what each app has been billed, from Modal's hourly billing report.
- **Mine only / All runs**: a button that keeps just the apps you launched.

The pane refreshes every 20 seconds while it is open (costs every 5 minutes), stops polling
when you close it, and picks polling back up after a reload or a settings change.

## Install

```
/plugin install modal-containers@supermods
```

Requires macOS or Linux, and the `modal` CLI on your `PATH`, logged in
(`pip install modal && modal token new`). pip, pipx, uv and pyenv installs all work.

## Configuration

| Option / variable | Default | Effect |
|---|---|---|
| `environment` (plugin setting, a row in `/config`) | empty | The Modal environment to list. A change applies at once. |
| `MODAL_ENVIRONMENT` (env var, read when Claude Code starts) | unset | Used when `environment` is empty. |
| Your modal profile's environment (`modal config set-environment <name>`) | workspace default | Used when both of the above are empty; failing that, the workspace default. |

The pane's header names the environment it is showing.

## What it touches

From `claude plugin validate --strict`:

- **Events:** `session.start` (registers `/modal`; resumes polling if the pane is already
  open), `command.run` for `/modal`, `ui.render` for its own pane.
- **Processes:** `$.process.run`, for exactly these commands:
  - `sh -c <launcher>`: finds the Python that runs your `modal` CLI (from the CLI script's
    shebang) and runs a short helper script on stdin. The helper calls Modal's API with your
    existing Modal credentials to list running containers, each app's creator, and your
    username. It uses the Modal client's **private** API, the only place app creators are
    exposed.
  - `modal container list --json [--env <env>]`: the fallback when the helper fails.
  - `modal billing report --start <7 days ago> --resolution h --json`: costs.
- **Environment:** reads `MODAL_ENVIRONMENT`; writes nothing.
- **State:** its own session state (`snapshot`, `costs`, `mineOnly`); no files, no store.
- **Network:** none of its own. Only the `modal` CLI and helper talk to Modal, as they would
  from your shell. Nothing is sent anywhere else.

## Limitations

- **Creators depend on a private API.** If a Modal release changes it, the pane falls back to
  `modal container list`: containers still show, without creators or the Mine only button,
  with a note saying why.
- **Cost covers complete hours only**, at most the last 7 days, per app (each `modal run` is
  its own app). A run younger than an hour shows `$—`. If your role cannot read billing, the
  cost column is hidden with a note.
- **macOS and Linux only**: it runs commands through `sh`.
- **The `modal` CLI must be on `PATH`** when Claude Code starts; a CLI installed only in an
  inactive virtualenv is not found.

## Development

```sh
claude plugin validate plugins/modal-containers --strict
claude plugin test plugins/modal-containers
```
