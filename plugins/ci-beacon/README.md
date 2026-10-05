# ci-beacon

Keeps the latest GitHub Actions run for the branch you are on in the status line, so you see CI
go green or red without leaving Claude Code.

```
CI ● passing · build        CI ◌ running · test        CI ✗ failing · deploy
```

It refreshes on a timer and after each turn, and shows one toast with the run's link when a run
that was running finishes.

## Install

```
/plugin marketplace add Hula-Hoop-AI/supermods
/plugin install ci-beacon@supermods
```

Needs the [`gh` CLI](https://cli.github.com), signed in, and a repository on GitHub.

## Use

Nothing to do: the line appears once the session starts in a git branch with runs. `/ci`
refreshes now and prints the run's state with its link. Off a branch, or without `gh`, the line
is left empty.

## Configuration

| Option | Default | Effect |
|---|---|---|
| `poll_seconds` | `60` | Seconds between checks of the latest run. |
| `workflow` | empty | Only show runs of this workflow (its name or file name). Empty shows the latest run of any workflow. |

## What it touches

Events: `session.start` (registers `/ci`, starts the timer), `turn.complete` (main
conversation turns), `command.run` (`/ci`).

Capabilities: `$.process.run` for `git branch --show-current` and `gh run list` (read-only;
`gh` makes its own network requests), `$.clock.every`, `$.ui.status`, `$.ui.toast`, `$.state`.
No file or model access and no network access of its own.

## Limitations

- One run: the latest on the branch (or of the chosen workflow). Several workflows on one push
  show whichever ran last.
- Each refresh is a `gh` call, so a short `poll_seconds` spends GitHub API quota.
