# Claude Code mods: the landscape

Last refreshed: 2026-10-06. Refresh when older than a month (see SKILL.md step 3).
Coverage gaps on this refresh: Reddit blocked fetches; two X articles (nateherk) returned 402;
Hacker News threads on mods had almost no comments.

## What the API reaches (docs, `https://code.claude.com/docs/en/plugins/mods/<page>.md`)

Surfaces: `Pane` (sidebar or framed region, opened with `$.ui.open`), `AbovePrompt` band (shared
by all mods), `PromptHint` hint line, `$.ui.status` (one line under the prompt), `$.ui.toast`,
`$.ui.log`, `$.ui.ask`, restyling of engine-drawn sites (`UserMessage`, `AssistantMessage`,
`ToolUse`, `ToolResult`, `Spinner`, `TurnDuration`…), `$.command.register`, `$.tool.register`.
The permission prompt is not a render site. Nothing draws in the VS Code panel, `claude -p` or
cloud; hooks still run there.

Events worth matching to a user's habit: `tool.call` (deny, answer or rewrite; fires for MCP and
subagent tools), `tool.check`, `prompt.submit`, `prompt.edit` (50 ms), `turn.step` (can swap
model or effort, read usage), `turn.complete`, `session.compact` (`{skip}`), `session.start`
(not after `/clear`, `/resume`), `agent.spawn`, `command.run`, `classic.<SettingsHookEvent>`.

Capabilities: `$.fs`, `$.process.run(argv)` (no shell), `$.http.fetch`, `$.model.complete |
fork | classify`, `$.state` (per session), `$.store` (across sessions, 4 MiB), `$.clock`,
`$.session.usage()` (context %, rate limits, cost), `$.mcp.call`, `$.prompt.submit`,
`$.turn.abort`, `$.audio`. Limits: 10 s per hook, redraws 10/s, auto-opened panes need ≥144
columns, one test ≤5 s.

## Mods people have published (dedupe against these)

Catalogs: karanb192/awesome-claude-code-mods (2,685 scanned; browse at mods.aidojo.si),
whyashthakker/awesome-claude-code-mods (70 panes), claudemods.ai (45 curated),
stashbase.ai/blog/best-claude-code-mods, OneWave-AI/claude-code-mods, Anthropic samples at
github.com/anthropics/claude-code-playground/tree/main/claude-code/mods and
github.com/anthropics/claude-code/tree/main/mods (diff, agents-md, sec-default, telemetry,
you-should-know).

| Theme | Examples (name: purpose, surface) | Source |
|---|---|---|
| Context and cost | token-weather (forecast + sparkline, band); cctop (btop-style dashboard, pane); context-lens, quota-meter, token-ledger (status line); usage-band (band); cache-meter (cache TTL with keep-warm, band); context-bar (context by category, band); context-gauge (compaction snapshots, status); wavy-usage (desktop rings); burn-meter (spend) | anthropics/claude-code-playground; tomstagl/cctop; Arunjay4213/claude-mods; cmbaldwin/claude-usage-band; CodyEngel/claude-mods; hamzafer/claude-code-mods; bennewton999/claude-code-mods; BatuhanCakmakk/wavy-usage; OneWave-AI/claude-code-mods |
| Risky commands | blast-radius (hold rm -rf, reset --hard, force push; Proceed/Cancel); launch-codes (one-time code before risky Bash); scope-guard, merge-gate, deploy-verify; secret-redactor, honmoon-redact, topic-filter (redact before the model reads) | anthropics/claude-code-playground; OneWave-AI; yash-gadodia/claude-mods; ray-amjad/awesome-claude-code-function-hooks; pleaseai/honmoon; lperezmo/topic-filter-mod |
| Git, PRs, CI, deploys | pr-monitor, pr-pulse, cc-pr-tracker (open PRs, merge readiness, checks); gh-ci-status (Actions above prompt); vercel-deploy-status; ship-tracker (PR to prod); review-watch; Worktree Map, Conflict Radar, Staged Review (panes) | CodyEngel/claude-mods; gerricchaplin/pr-pulse; sezaakgun/cc-pr-tracker; diegorv/claude-functions-hook; ray-amjad; bennewton999; hamzafer; whyashthakker |
| Agents and visibility | agent-flow (subagent tree); claude-flightdeck; whats-agent-doing (explains each step, band); agentpane, statuspane; session-fleet (all sessions); mission-control; inner-monologue, agent-narrator, sportscaster | Charlie0113-T/claude-agent-flow; scasella/claude-flightdeck; tzafrir/whats-agent-doing; xuanji86; bennewton999; hamzafer; OneWave-AI |
| Memory and compaction | lcm (lossless context, DAG); micro-compaction; agent-compact-advisor; segmem, kindex, commonplace, storybloq (scoped memory); session-hygiene (handoff cards); pinboard, mokkan (decisions, todos) | lossless-claude/lcm; ruihe774/cc-micro-compaction; apolenkov; mahuebel/segmem; wandercom/kindex; noopz/commonplace; bennewton999; sirkitree/pinboard; vicmpen/mokkan |
| Reading and editing | terminal-browser (3.6k★, browser pane); mdview, md-preview, gfm-render, claude-mermaid, tex-display; review-pane (diff with line comments); buffer-pane, md-prompt; aside (tool-less side chat); claude-review | zenbu-labs/terminal-browser; xuanji86; hamzafer; briangtn; galElmalah; samox73; rudrasecure/claude-mods; meganemura; nogu66; JayDoubleu/aside; r3al1tym |
| Integrations | github-issues (cards pane); inbox-alerts (Gmail, Slack toasts); now-playing (Spotify); ts-band (Tailscale); claude-council, agent-council (multi-model review) | MarcoCarnevali/claude-code-mods; OneWave-AI; hamzafer; hoobnn/hoobnn-agent-mods; danzerzine; apolenkov |
| Prompting | next-steps (Haiku suggestions, band); prompt-spellcheck; effort-cycle; autotel (OpenTelemetry) | pawandeepdhall/claude-mods; ljmerza; Anerco; jagreehal/autotel |
| Fun and wellness | code-pet, boss-fight, session-wrapped, Mindful-Claude, cc-arcade, claude-games, intermission (Doom), terminal-gym, nibbl, clawd-tales, claude-pokemon, combo-meter | OneWave-AI; halluton; sezaakgun; mohi-devhub; jarrodwatts; DrumAndCode; nuromirzak; plaxagoras; dgokcin; SARTHAK2511 |

The scanned catalog's dominant pattern is "tighten-only" tool guards and write guards that keep
secrets out of memory (mods.aidojo.si).

## What people ask for

- Audio alerts for long turns; `.env` write guards; a session-summary command; a toast when
  tool-call volume is unusual (nandigamharikrishna.substack.com/p/i-built-mods-for-claude-heres-what).
- A context bar by category (system prompt, tools, MCP, agents, memory, skills); an agent
  sidebar with one-click activation; PII masking until interaction; cross-model routing
  (postcutoff.com/e/2026-10-01-claude-code-mods/).
- CI and run status inside the session instead of switching windows; "pane vs band vs status
  line vs no mod" is a live design question (github.com/henkisdabro/sandcastle-kit/issues/116,
  github.com/stealth-factory/opscope/issues/320).
- Capability declarations like browser-extension permissions, verified publishers, a stable API
  with deprecation periods (remio.ai/post/claude-code-mods-arrive-but-custom-ui-comes-with-full-machine-access,
  dev.to/max_quimby/claude-code-mods-just-turned-agents-into-a-platform-5gc0).

## Pains people mention

- Visibility: "I never know anymore what it's up to" (news.ycombinator.com/item?id=49934165);
  can't tell what each of five sessions is doing (benenewton.com/blog/five-claude-code-mods-session-visibility).
- Compaction loses state; repetitive `/context` checks (benenewton; dev.to hamza_zafar).
- Cost surprises from forks and supervisors (OneWave README; app.stationx.net/articles/claude-code-mods).
- Several sessions in one worktree collide; deploys die silently (benenewton).
- Trust: a mod can read secrets and send them anywhere; `plugin details` shows zero hooks for
  function-hook mods; denying `Read(.env)` does not stop a mod reading it
  (pluto.security/blog/claude-code-function-hooks-security/, stashbase).
- Hooks that throw fail quietly; validate and headless tests missed real bugs (onewave-ai.com/blog/claude-code-mods, benenewton).
- Nothing draws in VS Code, `claude -p` or cloud; mods don't get `prompt_cache` the status-line
  command gets (explainx.ai, cmbaldwin/claude-usage-band).
- API churn: "this surface may change between releases"; serial hook latency, eight 300 ms
  hooks cost 2.4 s (vanja.io/claude-mods/).
- Adoption: "for the majority of users a mod seems a step too far" (charliehills.substack.com/p/claude-code-mods).

## Best practices people recommend

- Lightest tool first: an instruction, a setting or status line, a hook, then a mod (stationx).
- Decide deny before `await next(e)`; `.catch()` on every blocking hook; stay under 10 s; keep
  injected prompt text byte-stable for the cache (agricidaniel.com/blog/claude-code-mods-guide).
- Run it in real sessions before calling it done; write mods straight into their permanent
  folder (benenewton).
- Fixed argv only, never a shell string; pure logic in separate files for plain tests; guard
  `Raster`, `Image`, `Client` by `e.surface`; `$.ui.blit` for animation
  (gist.github.com/ruvnet/a485e930b148185197fc53fd38b429ea).
- Single-width Unicode in bands, no emoji; degrade at narrow widths
  (claude.dev/blog/getting-started-with-claude-code-mods/).
- Opt-in panes beat auto-opening; bound persisted data (trim at ~200 entries) (nandigamharikrishna).
- Minimize capabilities; avoid `$.http.fetch` together with `$.process.run`; document every
  capability (pluto.security). Installers read `claude plugin validate` output and pin SHAs
  (stashbase, threatfrontier.com/articles/claude-code-mods-unsandboxed-plugins-on-by-default).
