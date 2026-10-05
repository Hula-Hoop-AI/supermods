# sources

## What it does

Keeps a ledger of every web page Claude consulted this session, and turns it into citations
on demand. `/sources` opens a pane:

```
2 pages fetched (1 failed) · 2 search results seen · 1 search · this session
[ Insert citations ] [ Clear ]
Fetched
  2× docs.python.org Python docs
  1× httpbin.org /status/404 failed
Search results seen
  1× realpython.com Real Python
Searches
    “python docs” → 2 results
```

- **Fetched**: pages Claude asked for with `WebFetch` (or one of your extra fetch tools), with
  how many times, and `failed` when no fetch of it succeeded (an error, a denied call, or an
  HTTP status of 400 or more).
- **Search results seen**: pages that came back from `WebSearch` but were never fetched, titled
  from the search result.
- **Searches**: each query, newest first, with its result count.
- **Insert citations** (`i`): puts the sources at the cursor in your prompt box, as a markdown
  list or numbered references. Failed fetches are never cited.
- **Clear** (`c`): empties the ledger shown.

URLs are deduplicated after dropping the `#fragment`, tracking parameters (`utm_*`, `fbclid`,
`gclid`, `msclkid` and similar) and a trailing slash, so `https://a.com/p/?utm_source=x#top`
and `https://a.com/p` count as one source. Tool results are passed back to Claude unchanged.

Where no pane can open (a headless host), `/sources` answers with the summary and the full list
as text instead.

## Install

```
/plugin install sources@supermods
```

## Configuration

All options are rows in `/config`; a change applies at once.

| Option | Default | Effect |
|---|---|---|
| `citation_format` | `markdown` | `markdown` writes `- [Title](url)`; `numbered` writes `[1] Title. url`. |
| `cite_search_results` | `false` | Also cite pages that only appeared in search results. Off, only successfully fetched pages are cited. |
| `extra_tools` | empty | Comma-separated names of other tools that fetch a URL (for example `mcp__fetch__fetch`). Each is recorded like `WebFetch`; a page title is taken from a `title` field or an HTML `<title>` in its result. |
| `url_arg` | `url` | The argument that holds the URL in the extra tools' calls. |
| `project_history` | `false` | Also keep every session's sources for this project in the plugin's store, and add a **Show project history** (`p`) button. Insert and Clear then act on the view shown. |

## What it touches

From `claude plugin validate --strict`:

- **Events:** `session.start` (registers `/sources`), `tool.call` for `WebFetch`, `WebSearch`
  and your `extra_tools` (observes only: it awaits the call and records it), `command.run` for
  `/sources`, `ui.render` for its own pane.
- **Calls:** `$.command.register`, `$.session.turns` (the turn number of each source),
  `$.session.root` (the project key for history), `$.state` (`sources.ledger`, `sources.view`),
  `$.store.get` / `set` / `delete` (only with `project_history` on), `$.prompt.fill`,
  `$.ui.open`, `$.ui.resolve`, `$.ui.invalidate`, `$.ui.toast`.
- **Data:** URLs, page titles and search queries. Kept in session state; with
  `project_history`, also in the plugin's store, a JSON file under your Claude Code config
  directory, keyed by project path.
- **No** files, processes, network or model calls of its own. Nothing is sent anywhere.

## Limitations

- **WebFetch has no page title.** Its result is Claude's summary, not the page, so a fetched page
  is titled only when it also appeared in a search result; otherwise it shows its path.
- **Sources are only those that pass through tool calls.** Pages a Bash `curl` or a subagent's
  own MCP server reads outside `tool.call` are not seen. Subagents' `WebFetch`/`WebSearch` calls
  are recorded.
- **Caps:** 500 sources per session and 300 per project (least recently seen dropped), the last
  100 searches.
- **`/clear` empties the session ledger**, as it does all session state. Project history stays.

## Development

```sh
claude plugin validate plugins/sources --strict
claude plugin test plugins/sources
npx -y -p typescript tsc -p plugins/sources
```
