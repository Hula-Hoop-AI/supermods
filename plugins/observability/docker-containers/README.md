# docker-containers

## What it does

Adds `/docker`: a pane showing `docker ps` for your local [Docker](https://www.docker.com)
containers, refreshed every 2 seconds while it is open.

```
CONTAINER ID   IMAGE         COMMAND                  CREATED       STATUS                 PORTS                  NAMES
aaa111         nginx:1.27    "/docker-entrypoint.…"   3 hours ago   Up 3 hours             0.0.0.0:8080->80/tcp   webapp-web-1   copy
bbb222         postgres:16   "docker-entrypoint.s…"   3 hours ago   Up 3 hours (healthy)   5432/tcp               webapp-db-1    copy
updated 9:03:23 PM · every 2s
```

- The columns and the row order are those of `docker ps`; a narrow pane truncates each row at
  its right edge.
- Each row has a **copy** button that puts the container name on the clipboard.
- The pane refreshes while it is open, stops when you close it, and picks polling back up
  after a reload or a settings change. Only one `docker ps` runs at a time: if one is still
  running when the next refresh is due, that refresh is skipped.

A machine without Docker, or with the daemon not running, shows a single dim line
(`Docker: not installed`, `Docker: daemon not running`): those are normal states, not faults.
A denied socket or any other docker failure is shown in red.

## Install

```
/plugin install docker-containers@supermods
```

Requires the `docker` CLI on your `PATH` and a running daemon.

## Configuration

| Option / variable | Default | Effect |
|---|---|---|
| `context` (plugin setting, a row in `/config`) | empty | The docker context to list (`docker --context <name>`); shown in the footer. Empty follows `DOCKER_HOST`, then your current context (`docker context use`). |
| `all` (plugin setting) | `false` | Also list stopped containers (`docker ps --all`). |
| `refresh_seconds` (plugin setting) | `2` | How often the open pane refreshes (1 to 3600). |
| `DOCKER_HOST` (env var) | unset | Read by the `docker` CLI itself when `context` is empty, not by the mod. |

## What it touches

From `claude plugin validate --strict`:

- **Events:** `session.start` (registers `/docker`; resumes polling if the pane is already
  open), `command.run` for `/docker`, `ui.close` for its own pane (stops polling),
  `ui.render` for its own pane.
- **Calls:** `$.process.run`, `$.clock.every`, `$.command.register`, `$.ui.open`,
  `$.ui.panes`, `$.ui.copy`, `$.ui.toast`, `$.state.get` / `$.state.set`.
- **Processes:** exactly one, 5 second limit:
  `docker [--context <ctx>] ps [--all] --format '{{json .}}'`
- **State:** its own session state (`docker-containers.docker`); no files, no store.
- **Clipboard:** only when you press a row's copy button.
- **Network:** none of its own. Only the `docker` CLI talks to its daemon, as it would from
  your shell.

## Limitations

- **Columns are aligned with spaces**, as `docker ps` does; they line up only where the pane
  uses a monospace font.
- **A slow daemon** (over 5 seconds) shows a timeout in red; refreshes due in the meantime are
  skipped rather than queued.
- **Podman** is not supported as such: it works only if `docker` on your `PATH` is Podman's
  Docker-compatible CLI. **Remote contexts** (ssh, tcp) work through `context`, but an
  unreachable one may show the docker CLI's own error rather than "daemon not running".
- **Read-only:** it lists containers; it does not start, stop or remove them.
- **The CLI must be on `PATH`** when Claude Code starts.
