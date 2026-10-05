# observe

## What it does

Adds `/observe`: one pane with a tab per provider, for what is running and deploying outside
the session. Every tab draws the same layout: the tabs, a summary line with its buttons, one
row per item, and a footer.

```
[ Docker ] [ Modal ] [ Render ] [ Vercel ]
2 deploys, 1 building · on feature-x                        [ Refresh ]
› building web preview feature-x abcdef1 alice 5m
      Add login https://web-abc.vercel.app
  ready    web prod main 1234567 bob 2h
      Release https://web-prod.vercel.app
updated 9:03:23 PM · every 10s
```

`/observe docker`, `/observe modal`, `/observe render` or `/observe vercel` opens the pane on
that tab. `/observe` alone reopens the tab you last used. Pressing a tab switches provider.

| Tab | Rows | Extras |
|---|---|---|
| **Docker** | `docker ps`: name, image, status, ports | a **copy** button per container name |
| **Modal** | running containers by app: count, who launched it, cost over the last 7 days, age | **Mine only / All runs** |
| **Render** | recent deploys: state, service, environment, branch, commit, trigger, age, commit message, link | current git branch marked `›` |
| **Vercel** | recent deployments: state, project, environment, branch, commit, creator, age, commit message, link | current git branch marked `›` |

Deploy states are normalized to `building` (yellow), `ready` (green), `error` (red) and
`canceled` (dim). A Docker row's dot is green for a running container and dim for a stopped one.

Only the tab on screen is refreshed: Docker every 2 seconds, Modal every 20 seconds (costs
every 5 minutes), Render and Vercel every 60 seconds, or every 10 while a deploy is building.
Closing the pane stops polling. A missing CLI or daemon shows as one dim line; a missing or
rejected credential, a rate limit or a network error shows as one red line.

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
  `command.run` for `/observe`, `ui.close` and `ui.render` for its own pane.
- **Processes:** `$.process.run`, only for the tab on screen:
  - `docker [--context <ctx>] ps [--all] --format '{{json .}}'`
  - `sh -c <launcher>`: finds the Python that runs your `modal` CLI and runs a short helper on
    stdin, which lists running containers, each app's creator and your username with your
    existing Modal credentials. It uses the Modal client's **private** API, the only place app
    creators are exposed.
  - `modal container list --json [--env <env>]`: the fallback when the helper fails.
  - `modal billing report --start <7 days ago> --resolution h --json`
- **Network:** `$.http.fetch`, read-only `GET`s with your credential as a bearer header, to
  `https://api.render.com/v1/services…` and `https://api.vercel.com/v7/deployments…`.
- **Files (read only):** `$.fs.read` of `.git/HEAD` (or a worktree's `.git` file and the `HEAD`
  it points to) and `.vercel/project.json`, in the session's directory and its parents. No git
  process runs.
- **Environment:** reads `MODAL_ENVIRONMENT`, `RENDER_API_KEY`, `VERCEL_TOKEN`; writes nothing.
- **Other calls:** `$.clock`, `$.session.cwd`, `$.ui.open`/`panes`/`copy`/`toast`, `$.command.register`.
- **State:** its own session state (`observe.tab`, `snapshots`, `toggles`, `watching`). It
  writes no files and uses no store.

Each credential goes only to its own provider. The mod never draws or logs one.

## Limitations

- **Modal needs macOS or Linux.** Creators come from a private client API that may change; the
  tab then falls back to the plain CLI's list, without creators or the Mine only button.
- **Modal costs** are billed full hours over the last 7 days, not live spend.
- **Render and Vercel show one page:** the newest `deploy_max_rows` deploys. On Render a
  deploy's branch is its service's configured branch.
- **The finish toast** only covers builds a tab saw building. A deploy that starts while its
  tab is off screen is not watched.
- **Credentials come from the environment** Claude Code started in, so changing one needs a
  restart.
- **A surface that places no panes** gets a message from `/observe` instead, and nothing polls.
