# debugger

A step debugger for the agent loop. Pause Claude Code at a prompt, a model request, a model
response, a tool call, a tool result or the end of a turn; inspect the event; edit it before it
goes on; then continue, step to the next event, or stop the turn.

## Install

```
/plugin marketplace add Hula-Hoop-AI/supermods
/plugin install debugger@supermods
```

## Use

`/debugger` opens the pane. `/debugger play|pause|step|stop` does the same as the buttons and
works while a turn is running.

| Control | Effect |
|---|---|
| Pause | Stop at the next event, and at every event after it until the turn ends or you press Play |
| Step | Let the held event go and stop at the next one |
| Stop | Abort the running turn |
| Play / Continue | Run until the next checked breakpoint |

The **events** tab lists the session's events, newest first. The **show** dropdown above the
list filters it: a checkbox per kind of event, one for subagents' events once there are any, and
Select all / Deselect all. An event shows when its kind and its origin are both checked, so each
checkbox counts what it would show under the others ("subagents 0 of 8" while their kinds are
hidden). Two kinds are observed only, never held: **skill loads** (a skill's instructions
entering the conversation, with their size) and **web sources** (each WebFetch URL and WebSearch
query, once it has run). An
unchecked kind is still recorded and still stops on its breakpoint, and the held event always
shows. An event opens in place to its fields and to the conversation the model had before it.
While an event is held, its fields are inputs:

| Held at | Editable |
|---|---|
| prompt | the prompt text |
| model request | the model and effort of that one request |
| model response | the response text (the response is held back until you continue) |
| tool call | each argument, or skip the call |
| tool result | the result as the model will read it |

The **breakpoints** tab picks which events Play stops on, which tools the two tool events apply
to, and whether to pause inside subagents. Breakpoints and the filter are kept for the session.

## Configuration

None.

## What it touches

Events: `session.start`, `command.run` (`/debugger`), `prompt.submit`, `turn.start`,
`turn.step`, `tool.call`, `session.append` (tool results), `turn.complete`, `session.compact`
(to know when an event's context is gone), `ui.render` (its pane and the band above the prompt).

Capabilities: `$.process.run` (only `sleep`, to wait while an event is held), `$.session.messages`
(to show the context), `$.state` (breakpoints and the filter), `$.turn.abort`, `$.tool.list`,
`$.clock.now`. No network and no file access.

It rewrites what the model sends and receives only where you edit a held event, and never changes
the conversation that came before it.

## Limitations

- Early: verified by its tests and by hand in the desktop app, not across releases.
- Text fields are one line. A value of several lines gets one field per line (up to 40), and
  lines cannot be added or removed.
- A held response is not streamed live; it shows when you continue.
- The system prompt and tool definitions are not shown in an event's context.
- The mobile app draws no input fields, so a held event's values are read-only there.
