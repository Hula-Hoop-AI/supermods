# agent-debugger

A step debugger for the agent loop. Pause Claude Code at a prompt, a model request, a model
response, a tool call, a tool result or the end of a turn; inspect the event; edit it before it
goes on; then continue, step to the next event, or stop the turn. Any earlier event can also be
re-run from: the session is reset to the point just before it and continues from there.

## Install

```
/plugin marketplace add Hula-Hoop-AI/supermods
/plugin install agent-debugger@supermods
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

The **events** tab lists the session's events, newest first. An event opens in place to its
fields and to the conversation the model had before it. While an event is held, its fields are
inputs:

| Held at | Editable |
|---|---|
| prompt | the prompt text |
| model request | the model and effort of that one request |
| model response | the response text (the response is held back until you continue) |
| tool call | each argument, or skip the call |
| tool result | the result as the model will read it |

An event that is not held offers **Re-run from here**, with an optional message to send.

The **breakpoints** tab picks which events Play stops on, which tools the two tool events apply
to, and whether to pause inside subagents. Breakpoints are kept for the session.

## Configuration

None.

## What it touches

Events: `session.start`, `command.run` (`/debugger`), `prompt.submit`, `turn.start`,
`turn.step`, `tool.call`, `session.append` (tool results), `turn.complete`, `session.compact`,
`ui.render` (its pane and the band above the prompt).

Capabilities: `$.process.run` (only `sleep`, to wait while an event is held), `$.session.messages`
and `$.session.usage` (to show the context), `$.store` (breakpoints), `$.command.run` (`/compact`,
for a re-run), `$.prompt.submit` (a re-run's message), `$.turn.abort`, `$.tool.list`, `$.clock.now`.
No network and no file access.

It rewrites what the model sends and receives only where you edit a held event, and replaces the
conversation only when you press Re-run now.

## Limitations

- Early: verified by its tests and by hand in the desktop app, not across releases.
- A re-run does not undo file changes or commands that already ran, and it leaves the `/compact`
  command's two rows in the conversation.
- Text fields are one line. A value of several lines gets one field per line (up to 40), and
  lines cannot be added or removed.
- A held response is not streamed live; it shows when you continue.
- The system prompt and tool definitions are not shown in an event's context.
