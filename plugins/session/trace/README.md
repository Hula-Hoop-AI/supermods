# trace

## What it does

Adds `/trace [skills|sources]`: one pane with two tabs that record what this session pulled in.
Both tabs record all the time; the tab only picks which one you are looking at.

**Skills** lists every skill that loaded, newest first: when, on which turn, who invoked it,
where it came from, how large its instructions were.

```
[ Skills ] [ Sources ]
5 skill loads · 3 skills [ Clear ]
superpowers:using-superpowers ×3  commit ×1  deploy ×1
22:31:40 t9 deploy                        model denied: not allowed here "prod"
22:31:02 t9 commit                        model userSettings ~1.2k tok forked
22:28:29 t6 superpowers:using-superpowers user plugin:superpowers "Ignore these instructions…"
updated 22:31:40
```

- **model**: the model called the Skill tool. **user**: you typed `/<skill>`. **other**: the
  skill's prompt was expanded with neither, e.g. preloaded into a subagent.
- `forked` marks a skill that ran in a subagent; a failed Skill call shows why in red.

**Sources** lists every web page Claude consulted, deduplicated by URL, and turns them into
citations on demand.

```
[ Skills ] [ Sources ]
2 pages fetched (1 failed) · 1 search result seen · 1 search · this session [ Insert citations ] [ Clear ]
fetched 2× docs.python.org Python docs      copy https://docs.python.org/3
fetched 1× httpbin.org     /status/404 failed copy https://httpbin.org/status/404
seen    1× realpython.com  Real Python      copy https://realpython.com/guide
search  “python docs”      → 2 results
updated 22:40:12
```

- **fetched**: pages Claude asked for with `WebFetch` (or one of your extra fetch tools), with
  how many times; `failed` when no fetch of it succeeded (an error, a denied call, or an HTTP
  status of 400 or more).
- **seen**: pages that came back from `WebSearch` but were never fetched.
- **search**: each query, newest first, with its result count.
- **Insert citations** puts the sources at the cursor in your prompt box, as a markdown list
  or numbered references. Failed fetches are never cited. **Clear** empties the ledger shown.

URLs are deduplicated after dropping the `#fragment`, tracking parameters (`utm_*`, `fbclid`,
`gclid`, `msclkid` and similar) and a trailing slash.

`/trace skills` and `/trace sources` open the pane on that tab; `/trace` alone reopens the tab
you last looked at. Where no pane can show (a narrow terminal, a headless host), `/trace` says
why and answers in text: the skill-load count, or the summary and full list of sources.

The mod only observes: every hook passes its event on unchanged.

## Install

```
/plugin install trace@supermods
```

## Configuration

All options are rows in `/config`; a change applies at once.

| Option | Default | Effect |
|---|---|---|
| `skills_max_entries` | `200` | How many skill loads the list keeps (1–5000); the oldest drop off. Per-skill counts and the total cover the whole session regardless. |
| `skills_show_args` | `true` | Record and show the arguments of each load (truncated to 80 characters). Off, arguments are never stored. |
| `skills_status_line` | `false` | Show `skills: N` in the status line under the prompt. |
| `sources_citation_format` | `markdown` | `markdown` writes `- [Title](url)`; `numbered` writes `[1] Title. url`. |
| `sources_cite_search_results` | `false` | Also cite pages that only appeared in search results. Off, only successfully fetched pages are cited. |
| `sources_extra_tools` | empty | Comma-separated names of other tools that fetch a URL (for example `mcp__fetch__fetch`). Each is recorded like `WebFetch`; a page title is taken from a `title` field or an HTML `<title>` in its result. |
| `sources_url_arg` | `url` | The argument that holds the URL in the extra tools' calls. |
| `sources_project_history` | `false` | Also keep every session's sources for this project in the plugin's store, and add a **Show project history** button. Insert and Clear then act on the view shown. |

## What it touches

From `claude plugin validate --strict`:

- **Events:**
  - `tool.call` for the `Skill` tool: records a model invocation, its arguments, and whether
    it ran inline, forked or failed.
  - `tool.call` for `WebFetch`, `WebSearch` and your `sources_extra_tools`: awaits the call and
    records its URL or query and results.
  - `command.run`: answers `/trace`; any other command is recorded only when the model's skill
    listing names it as a skill.
  - `skill.prompt`: adds the size of the instructions the model reads.
  - `session.start`: registers `/trace` and restores the status line after a reload.
  - `ui.render` for its own pane.
- **Calls:** `$.command.register`, `$.session.usage` (the `/context` skill listing, estimated
  locally with no request, and when the session began), `$.session.turns`, `$.session.root`
  (the project key for history), `$.state` (`trace.tab`, `trace.skills`, `trace.ledger`,
  `trace.view`), `$.store.get` / `set` / `delete` (only with `sources_project_history` on),
  `$.prompt.fill`, `$.ui.open`, `$.ui.resolve`, `$.ui.status`, `$.ui.copy`, `$.ui.invalidate`,
  `$.ui.toast`.
- **Data:** skill names and arguments; URLs, page titles and search queries. Kept in session
  state; with `sources_project_history`, sources also go to the plugin's store, a JSON file
  under your Claude Code config directory, keyed by project path.
- **No** files, processes, network or model calls of its own. Nothing is sent anywhere.

## Limitations

- **A skill's size can be missing.** Claude Code's built-in security plugin can withhold
  `skill.prompt` from user-installed mods (observed on Team organizations). There the Skills tab
  still records every model and typed load, without the `~N tok` size, and `other` loads are
  not seen. The size is approximate: characters divided by 4.
- **A skill hidden from the model's listing** (for example `disable-model-invocation`) is not
  recorded when typed, since the listing is how the mod tells skills from plain commands.
- **Turn** is the number of prompts you have sent, slash commands included.
- **WebFetch has no page title.** Its result is Claude's summary, not the page, so a fetched page
  is titled only when it also appeared in a search result; otherwise it shows its path.
- **Sources are only those that pass through tool calls.** Pages a Bash `curl` or a subagent's
  own MCP server reads outside `tool.call` are not seen.
- **Caps:** 500 sources per session and 300 per project (least recently seen dropped), the last
  100 searches. Rows that do not fit the pane are counted in an "…and N more" line.
- **`/clear` empties both tabs**, as it does all session state. Project history stays.
