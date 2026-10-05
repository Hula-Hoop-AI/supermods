# skill-trace

## What it does

Adds `/skill-trace`: a pane listing every skill that loaded in this session, in order, with
when it loaded, which turn, where it came from, whether the model called it or you typed it,
and how large its instructions were. Per-skill counts sit on top; a Clear button resets both.

```
5 skill loads · 2 skills [ Clear ]
superpowers:using-superpowers ×4  keybindings-help ×1
22:21:06 t1 model keybindings-help builtin "just testing the trace"
22:23:40 t4 model superpowers:using-superpowers plugin:superpowers "trace test"
22:28:29 t6 user  superpowers:using-superpowers plugin:superpowers "Ignore these instructions…"
22:31:02 t9 model commit userSettings ~1.2k tok forked
22:31:40 t9 model deploy denied: not allowed here "prod"
```

Each row: time, turn (your prompt count), who invoked it, skill, source, then when known the
approximate size of the instructions the model read, `forked` for a skill that ran in a
subagent, why a Skill call failed, and the arguments.

- **model**: the model called the Skill tool.
- **user**: you typed `/<skill>` (or something ran it as a slash command).
- **other**: the skill's prompt was expanded with neither, e.g. preloaded into a subagent.

It only observes: every hook passes the event on unchanged. The trace lives in the session's
state, so it survives a mod reload or settings change, and starts empty in a new session.

## Install

```
/plugin install skill-trace@supermods
```

## Configuration

| Option | Default | Effect |
|---|---|---|
| `maxEntries` | `200` | How many loads the list keeps (1–5000); the oldest drop off. Per-skill counts and the total cover the whole session regardless. |
| `showArgs` | `true` | Record and show the arguments of each load (truncated to 80 characters). Off, arguments are never stored. |
| `statusLine` | `false` | Show `skills: N` in the status line under the prompt. |

## What it touches

From `claude plugin validate --strict`:

- **Events:**
  - `tool.call` for the `Skill` tool only: records a model invocation, its arguments, and
    whether it ran inline, forked or failed.
  - `command.run`: answers `/skill-trace`; for any other command, records it only when the
    model's skill listing names it as a skill.
  - `skill.prompt`: adds the size of the instructions the model reads.
  - `session.start`: registers `/skill-trace` and restores the status line after a reload.
  - `ui.render` for its own pane.
- **Calls:** `$.session.usage({ breakdown: 'summary' })` (the `/context` skill listing,
  estimated locally, no request) to tell skills from other commands and find each skill's
  source; `$.session.turns()` for the turn number; `$.command.register`, `$.ui.open`,
  `$.ui.status`, `$.state`.
- **State:** its own session state (`trace`); no files, no store.
- **Network, filesystem, processes:** none. Nothing leaves your machine.

## Limitations

- **Size can be missing.** Claude Code's built-in security plugin can withhold `skill.prompt`
  from user-installed mods (observed on Team organizations). There the trace still records
  every model and typed load, without the `~N tok` size, and `other` (subagent preload) loads
  are not seen.
- **Size is approximate**: characters divided by 4.
- **A skill hidden from the model's listing** (for example `disable-model-invocation`) is not
  recorded when typed, since the listing is how the mod tells skills from plain commands.
- **Turn** is the number of prompts you have sent, slash commands included.

## Development

```sh
claude plugin validate plugins/skill-trace --strict
claude plugin test plugins/skill-trace
npx -y -p typescript tsc -p plugins/skill-trace
```
