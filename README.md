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
| [`git-account-hint`](plugins/git-account-hint/) | When GitHub refuses a git command for the account it used, tells Claude which other `gh` accounts are signed in and how to run the command as one of them. | git, github, gh, push, permission denied, accounts, authentication |
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
