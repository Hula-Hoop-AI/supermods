# context-tide

Shows the context window as a tide in the band above the prompt: a fill bar colored by phase,
a sparkline of the last turns, how fast the window is filling per turn, and how many turns are
left before the compaction threshold.

```
≈ ██████░░░░░░░░░░ ▁▂▂▃▄▄▅ 42% · mid tide · +3.5/turn · ~11 turns to 80%  Hide
```

The phases are `low tide` (cyan), `mid tide` (green), `high tide` (yellow) and `flood` (red,
at or past the threshold, where compaction is near). Crossing into flood shows one toast.

## Install

```
/plugin marketplace add Hula-Hoop-AI/supermods
/plugin install context-tide@supermods
```

## Use

The band appears after the first model response of the session and updates after each turn.
`/tide`, or the band's **Hide** button (`t` while the band has focus), hides it; `/tide` again
shows it.

## Configuration

| Option | Default | Effect |
|---|---|---|
| `compact_at` | `80` | Context fill, in percent, that counts as full: the bar turns red there and the turns-left estimate counts down to it. |
| `history_turns` | `12` | How many recent turns the sparkline shows. |

## What it touches

Events: `session.start` (registers `/tide`), `session.measure` (reads the context fill the
engine reports after each turn), `command.run` (`/tide`), `ui.render` (the band above the
prompt).

Capabilities: `$.ui.toast`, `$.state`. No file, process, network or model access.

## Limitations

- The turns-left estimate is a straight line through the last four turns, so a turn that reads
  a large file moves it a lot.
- A fill that fell (compaction, `/clear`) starts the history over, so the sparkline and the
  trend take a few turns to fill in again.
- It draws on the terminal and the desktop app only, as every band does.
