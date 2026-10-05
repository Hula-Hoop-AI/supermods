# vercel-deploys

## What it does

Adds `/vercel-deploys`: a pane of your recent [Vercel](https://vercel.com) deployments, newest
first. Deployments of your current git branch are marked `›`.

```
Vercel deploys · on feature-x                               [ Refresh ]
› building web preview feature-x abcdef1 alice 5m ago
      Add login https://web-abc.vercel.app
  ready    web prod main 1234567 bob 2h ago
      Release https://web-prod.vercel.app
updated 9:03:23 PM · next in 10s (building)
```

Each row shows the state, project, environment (`prod`, `preview`, or a custom environment
slug), branch, short commit SHA, creator and age. Under it are the first line of the commit
message and a link. States are normalized:

| State | Vercel `readyState` |
|---|---|
| `building` (yellow) | `QUEUED`, `INITIALIZING`, `BUILDING` |
| `ready` (green) | `READY` |
| `error` (red) | `ERROR`, `BLOCKED` |
| `canceled` (dim) | `CANCELED`, `DELETED` |

The pane refreshes when you open it, when you press **Refresh**, every 10 seconds while a
deployment is building, and every 60 seconds otherwise. Closing the pane stops polling. A
missing token, a rejected token, a rate limit or a network error appears as one red line in the
pane.

If a `.vercel/project.json` (written by `vercel link`) is in the session's directory or a
parent, the pane shows that project and its team. You don't need any settings for this.

## Install

```
/plugin install vercel-deploys@supermods
```

Then set `VERCEL_TOKEN` in the environment Claude Code starts in, using a token from
<https://vercel.com/account/tokens>.

## Configuration

| Option / variable | Default | Effect |
|---|---|---|
| `team` | empty | Team id (`team_...`) or slug. When empty, the mod uses the team in `.vercel/project.json`, or your personal account if there is none. |
| `project` | empty | Project id or name. When empty, the mod uses the project linked in `.vercel/project.json`, or every project in the scope if there is none. |
| `max_rows` | `15` | How many deployments to list, newest first (1-100). This is also the request's `limit`. |
| `refresh_seconds` | `60` | Refresh interval while nothing is building (15-3600). |
| `building_refresh_seconds` | `10` | Refresh interval while a deployment is building (5-600). |
| `notify_on_finish` | `false` | After you close the pane, keep polling while any current-branch deployment that was building is still unfinished. Shows a toast when each one is ready or fails. |
| `VERCEL_TOKEN` (env var) | unset | Vercel API token. |

Every option appears as a row in `/config`. Changes apply immediately.

## What it touches

From `claude plugin validate --strict`:

- **Events:**
  - `session.start` registers `/vercel-deploys`, and resumes polling if the pane is still open after a reload.
  - `command.run` handles `/vercel-deploys`.
  - `ui.render` draws its own pane (`vercel-deploys`).
- **Network:** `$.http.fetch`. Each refresh sends one read-only `GET`, with your token as a
  bearer header, to `https://api.vercel.com/v7/deployments?limit=…[&projectId=…][&teamId=…|&slug=…]`.
- **Files (read only):** `$.fs.read` of `.git/HEAD` (or a worktree's `.git` file and the `HEAD`
  it points to) and of `.vercel/project.json`. It reads these in the session's directory and its
  parents. No git process runs.
- **Environment:** reads `VERCEL_TOKEN` and writes nothing.
- **Other calls:** `$.clock` (timers), `$.session.cwd`, `$.ui.open`/`panes`/`toast`, `$.command.register`.
- **State:** its own session state (`vercel-deploys.snapshot`, `vercel-deploys.watching`). It writes no files and uses no store.

Your token goes only to `api.vercel.com`. The mod never draws or logs it.

## Limitations

- **One page per refresh:** the pane shows the newest `max_rows` deployments. With no project
  set, that list spans every project in the scope.
- **The finish toast** only covers builds the pane saw building while it was open. A
  deployment that starts after you close the pane is not watched.
- **The token comes from the environment** Claude Code started in, so changing it requires a
  restart.

## Development

```sh
claude plugin validate plugins/vercel-deploys --strict
claude plugin test plugins/vercel-deploys
npx -y -p typescript tsc -p plugins/vercel-deploys
```
