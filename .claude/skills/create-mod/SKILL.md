---
name: create-mod
description: Use when creating, porting, or polishing a Claude Code mod for the supermods repo — scaffolds it under plugins/<name>/, makes it generic and configurable, tests it on every surface, registers it in the marketplace, and leaves it ready to commit.
---

# Create a mod for supermods

## What this repo is

supermods aims to be the most-used collection of Claude Code **mods**: TypeScript modules that
hook Claude Code's internal events (tool calls, prompts, turns, renders, commands) and change
what happens, or draw their own UI. Mods ship inside plugins. This repo is a plugin
**marketplace**, so anyone can install any mod with:

```
/plugin marketplace add Hula-Hoop-AI/supermods
/plugin install <mod-name>@supermods
```

Every mod here is written for strangers. If a mod only works on its author's machine, it does
not belong here. The bar is: **generic, configurable, tested, and small.**

## Sources of truth (read before writing code)

The mods API is early access and changes between Claude Code releases. **Never write API calls
from memory.** Check every event name, field, and `$` method against:

1. `plugins/<name>/.claude-plugin/types/claude-code/index.d.ts`: written by the engine the first
   time the mod loads (step 3). It is the exact contract for the installed version, and the
   header comment explains the module environment.
2. The docs: https://code.claude.com/docs/en/plugins/mods/overview.md, then `create`, `events`,
   `interface`, `api`, `test`, `troubleshoot`, `reference` (same path, `.md`).
3. The built-in `/plugin-authoring` skill covers general mechanics. This skill adds the repo's
   conventions and quality bar on top.

If the types and the docs disagree, the types win.

## Workflow

### 1. Pin down the mod's purpose

- State in one sentence what the mod does and for whom. If it's vague, ask the user.
- Check `.claude-plugin/marketplace.json` and `plugins/`. If an existing mod overlaps, extend
  it instead of adding a near-duplicate.
- Name it after its slash command, in kebab-case: the directory, the plugin name and the
  command are the same word (`plugins/tide/` installs as `tide` and adds `/tide`). A mod without
  a command does not belong here.
- Pick its `category` for the marketplace entry and the README heading: `observability`
  (systems outside the session), `session` (the agent loop itself), `git`, `work` or `fun`.
  The category is metadata only; it is not part of the path.
- Several views of one kind of thing are one mod, not several: a provider or tab per view,
  picked by the command's argument (`/observe docker`, `/trace sources`). Add a provider to the
  existing mod (`observe/hooks/providers/`, `trace/hooks/recorders/`) before starting a new one.

### 2. Design it to be generic

| Don't | Do |
|---|---|
| Hard-coded paths, usernames, org names, repos, URLs | Read them from the plugin's `userConfig` options or env vars, with sensible defaults |
| Assume one tool, one CLI, or one language stack | Use matchers (`{ tool: [...] }`, regex) taken from config; fall back cleanly when a CLI is missing |
| Target only the terminal | Render correctly on `terminal` and `desktop` at minimum, and test each one |
| Fail loudly or silently | Turn failures into short, visible messages (a toast, a pane line, or a `deny` reason) and keep Claude Code working |
| Reach for network, fs, or process when not needed | Use the narrowest capability. Every capability is listed by `claude plugin validate`, and users read that list before they trust a mod |
| Do several jobs in one mod | One mod, one job. Split mods that do unrelated things |
| Keep state in module variables that must survive reloads | Use `$.state` atoms for session state (survives hot reload) and `$.store` for state that persists across sessions |

Before writing, list which events the mod hooks and why each one is needed. A good mod hooks as
few events as possible.

### 3. Scaffold

```
plugins/<name>/
├── .claude-plugin/
│   └── plugin.json
├── hooks/
│   ├── hooks.json          # { "modules": ["./register.ts"] }
│   └── register.ts(x)      # export const register: Register = (on, options) => { ... }
├── types/index.d.ts        # only if the mod uses $.state (PluginState) or exports a $ noun
├── tests/<name>.test.ts(x)
└── README.md
```

`plugin.json`:

```json
{
  "name": "<name>",
  "version": "0.1.0",
  "description": "<one sentence, user-facing>",
  "author": { "name": "<from git config user.name>" },
  "license": "MIT",
  "keywords": ["mod", "<area>"]
}
```

Add `"types": "./types/index.d.ts"` only when that file exists. Add `userConfig` for every value
a user might want to change, and look up its exact schema in the docs.

To load the mod with hot reload, which also generates `.claude-plugin/types/`, run:

```
claude --plugin-dir plugins/<name>
```

Generated files under `.claude-plugin/types/` are git-ignored. Never edit or commit them.

### 4. Code quality rules

- TypeScript, `strict`. Type `register` as `Register` from `'claude-code'`. No `any` and no
  `as never` outside tests.
- The module environment has no Node and no DOM. Use ES `import` for plugin files and
  `'claude-code'` only. No `require`, no dynamic `import()`, no npm dependencies.
- Use event names as string literals: `on('tool.call', ...)`.
- Every hook either `return next(e)` (observe), `return next({ ...e, ... })` (rewrite), or
  returns an answer (`{ result }`, `{ deny }`, `{ text }`). Never drop `next` by accident: a hook
  that forgets it silently blocks every plugin beneath it.
- Respect the limits: hooks get 10s (`prompt.edit` gets 50ms). Keep the hot path cheap and push
  slow work to `$.clock`. Stop timers you start, for example when a pane closes.
- Pass `$` only to top-level functions declared in the hooks module's own file: `validate`
  does not follow `$` across an import or through a method. Other files stay pure (parsing,
  formatting, shaping rows) or take plain functions the hooks module binds to `$` (see
  `observe/hooks/io.ts`). `$.env.get` takes a literal name.
- A pane with tabs is drawn with `tabPane` from `hooks/tab-pane.tsx`, so every tabbed mod has
  the same layout: tabs, a summary line with actions, rows, a footer. The canonical file is
  `shared/tab-pane.tsx`; copy it in with `shared/sync.sh` and never edit a copy
  (`shared/sync.sh --check` fails on drift). Fit new data into its `PaneModel` and `Row`
  before changing the layout for every mod.
- `types/index.d.ts` must be self-contained: no imports.
- Name constants at the top of the file. Comment only the non-obvious *why*.
- Mods are not sandboxed. Never send user data anywhere the README doesn't state. Never log
  secrets. Never weaken permission checks unless that is the mod's whole stated purpose, and
  then say so in the first line of the README.

### 5. Test

Write `tests/<name>.test.ts(x)` with `claude-code/testing`. Cover:

- the main path, end to end through the events the mod hooks;
- each failure path: missing CLI, non-zero exit, empty data, denied permission;
- every config option that changes behavior;
- UI on `terminal` and `desktop`. Loop over surfaces as in the docs. Find elements by `key`
  and drive them with `ui.press` and `ui.input`.

Stub every external noun (`process.run`, `http.fetch`, `fs.read`, `model.complete`) with
`on(...)` or `mock.*`. Tests must never touch the real machine or network.

### 6. Verify (all of these must pass)

```bash
claude plugin validate plugins/<name> --strict   # manifest + hooks; review the capability list it prints
claude plugin test plugins/<name>                # all tests green
npx -y -p typescript tsc -p plugins/<name>       # no type errors (after the types were generated in step 3)
shared/sync.sh --check                              # only for a mod that carries hooks/tab-pane.tsx
```

Then try it for real with `claude --plugin-dir plugins/<name>` and exercise the main path once.
Report to the user what you ran and what happened. Don't claim it works without this step.

### 7. Register and document

Add an entry to `.claude-plugin/marketplace.json` `plugins`:

```json
{ "name": "<name>", "source": "./plugins/<name>", "description": "<same as plugin.json>", "version": "0.1.0", "category": "<category>", "keywords": ["<area>"] }
```

Run `claude plugin validate . --strict` from the repo root. The marketplace entry and
`plugin.json` must agree.

Write `plugins/<name>/README.md` with these sections:

1. **What it does.** One or two sentences, plus a screenshot or example output if the mod has UI.
2. **Install.** The `/plugin install <name>@supermods` line.
3. **Configuration.** A table of every `userConfig` option and env var: name, default, effect.
4. **What it touches.** The events it hooks and the capabilities it uses (fs, process, network,
   model), copied from the `validate` output. Users decide whether to trust the mod from this
   section.
5. **Limitations.** Anything that's known not to work.

### 8. Stop at ready-to-commit

Show the user the file tree, the verification output, and a suggested commit message
(`feat(<name>): <what it does>`). Don't commit, tag, or push unless the user says so. For a
release, run `claude plugin tag plugins/<name>`, which creates `<name>--v<version>`.

## Final checklist

- [ ] One clear job; no duplicate of an existing mod
- [ ] Nothing user- or machine-specific is hard-coded; everything tunable is in `userConfig`
- [ ] Fewest events and narrowest capabilities that do the job
- [ ] Every hook calls `next` or answers on purpose
- [ ] Failures are visible and never break Claude Code
- [ ] Tests cover the main path, failure paths, config options, and both surfaces
- [ ] `validate --strict`, `plugin test`, and `tsc` all pass; tried live once
- [ ] Marketplace entry added and versions match
- [ ] README has all five sections
