# garden

A plant in the band above the prompt that grows as you work with Claude. Every successful tool
call is a growth point, every finished turn is four, and a failed tool call takes two away and
wilts the plant until the next turn finishes. It never dies, and it keeps growing across
sessions.

```
🌿 seedling · 61 pts · 14 to bush · 12 turns  Hide
```

Stages: 🫘 seed, 🌱 sprout, 🌿 seedling, 🪴 bush, 🌸 bloom, 🌳 tree. Reaching one shows a toast.
Wilted, the plant is drawn 🥀 in yellow.

## Install

```
/plugin marketplace add Hula-Hoop-AI/supermods
/plugin install garden@supermods
```

## Use

The band is on from the first turn. `/garden` reports the plant's stage, points and turns, and
hides the band; `/garden` again shows it. The band's **Hide** button (`g` while the band has
focus) hides it too.

## Configuration

| Option | Default | Effect |
|---|---|---|
| `stage_points` | `25` | Growth points needed to reach each next stage. |

## What it touches

Events: `session.start` (loads the saved garden, registers `/garden`), `tool.call` for every
tool (observes whether the call failed; nothing is changed), `turn.complete` (main conversation
turns that ended with an answer), `command.run` (`/garden`), `ui.render` (the band above the
prompt).

Capabilities: `$.store` (the garden, one small record, written after each finished turn), `$.ui.toast`, `$.state`. No file,
process, network or model access.

## Limitations

- The glyphs are emoji, so a terminal without an emoji font shows boxes.
- Points from tool calls since the last finished turn are lost if Claude Code quits mid-turn.
- Points come from the main conversation and its subagents' tool calls alike; only main
  conversation turns count as turns.
