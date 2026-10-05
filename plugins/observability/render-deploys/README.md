# render-deploys

## What it does

Adds `/render-deploys`: a pane of your recent [Render](https://render.com) deploys across your
services, newest first. Deploys of services that track your current git branch are marked `›`.

```
Render deploys · on feature-x                               [ Refresh ]
  error    api prod main fff0001 new commit 30m ago
      Bump deps https://dashboard.render.com/web/srv-1/deploys/dep-1
› ready    api-pr-7 preview feature-x eee0001 manual 1h ago
      Preview it https://dashboard.render.com/web/srv-2/deploys/dep-2
updated 9:03:23 PM · next in 60s
```

Each row shows the state, service, environment (`preview` for a pull-request preview service,
`prod` otherwise), the service's branch, short commit SHA, what triggered the deploy, and age.
Under it are the first line of the commit message and a dashboard link. States are normalized:

| State | Render `status` |
|---|---|
| `building` (yellow) | `created`, `queued`, `build_in_progress`, `update_in_progress`, `pre_deploy_in_progress` |
| `ready` (green) | `live`, `deactivated` (a successful deploy that a newer one replaced) |
| `error` (red) | `build_failed`, `update_failed`, `pre_deploy_failed` |
| `canceled` (dim) | `canceled` |

A missing key, a rejected key, a rate limit or a network error appears as one red line in the
pane. If one service fails, the other services still list.

### Refresh and API load

Render has no endpoint that lists deploys across services, so a **full refresh** sends one
request for the service list plus one request per shown service. To keep the load down:

- A full refresh runs only when you open the pane, when you press **Refresh**, and at most
  once every `refresh_seconds` (60 by default).
- While something is building, the faster `building_refresh_seconds` polls (10 by default)
  re-fetch deploys **only for services with a deploy in progress**. Every other row is kept
  from the last full refresh.
- At most `max_services` services are fetched (default **10**, down from 20 in the old combined
  `deploys` mod).

At the defaults, that means about **11 requests a minute when nothing is building**, plus 5 a
minute for each building service. The worst case, with all 10 services building, is about 61 a
minute. The old combined `deploys` mod sent about 126 a minute with 20 services.

Render documents a limit of **400 requests per minute for `GET` requests** ("Other GET
requests: 400 / minute"). It reports usage in the `Ratelimit-Limit`, `Ratelimit-Remaining` and
`Ratelimit-Reset` headers and answers `429` past the limit. See
<https://api-docs.render.com/reference/rate-limiting>. The limit is shared with everything
else that uses your key. If you raise `max_services` toward 50 with a 5-second building
interval, set `services` to the ones you care about. If you get a 429, the pane shows
`Render rate limit hit`.

Closing the pane stops polling.

## Install

```
/plugin install render-deploys@supermods
```

Then set `RENDER_API_KEY` in the environment Claude Code starts in, using an API key from your
Render account settings.

## Configuration

| Option / variable | Default | Effect |
|---|---|---|
| `services` | empty | Comma-separated service names (exact match). When empty, every service is shown, up to `max_services`. |
| `max_services` | `10` | The most services to fetch deploys for (1-50). If services are left out, the pane says how many. |
| `max_rows` | `15` | How many deploys to list in total, newest first (1-100). This is also each per-service request's `limit`. |
| `refresh_seconds` | `60` | Interval between full refreshes (15-3600). |
| `building_refresh_seconds` | `10` | Interval between re-checks of the building services (5-600). |
| `notify_on_finish` | `false` | After you close the pane, keep polling while any current-branch deploy that was building is still unfinished. Shows a toast when each one is live or fails. |
| `RENDER_API_KEY` (env var) | unset | Render API key. |

Every option appears as a row in `/config`. Changes apply immediately.

## What it touches

From `claude plugin validate --strict`:

- **Events:**
  - `session.start` registers `/render-deploys`, and resumes polling if the pane is still open after a reload.
  - `command.run` handles `/render-deploys`.
  - `ui.render` draws its own pane (`render-deploys`).
- **Network:** `$.http.fetch`. Read-only `GET` requests, with your key as a bearer header, to
  exactly these endpoints:
  - `https://api.render.com/v1/services?limit=100`
  - `https://api.render.com/v1/services/<id>/deploys?limit=…`
- **Files (read only):** `$.fs.read` of `.git/HEAD` (or a worktree's `.git` file and the `HEAD`
  it points to). It reads these in the session's directory and its parents to find the current
  branch. No git process runs.
- **Environment:** reads `RENDER_API_KEY` and writes nothing.
- **Other calls:** `$.clock` (timers), `$.session.cwd`, `$.ui.open`/`panes`/`toast`, `$.command.register`.
- **State:** its own session state (`render-deploys.snapshot`, `render-deploys.watching`). It writes no files and uses no store.

Your key goes only to `api.render.com`. The mod never draws or logs it.

## Limitations

- **Trigger, not creator:** Render's API doesn't name the user behind a deploy. The pane shows
  the trigger instead (`new commit`, `manual`, `api`, ...).
- **Branch** is the service's configured branch. Render doesn't record a branch per deploy.
- **Only the first 100 services** the API returns are considered. Beyond that, use `services`.
- **New builds on other services** show up at the next full refresh (up to `refresh_seconds`),
  because building polls only re-check services that were already building.
- **The finish toast** only covers deploys the pane saw building while it was open.
- **The key comes from the environment** Claude Code started in, so changing it requires a
  restart.

## Development

```sh
claude plugin validate plugins/render-deploys --strict
claude plugin test plugins/render-deploys
npx -y -p typescript tsc -p plugins/render-deploys
```
