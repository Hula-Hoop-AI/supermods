# supermods

**A marketplace of mods for Claude Code.** A mod is a small TypeScript module that runs inside
Claude Code: it can watch, rewrite or answer tool calls, prompts and turns, draw panes and
status lines, and add slash commands. Mods need Claude Code v2.1.287 or later.

```
/plugin marketplace add Hula-Hoop-AI/supermods
/plugin install <mod-name>@supermods
```

## Mods

| Mod | What it does | Search words |
|---|---|---|
| [`agent-debugger`](plugins/agent-debugger/) | A step debugger for the agent loop. Pause at prompts, model requests, responses, tool calls and results; inspect and edit them; play, step, stop, or re-run from an earlier event. | debugger, breakpoints, step, pause, inspect, tool calls, re-run, rewind |
| [`ci-beacon`](plugins/ci-beacon/) | Keeps the latest GitHub Actions run for the current branch in the status line, refreshed on a timer and after each turn, with a toast when a run finishes. | ci, github actions, gh, status line, workflow |
| [`code-garden`](plugins/code-garden/) | A plant in the band above the prompt that grows with every tool call and finished turn, wilts when a tool fails, and keeps growing across sessions. | fun, plant, companion, band, progress |
| [`context-tide`](plugins/context-tide/) | Shows the context window as a tide in the band above the prompt: a fill bar colored by phase, a sparkline of recent turns, the trend per turn and the turns left before compaction. | context window, tokens, compaction, band, usage |
| [`docker-containers`](plugins/docker-containers/) | A /docker pane showing `docker ps` (ID, image, command, created, status, ports, names), refreshed every 2 seconds while open; pick the Docker context, whether to include stopped containers and the interval in the plugin's settings | docker, containers, pane |
| [`focus-timer`](plugins/focus-timer/) | A focus timer in the band above the prompt: `/focus-timer` starts a block, the band counts it down with pause, skip and stop, a toast marks each switch, and every fourth break is a long one. | focus, pomodoro, timer, band, productivity |
| [`git-account-hint`](plugins/git-account-hint/) | When GitHub refuses a git command for the account it used, tells Claude which other `gh` accounts are signed in and how to run the command as one of them. | git, github, gh, push, permission denied, accounts, authentication |
| [`modal-containers`](plugins/modal-containers/) | A /modal pane listing your running Modal containers by app, with who launched each run and what it has cost. Pick the Modal environment in the plugin's settings; empty follows MODAL_ENVIRONMENT, then your modal profile (macOS/Linux) | modal, pane, integrations, cost |
| [`my-issues`](plugins/my-issues/) | A /issues pane of the open issues assigned to you across GitHub, Linear, Jira and monday.com; press an issue to put its key, title and link in your prompt | integrations, issues, pane, github, linear, jira, monday |
| [`render-deploys`](plugins/render-deploys/) | A /render-deploys pane of your recent Render deploys: state, service, environment, branch, commit, trigger, age and link, with the current git branch highlighted | pane, integrations, deployments, render |
| [`sensitive-paths`](plugins/sensitive-paths/) | Blocks Claude from reading secret-bearing files (.env, SSH keys, cloud credentials, and your own globs) through Read, Glob, Grep and, best effort, Bash; writing them is left alone | safety, guardrails, secrets, permissions |
| [`skill-trace`](plugins/skill-trace/) | A /skill-trace pane showing which skills loaded in this session, when, from which plugin, whether the model or you invoked them, and how large their instructions were | observability, skills, pane |
| [`sources`](plugins/sources/) | A /sources pane listing every web page Claude fetched or saw in search results this session, deduplicated by URL, with a button that inserts them as citations into your prompt | observability, web, citations, pane |
| [`tripwire`](plugins/tripwire/) | Holds a destructive Bash command (`rm -rf`, hard reset, force push, …) before it runs, shows what it would destroy, and waits for you to run it once, block it, or allow its rule for the session. | guard, safety, bash, rm -rf, force push, git reset, confirmation |
| [`vercel-deploys`](plugins/vercel-deploys/) | A /vercel-deploys pane of your recent Vercel deployments: state, environment, branch, commit, creator, age and URL, with the current git branch highlighted | pane, integrations, deployments, vercel |
| [`worktree-hud`](plugins/worktree-hud/) | Shows the current git worktree, branch and listening ports in the status line, and adds a `/worktrees` pane to review and clear finished worktrees. | git, worktree, status line, ports, cleanup |

Each mod's README says what it does, how to use it, and what it touches. The same list, with
categories and keywords, is machine-readable in
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json).

## Before you install one

Mods are **not sandboxed**: they run with the same access to your machine as Claude Code. To see
every event a mod hooks and everything it can reach, without running it:

```bash
claude plugin validate path/to/mod
```

To try a mod without installing it:

```bash
git clone https://github.com/Hula-Hoop-AI/supermods
claude --plugin-dir supermods/plugins/<mod-name>
```

## Contributing a mod

Open this repo in Claude Code and describe the mod you want. The
[`create-mod`](.claude/skills/create-mod/SKILL.md) skill scaffolds it under `plugins/<mod-name>/`,
writes its tests and README, and registers it in the marketplace. A mod is merged when it is:

- **Generic**: nothing specific to one machine, user or organization; anything tunable is a
  `userConfig` option.
- **Focused**: one job, with the fewest events and narrowest capabilities that do it.
- **Tested and verified**: these pass.
  ```bash
  claude plugin validate plugins/<mod-name> --strict
  claude plugin test plugins/<mod-name>
  claude plugin validate . --strict
  ```
- **Documented**: its README covers what it does, install, configuration, what it touches, and
  limitations.

A mod that sends data off the machine or loosens permission checks must say so in the first line
of its README.

## Reference

- [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview), with links to creating,
  events, interface, API, testing and troubleshooting
- [Manage mods for an organization](https://code.claude.com/docs/en/plugins/mods/admin)
- The exact API for your version: Claude Code writes it to
  `.claude-plugin/types/claude-code/index.d.ts` beside a mod when it loads it. Where the docs and
  that file disagree, trust the file.

## License

[MIT](LICENSE). A mod may declare a different license in its `plugin.json`.
