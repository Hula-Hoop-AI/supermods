# observe

## What it does

Adds `/observe`: one pane with a tab per provider, for what is running and deploying outside
the session. Every tab draws the same layout: the tabs, a summary line with its buttons, one
row per item, and a footer.

```
[ Docker ] [ Modal ] [ Render ] [ Vercel ]
3 deploys in 2 apps, 1 building · on feature-x               [ Refresh ]
https://web.vercel.app                                      [ copy ]
› building web  preview feature-x abcdef1 alice 5m
      Add login
  ready    web  prod main 1234567 bob 2h
      Release
docs
  ready    docs prod main 89abcde carol 1h
updated 9:03:23 PM · every 10s
```

`/observe docker`, `/observe modal`, `/observe render` or `/observe vercel` opens the pane on
that tab. `/observe` alone reopens the tab you last used. Pressing a tab switches provider.

| Tab | Rows | Extras |
|---|---|---|
| **Docker** | `docker ps`: name, image, status, ports | a **copy** button per container name; **logs** and **metrics** buttons per container |
| **Modal** | one row per running container, by app then start time: app, the end of the container id, who launched the app, the app's cost over the last 7 days, age | **Mine only / All runs**; **logs** and **metrics** buttons per container |
| **Render** | recent deploys: state, service, environment, branch, commit, trigger, age, commit message, link | current git branch marked `›` |
| **Vercel** | recent deployments grouped by app: a bold headline per app, its production URL (a custom domain first, else its shortest `*.vercel.app` one; the project name when it has none), then its deployments newest first: state, project, environment, branch, commit, creator, age, commit message (no per-deploy link: the headline carries the app's URL). Apps are ordered by their newest deployment | a **copy** button per app URL; current git branch marked `›` |

Deploy states are normalized to `building` (yellow), `ready` (green), `error` (red) and
`canceled` (dim). A Docker row's dot is green for a running container and dim for a stopped one.
A Modal row's dot is green once the container runs and yellow while it is pending.

Only the tab on screen is refreshed: Docker every 2 seconds, Modal every 20 seconds (costs
every 5 minutes), Render and Vercel every 60 seconds, or every 10 while a deploy is building.
Closing the pane stops polling. A missing CLI or daemon shows as one dim line; a missing or
rejected credential, a rate limit or a network error shows as one red line.

### Container logs and metrics (Modal and Docker)

Modal bills per app, so every container of an app shows the same cost. Each Modal and Docker
row has two buttons, each opening a pane of its own next to `/observe`:

- **logs** opens "Modal logs" or "Docker logs" with the container's latest log entries (the
  last 100, as many as fit; Docker's stdout and stderr together, in time order).
- **metrics** opens "Modal metrics" or "Docker metrics" with the container's GPU, CPU and RAM
  use:

```
GPU0 NVIDIA H100 80GB HBM3 · 512/700 W · 64°C
GPU0 util █████████████████░░░  87%
GPU0 mem  ███████████████░░░░░  77%  61.3 / 79.6 GiB
CPU       ███░░░░░░░░░░░░░░░░░  14%  2.3 / 16 cores
RAM       ░░░░░░░░░░░░░░░░░░░░   2%  18.5 / 1024 GiB host
updated 9:04:10 PM · every 5s
```

There is one logs pane and one metrics pane: pressing the button on another container points
the open pane at it. Each meter shows a percentage and its figures; the bars share one color
and narrow (down to 8 cells) in a narrow pane. A container without a GPU shows a dim `no GPU`.
CPU is the cores in use between two samples, against the container's CPU quota (read once from
its cgroup), so it reads `measuring…` on the first one; without a quota it is the cores alone,
with no bar. RAM is measured against the container's cgroup memory limit when that is below the
machine's memory, else against the machine's memory, marked `host` (see Limitations).

On Docker, CPU and RAM come from `docker stats`, measured against the container's own limits
(`--cpus` or a CPU quota, and `--memory`, from `docker inspect`). A container without a limit is
measured against what the Docker host has (`docker info`: CPUs and memory), marked `host`:

```
CPU   ███░░░░░░░░░░░░░░░░░  15%  1.2 / 8 cores host
RAM   ██████░░░░░░░░░░░░░░  30%  2.3 / 7.7 GiB
NET   1.63kB in / 512B out
BLOCK 1.93MB read / 0B written
```

Network and block I/O are the totals `docker stats` prints. A Docker container with GPUs
assigned (`--gpus`) also gets the GPU meters, from `nvidia-smi` run in it; others have no GPU
section.

The logs and metrics panes are shared by both tabs, one of each. Both panes refresh every
`detail_refresh_seconds` (5 by default) while open, one call at a time (a tick is skipped while
the previous call still runs), and stop when closed. An error, such as a container that has
stopped, shows as one red line in the pane.

## Install

```
/plugin marketplace add Hula-Hoop-AI/supermods
/plugin install {m}@supermods
```

Each tab needs its provider reachable; a tab whose provider is not set up says so and the
others keep working.

| Tab | Needs |
|---|---|
| Docker | the `docker` CLI on your `PATH` and a running daemon |
| Modal | macOS or Linux, and the `modal` CLI on your `PATH`, logged in (`modal token new`) |
| Render | `RENDER_API_KEY` in the environment Claude Code starts in |
| Vercel | `VERCEL_TOKEN` in the environment Claude Code starts in; a `.vercel/project.json` (from `vercel link`) in the session's directory or a parent picks the project and team |

## Configuration

| Option / variable | Default | Effect |
|---|---|---|
| `providers` | all four | Which tabs the pane has, in this order. |
| `docker_context` | empty | The docker context to list. Empty follows `DOCKER_HOST`, then your current context. |
| `docker_all` | `false` | Also list stopped containers (`docker ps --all`). |
| `docker_refresh_seconds` | `2` | Docker refresh interval (1-3600). |
| `modal_environment` | empty | The Modal environment to list. Empty follows `MODAL_ENVIRONMENT`, then your modal profile, then the workspace default. |
| `detail_refresh_seconds` | `5` | How often a Modal or Docker container's logs and metrics panes refresh while open (2-3600). |
| `render_services` | empty | Comma-separated Render service names to show. Empty shows every service, up to the cap. |
| `render_max_services` | `10` | Most Render services to list deploys for (1-50). A full refresh makes one request per service. |
| `vercel_team` | empty | Team id (`team_...`) or slug. Empty uses the team in `.vercel/project.json`, else your personal account. |
| `vercel_project` | empty | Project id or name. Empty uses the linked project, else every project in the scope. |
| `deploy_max_rows` | `15` | How many deploys the Render and Vercel tabs list, newest first (1-100). |
| `deploy_refresh_seconds` | `60` | Render and Vercel refresh interval while nothing is building (15-3600). |
| `deploy_building_refresh_seconds` | `10` | Render and Vercel refresh interval while a deploy is building (5-600). |
| `notify_on_finish` | `false` | While their tab is not on screen (the pane closed, or another tab showing), keep watching current-branch deploys that were building and toast when each is ready or fails. |
| `MODAL_ENVIRONMENT` (env var) | unset | Used when `modal_environment` is empty. |
| `RENDER_API_KEY` (env var) | unset | Render API key. |
| `VERCEL_TOKEN` (env var) | unset | Vercel API token. |

Every option appears as a row in `/config`. Changes apply immediately.

## What it touches

From `claude plugin validate --strict`:

- **Events:** `session.start` (registers `/observe`; resumes polling after a reload),
  `command.run` for `/observe`, `ui.close` and `ui.render` for its own panes (`observe`,
  `observe-logs`, `observe-metrics`).
- **Processes:** `$.process.run`, only for the tab on screen, and the Modal logs and metrics
  panes while they are open:
  - `docker [--context <ctx>] ps [--all] --format '{{json .}}'`
  - `docker [--context <ctx>] logs --tail 100 --timestamps <id>`: the logs pane, only while it
    is open.
  - `docker [--context <ctx>] stats --no-stream --format '{{json .}}' <id>`, and once per
    container `docker inspect <id>` and `docker info --format '{{json .}}'`: the metrics pane,
    only while it is open. For a container with GPUs assigned, also
    `docker [--context <ctx>] exec <id> nvidia-smi`, **which runs inside that container**;
    nothing else is run in a Docker container.
  - `sh -c <launcher>`: finds the Python that runs your `modal` CLI and runs a short helper on
    stdin, which lists running containers, each app's creator and your username with your
    existing Modal credentials. It uses the Modal client's **private** API, the only place app
    creators are exposed.
  - `modal container list --json [--env <env>]`: the fallback when the helper fails.
  - `modal billing report --start <7 days ago> --resolution h --json`
  - `modal container logs <container_id>`: the logs pane, only while it is open.
  - `modal container exec --no-pty <container_id> nvidia-smi` and
    `modal container exec --no-pty <container_id> cat <files>`: the metrics pane, only while
    it is open. **These run commands inside your container**: `nvidia-smi`, and `cat` over
    `/sys/fs/cgroup/cpu.stat`, `memory.current`, `memory.max` (cgroup v2), else
    `/sys/fs/cgroup/cpuacct/cpuacct.usage`, `memory/memory.usage_in_bytes`,
    `memory/memory.limit_in_bytes` (cgroup v1), else `/proc/loadavg` and `/proc/meminfo`; and
    once per container, for the meters' limits, `cat` over `/sys/fs/cgroup/cpu.max` (v2) or
    `/sys/fs/cgroup/cpu/cpu.cfs_quota_us` and `cpu.cfs_period_us` (v1), with `/proc/meminfo`.
    Nothing else is ever run in a container, and nothing is written there.
- **Network:** `$.http.fetch`, read-only `GET`s with your credential as a bearer header, to
  `https://api.render.com/v1/services…`, `https://api.vercel.com/v7/deployments…` and
  `https://api.vercel.com/v9/projects/<project>…` (one per app shown, to read its production
  domain: on opening the pane, on Refresh, and at most hourly otherwise).
- **Files (read only):** `$.fs.read` of `.git/HEAD` (or a worktree's `.git` file and the `HEAD`
  it points to) and `.vercel/project.json`, in the session's directory and its parents. No git
  process runs.
- **Environment:** reads `MODAL_ENVIRONMENT`, `RENDER_API_KEY`, `VERCEL_TOKEN`; writes nothing.
- **Other calls:** `$.clock`, `$.session.cwd`, `$.ui.open`/`panes`/`copy`/`toast`, `$.command.register`.
- **State:** its own session state (`observe.tab`, `snapshots`, `toggles`, `watching`, `logs`,
  `metrics`). It writes no files and uses no store.

Each credential goes only to its own provider. The mod never draws or logs one.

## Limitations

- **Modal needs macOS or Linux.** Creators come from a private client API that may change; the
  tab then falls back to the plain CLI's list, without creators or the Mine only button.
- **Modal costs** are billed full hours over the last 7 days, not live spend, per app.
- **The RAM bar is against the host on Modal.** Modal's sandboxes set the cgroup memory limit
  to the machine's memory (equal to `MemTotal` in `/proc/meminfo`), and the memory a function
  requested is not readable for a running container through Modal's client API. So the RAM bar
  reads near 0% against a figure marked `host`; the used figure is the container's own.
- **Modal metrics are sampled, not streamed.** Each refresh starts two short
  `modal container exec` calls (about a second each), so CPU cores are averaged over the
  refresh interval with some timing jitter. Where only `/proc` is readable, CPU is the load average, which
  Modal's sandboxes report as 0. An exec now and then answers with nothing; the pane then keeps
  the last figures and asks again on the next refresh.
- **Modal logs show the last 100 entries**, as `modal container logs` fetches them; long lines
  are cut at the pane's edge.
- **The logs and metrics panes open next to `/observe`**: on a surface that shows panes as
  tabs, a new one may open as a tab you have to select, and it does not take focus.
- **Render and Vercel show one page:** the newest `deploy_max_rows` deploys (on Vercel, across
  all apps; an app's headline does not count). On Render a deploy's branch is its service's
  configured branch.
- **A Vercel app's URL** needs the token to read the project. When it cannot (a token scoped
  away from it, a network error), the headline shows the project name and the lookup is retried
  on Refresh or after an hour.
- **The finish toast** only covers builds a tab saw building. A deploy that starts while its
  tab is off screen is not watched.
- **Credentials come from the environment** Claude Code started in, so changing one needs a
  restart.
- **A surface that places no panes** gets a message from `/observe` instead, and nothing polls.
