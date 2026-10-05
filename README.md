# supermods

**A marketplace of mods for Claude Code.** A mod is a small TypeScript module that runs inside
Claude Code: it can watch, rewrite or answer tool calls, prompts and turns, draw panes and
status lines, and add slash commands. Mods need Claude Code v2.1.287 or later.

```
/plugin marketplace add Hula-Hoop-AI/supermods
/plugin install <mod-name>@supermods
```

## Mods

### Session: the agent loop itself

| Mod | What it does | Search words |
|---|---|---|
| [`agent-debugger`](plugins/session/agent-debugger/) | A step debugger for the agent loop: pause at prompts, model requests, responses, tool calls and results; inspect and edit them; play, step, stop, or re-run from an earlier event. | debugger, breakpoints, step, pause, inspect, tool calls, re-run, rewind |
| [`context-tide`](plugins/session/context-tide/) | Band above the prompt that shows the context window as a tide: a fill bar, the trend per turn, a sparkline of recent turns and how many turns are left before compaction. | context window, tokens, compaction, band, usage |
| [`trace`](plugins/session/trace/) | A /trace pane with two tabs: the skills that loaded this session (when, from where, who invoked them, how large) and the web pages Claude fetched or saw in search results, ready to insert as citations | observability, skills, web, citations, pane |

### Observability: systems outside the session

| Mod | What it does | Search words |
|---|---|---|
| [`observe`](plugins/observability/observe/) | An /observe pane with a tab per provider: Docker containers, Modal containers and their cost, and Render and Vercel deploys with the current git branch highlighted. `/observe docker|modal|render|vercel` opens it on that tab | observability, pane, docker, containers, modal, cost, render, vercel, deployments |

### Safety

| Mod | What it does | Search words |
|---|---|---|
| [`guard`](plugins/safety/guard/) | Holds destructive Bash commands until you run, block or allow them, and blocks Claude from reading secret-bearing files (.env, SSH keys, cloud credentials, your own globs). | guard, safety, guardrails, bash, rm -rf, force push, git reset, confirmation, secrets, permissions |

### Git

| Mod | What it does | Search words |
|---|---|---|
| [`ci-beacon`](plugins/git/ci-beacon/) | Status line with the latest GitHub Actions run for the current branch, refreshed on a timer and after each turn, with a toast when a run finishes. | ci, github actions, gh, status line, workflow |
| [`git-account-hint`](plugins/git/git-account-hint/) | When GitHub refuses a git command for the account it used, tells Claude which other gh accounts are signed in and how to run the command as one of them. | git, github, gh, push, permission denied, accounts, authentication |
| [`worktree-hud`](plugins/git/worktree-hud/) | Status line with the current git worktree, branch and listening ports, and a /worktrees pane to review and clear finished worktrees. | git, worktree, status line, ports, cleanup |

### Work

| Mod | What it does | Search words |
|---|---|---|
| [`focus-timer`](plugins/work/focus-timer/) | A focus timer in the band above the prompt: /focus-timer starts a block, the band counts it down with pause, skip and stop buttons, a toast marks each switch, and every fourth break is a long one. | focus, pomodoro, timer, band, productivity |
| [`my-issues`](plugins/work/my-issues/) | A /issues pane of the open issues assigned to you across GitHub, Linear, Jira and monday.com; press an issue to put its key, title and link in your prompt | integrations, issues, pane, github, linear, jira, monday |

### Fun

| Mod | What it does | Search words |
|---|---|---|
| [`code-garden`](plugins/fun/code-garden/) | A plant in the band above the prompt that grows with every tool call and finished turn, wilts when a tool fails, and keeps growing across sessions. | fun, plant, companion, band, progress |

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
claude --plugin-dir supermods/plugins/<category>/<mod-name>
```

## Contributing a mod

Open this repo in Claude Code and describe the mod you want. The
[`create-mod`](.claude/skills/create-mod/SKILL.md) skill scaffolds it under `plugins/<category>/<mod-name>/`,
writes its tests and README, and registers it in the marketplace. A mod is merged when it is:

- **Generic**: nothing specific to one machine, user or organization; anything tunable is a
  `userConfig` option.
- **Focused**: one job, with the fewest events and narrowest capabilities that do it.
- **Tested and verified**: these pass.
  ```bash
  claude plugin validate plugins/<category>/<mod-name> --strict
  claude plugin test plugins/<category>/<mod-name>
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
