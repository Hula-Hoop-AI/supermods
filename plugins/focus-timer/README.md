# focus-timer

A focus timer in the band above the prompt. `/focus-timer` starts a block; the band counts it down
with a progress bar, the round number and how many turns you finished in it, and offers pause,
skip and stop. A toast marks each switch between focus and break, and every fourth break is a
long one.

```
⏱ ██████░░░░░░░░░░ focus 31:40 · round 2 · 4 turns  Pause Skip Stop
```

Focus is drawn in magenta, breaks in cyan, a paused timer dim.

## Install

```
/plugin marketplace add Hula-Hoop-AI/supermods
/plugin install focus-timer@supermods
```

## Use

| Command | Effect |
|---|---|
| `/focus-timer` | Start a focus block of `focus_minutes`. |
| `/focus-timer 25` | Start a focus block of 25 minutes (1 to 180). |
| `/focus-timer pause` | Pause the timer, or resume it. |
| `/focus-timer stop` | Stop the timer and remove the band. |

Hotkeys while the band has focus: `p` pause or resume, `s` skip to the next phase, `x` stop.

## Configuration

| Option | Default | Effect |
|---|---|---|
| `focus_minutes` | `50` | Minutes in a focus block. |
| `break_minutes` | `10` | Minutes in a break. |
| `long_break_minutes` | `25` | Minutes in the break after every fourth focus block. |

## What it touches

Events: `session.start` (registers `/focus-timer`), `turn.complete` (main conversation turns, counted
per phase), `command.run` (`/focus-timer`), `ui.render` (the band above the prompt).

Capabilities: `$.clock` (a one-second tick, alive only while a block runs unpaused),
`$.ui.toast`, `$.ui.invalidate`, `$.state`. No file, process, network or model access.

## Limitations

- The timer lives in the session: `/clear` or quitting ends it.
- The band redraws every second while a timer runs.
