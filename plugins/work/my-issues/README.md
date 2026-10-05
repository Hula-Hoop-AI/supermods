# my-issues

## What it does

Adds `/issues`: a pane of the open issues assigned to you on GitHub, Linear, Jira and
monday.com, grouped by tracker. Press an issue's key to put a reference to it in your prompt.

```
5 open issues assigned to you                    [ Refresh ]
GitHub (1)
  octo/app#12 Fix the login redirect open P1 2h        open
Linear (2)
  ENG-123 Ship the importer In Progress High 30m       open
  ENG-7 Old idea Backlog 4w                            open
Jira (1)
  PROJ-7 Rotate the keys To Do Medium 3d               open
monday.com
  not configured: set MONDAY_API_TOKEN (or the monday.com API token setting)
updated 9:41:02 AM · every 5 min · press an issue's key to put it in the prompt
```

- **Each row:** key, title, status, priority (when the tracker has one), the board (monday.com),
  how long ago it was updated, and an `open` link.
- **Press the key** to insert `ENG-123: Ship the importer https://linear.app/…` at the cursor.
  Where a surface has no prompt box of its own to fill, it copies the reference to the clipboard.
- **Each tracker stands alone.** All are fetched in parallel with a 20 s timeout. A missing
  token or CLI shows as a dim "not configured" line saying what to set; an HTTP error shows in red.
  Neither one hides the other trackers.
- **Refresh** with the button, and every 5 minutes while the pane is open. Polling stops when
  the pane closes, and starts again after a reload or a settings change.

## Install

```
/plugin install my-issues@supermods
```

All four trackers are on by default. Each one that has no credentials shows how to set them up.
Turn off the ones you don't use in `/config`.

## Configuration

Plugin settings are rows in `/config`. Sensitive settings are stored in your system's credential
store, not in `settings.json`, and don't appear as `/config` rows. A setting that has a value
wins over its environment variable. Claude Code reads environment variables when it starts.

| Setting / variable | Default | Effect |
|---|---|---|
| `github` | `true` | List GitHub issues through the `gh` CLI. |
| `github_scope` | empty | Empty: every repo you can see (`gh search issues --assignee @me`). `repo`: only the repo Claude Code runs in (`gh issue list`). Otherwise owners and/or `owner/repo` entries, comma-separated. Owners and repos each get their own search, and the results are merged. |
| `linear` | `true` | List Linear issues assigned to you that aren't completed or canceled. |
| `linear_api_key` (sensitive) / `LINEAR_API_KEY` | unset | A Linear personal API key. |
| `jira` | `true` | List Jira Cloud issues. |
| `jira_base_url` / `JIRA_BASE_URL` | unset | Your site, e.g. `https://your-team.atlassian.net`. |
| `jira_email` / `JIRA_EMAIL` | unset | The Atlassian account email the token belongs to. |
| `jira_api_token` (sensitive) / `JIRA_API_TOKEN` | unset | An [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens), sent with basic auth. |
| `jira_jql` | empty | The search. Empty means `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`. |
| `monday` | `true` | List monday.com items assigned to you that aren't marked done. |
| `monday_api_token` (sensitive) / `MONDAY_API_TOKEN` | unset | A monday.com personal API token. |
| `monday_boards` | empty | Board ids to scan, comma-separated. Empty: your 10 most recently used boards. |
| `limit` | `20` | The most issues listed per tracker (1–100). |
| `refresh_minutes` | `5` | How often the open pane refreshes (1–60). |

## What it touches

From `claude plugin validate --strict`:

- **Events:** `session.start` registers `/issues` and resumes polling if the pane is already
  open. `command.run` for `/issues` opens the pane. `ui.close` for its own pane stops polling.
  `ui.render` draws its own pane.
- **Calls:** `$.process.run`, `$.http.fetch`, `$.env.get`, `$.clock.every`/`after`,
  `$.prompt.fill`, `$.ui.copy`, `$.ui.toast`, `$.ui.open`, `$.ui.panes`, `$.command.register`,
  and its own state (`my-issues.snapshot`).
- **Processes:** exactly `gh search issues --assignee @me --state open …` or, with
  `github_scope: repo`, `gh issue list --assignee @me --state open …`. Both use your existing
  `gh` login.
- **Network:** read-only requests, each sent only to its own tracker with its own credential:
  - `POST https://api.linear.app/graphql` (`viewer.assignedIssues`)
  - `GET <JIRA_BASE_URL>/rest/api/3/search/jql`
  - two `POST https://api.monday.com/v2` queries (`API-Version: 2026-07`): one for the boards and
    their People columns, one for the items assigned to you.

  It never writes to a tracker and sends nothing anywhere else.
- **Environment:** reads `LINEAR_API_KEY`, `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`,
  `MONDAY_API_TOKEN`. Writes nothing. Tokens are never logged or drawn.

## Limitations

- **GitHub:** issues only, not pull requests. Status is always `open`, and priority is a label
  that looks like one (`P1`, `priority: high`). `gh` must be on `PATH` and logged in.
- **Linear:** a personal API key only. OAuth isn't supported.
- **Jira:** Jira Cloud only (REST v3 `search/jql`). Server and Data Center aren't supported.
- **monday.com:** the API can only filter by person one board at a time, so the mod scans the
  boards you list, or your 10 most recently used boards. An item counts as yours when you're in
  any of its People columns. "Done" means a Status column marked done. Status is the first
  Status column's text, and no priority is shown. Large boards cost API complexity. If you hit
  the budget, set `monday_boards`.
- Lists the first `limit` issues per tracker, without paging further.

## Development

```sh
claude plugin validate plugins/my-issues --strict
claude plugin test plugins/my-issues
npx -y -p typescript tsc -p plugins/my-issues
```
