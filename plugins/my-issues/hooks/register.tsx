import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpInit, PluginOptions, Register, Timer, UiPressArgument } from 'claude-code'

import type { Issue, ProviderId, ProviderResult, Snapshot } from '../types'
import {
  DEFAULT_JQL, LINEAR_QUERY, LINEAR_URL, MONDAY_API_VERSION, MONDAY_URL, NotConfigured, PROVIDERS, TIMEOUT_MS,
  byUpdatedDesc, clip, errorText, githubArgv, graphql, jiraMissing, jiraUrl, message, mondayBoardsQuery,
  mondayBoardsWithPeople, mondayItemsQuery, parseGithub, parseJira, parseLinear, parseMonday,
} from './providers'
import type { GhRow, Json, Settings } from './providers'

const PANE = 'my-issues'
const COMMAND = 'issues'
const DEFAULT_LIMIT = 20
const DEFAULT_REFRESH_MIN = 5
const LABEL: Record<ProviderId, { name: string; color: string }> = {
  github: { name: 'GitHub', color: 'white' },
  linear: { name: 'Linear', color: 'magenta' },
  jira: { name: 'Jira', color: 'blue' },
  monday: { name: 'monday.com', color: 'yellow' },
}

const snapshot = atom({ plugin: 'my-issues', key: 'snapshot' } as const, { results: [] } as Snapshot)

let timer: Timer | undefined
let inFlight: Promise<void> | undefined
let opts: PluginOptions = {}

const str = (key: string) => String(opts[key] ?? '').trim()
const num = (key: string, fallback: number) => {
  const n = Number(opts[key])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}
const refreshMs = () => num('refresh_minutes', DEFAULT_REFRESH_MIN) * 60_000

/** The settings, then the env var: a secret set in the plugin's settings wins over the environment. */
async function settings($: EngineInterface): Promise<Settings> {
  // $.env.get takes literal names, so the variables this mod reads are listed by `validate`.
  const pick = (key: string, env: Promise<string | undefined>) => env.then(v => str(key) || (v ?? '').trim())
  const [linearKey, jiraBaseUrl, jiraEmail, jiraToken, mondayToken] = await Promise.all([
    pick('linear_api_key', $.env.get('LINEAR_API_KEY')),
    pick('jira_base_url', $.env.get('JIRA_BASE_URL')),
    pick('jira_email', $.env.get('JIRA_EMAIL')),
    pick('jira_api_token', $.env.get('JIRA_API_TOKEN')),
    pick('monday_api_token', $.env.get('MONDAY_API_TOKEN')),
  ])
  return {
    enabled: {
      github: opts.github !== false,
      linear: opts.linear !== false,
      jira: opts.jira !== false,
      monday: opts.monday !== false,
    },
    limit: num('limit', DEFAULT_LIMIT),
    githubScope: str('github_scope'),
    linearKey,
    jiraBaseUrl,
    jiraEmail,
    jiraToken,
    jiraJql: str('jira_jql') || DEFAULT_JQL,
    mondayToken,
    mondayBoards: str('monday_boards'),
  }
}

/** Fetches JSON with a timeout; non-2xx and GraphQL `errors` become thrown messages. */
async function fetchJson($: EngineInterface, url: string, init: HttpInit): Promise<Json> {
  let timeoutTimer: Timer | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutTimer = $.clock.after(TIMEOUT_MS, () => reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)))
  })
  try {
    const res = await Promise.race([$.http.fetch(url, init), timeout])
    if (!res.ok) {
      const detail = errorText(res.text)
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    const body = JSON.parse(res.text) as Json
    if (Array.isArray(body.errors) && body.errors.length) throw new Error(errorText(res.text))
    return body
  } finally {
    timeoutTimer?.cancel()
  }
}

async function fetchGithub($: EngineInterface, s: Settings): Promise<Issue[]> {
  const runs = await Promise.all(
    githubArgv(s.githubScope, s.limit).map(async argv => {
      const run = await $.process.run(argv, { timeoutMs: TIMEOUT_MS }).catch(() => {
        throw new NotConfigured('gh CLI not found: install it from https://cli.github.com')
      })
      if (run.exitCode !== 0) {
        if (/auth login|not logged in/i.test(run.stderr)) throw new NotConfigured('gh is not logged in: run gh auth login')
        throw new Error(clip(run.stderr.trim().split('\n').pop() || `gh exited ${run.exitCode}`))
      }
      return parseGithub(JSON.parse(run.stdout) as GhRow[])
    }),
  )
  const seen = new Set<string>()
  return runs.flat().filter(i => !seen.has(i.url) && !!seen.add(i.url))
}

async function fetchLinear($: EngineInterface, s: Settings): Promise<Issue[]> {
  if (!s.linearKey) throw new NotConfigured('set LINEAR_API_KEY (or the Linear API key setting)')
  const body = await fetchJson($, LINEAR_URL, {
    method: 'POST',
    // A personal API key goes in as-is (no "Bearer"), as Linear documents.
    headers: { 'Content-Type': 'application/json', Authorization: s.linearKey },
    body: graphql(LINEAR_QUERY, { first: s.limit }),
  })
  return parseLinear(body)
}

async function fetchJira($: EngineInterface, s: Settings): Promise<Issue[]> {
  const missing = jiraMissing(s)
  if (missing.length) throw new NotConfigured(`set ${missing.join(', ')} (or the Jira settings)`)
  const base = s.jiraBaseUrl.replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) throw new Error(`the Jira site URL must start with https://, got ${clip(base, 60)}`)
  const body = await fetchJson($, jiraUrl(base, s.jiraJql, s.limit), {
    headers: { Accept: 'application/json', Authorization: `Basic ${btoa(`${s.jiraEmail}:${s.jiraToken}`)}` },
  })
  return parseJira(base, body)
}

async function fetchMonday($: EngineInterface, s: Settings): Promise<Issue[]> {
  if (!s.mondayToken) throw new NotConfigured('set MONDAY_API_TOKEN (or the monday.com API token setting)')
  const init = (query: string): HttpInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: s.mondayToken, 'API-Version': MONDAY_API_VERSION },
    body: graphql(query),
  })
  const boards = mondayBoardsWithPeople(await fetchJson($, MONDAY_URL, init(mondayBoardsQuery(s.mondayBoards))))
  if (!boards.length) return []
  return parseMonday(boards, await fetchJson($, MONDAY_URL, init(mondayItemsQuery(boards, s.limit))))
}

/** One provider, never rejecting: its failure becomes its own line in the pane. */
async function fetchProvider($: EngineInterface, provider: ProviderId, s: Settings): Promise<ProviderResult> {
  try {
    let issues: Issue[]
    if (provider === 'github') issues = await fetchGithub($, s)
    else if (provider === 'linear') issues = await fetchLinear($, s)
    else if (provider === 'jira') issues = await fetchJira($, s)
    else issues = await fetchMonday($, s)
    return { provider, issues: issues.sort(byUpdatedDesc).slice(0, s.limit) }
  } catch (err) {
    if (err instanceof NotConfigured) return { provider, issues: [], notConfigured: err.message }
    return { provider, issues: [], error: message(err) || 'failed' }
  }
}

/** Fetches every enabled provider in parallel; a refresh asked for while one runs joins it. */
function refresh($: EngineInterface): Promise<void> {
  inFlight ??= (async () => {
    await update($, snapshot, s => ({ ...s, isRefreshing: true }))
    const s = await settings($)
    const results = await Promise.all(PROVIDERS.filter(p => s.enabled[p]).map(p => fetchProvider($, p, s)))
    await update($, snapshot, () => ({ results, checkedAt: Date.now() }))
  })().finally(() => {
    inFlight = undefined
  })
  return inFlight
}

function stopPolling() {
  timer?.cancel()
  timer = undefined
}

function startPolling($: EngineInterface) {
  stopPolling()
  void refresh($)
  timer = $.clock.every(refreshMs(), async () => {
    if (!(await $.ui.panes()).some(p => p.id === PANE)) return stopPolling()
    await refresh($)
  })
}

const reference = (i: Issue) => `${i.key}: ${i.title} ${i.url}`

/** Puts the issue in the prompt box; where there is none (a desktop composer), copies it instead. */
async function insert($: EngineInterface, issue: Issue, press: UiPressArgument) {
  const text = reference(issue)
  const filled = await $.prompt.fill({ text: `${text} `, mode: 'insert' })
  if (filled.isFilled) return
  const copied = await $.ui.copy({ text, surface: press.surface })
  $.ui.toast(copied.isCopied ? `Copied ${issue.key} to the clipboard` : `Could not insert ${issue.key}`)
}

function age(iso: string | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return ''
  const mins = Math.max(0, Math.floor((now - t) / 60_000))
  if (mins < 60) return `${mins}m`
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h`
  if (mins < 14 * 1440) return `${Math.floor(mins / 1440)}d`
  return `${Math.floor(mins / 10_080)}w`
}

export const register: Register = (on, options) => {
  opts = options

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show the open issues assigned to you' })
    // A reload (a settings change, a new version) drops the old timer but keeps the pane open.
    if ((await $.ui.panes()).some(p => p.id === PANE)) startPolling($)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: 'My issues' })
    startPolling($)
    return { text: `My issues pane opened (refreshes every ${refreshMs() / 60_000} min).` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    stopPolling()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const { results, checkedAt, isRefreshing } = await read($, snapshot)
    const total = results.reduce((n, r) => n + r.issues.length, 0)
    const now = Date.now()

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>
            {checkedAt === undefined ? 'Loading your issues…' : `${total} open issue${total === 1 ? '' : 's'} assigned to you`}
          </Text>
          <Button key="refresh" onPress={() => void refresh($)}>
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </Box>
        {checkedAt !== undefined && results.length === 0 && (
          <Text dimColor>Every provider is turned off in this plugin's settings.</Text>
        )}
        {results.map(r => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={LABEL[r.provider].color}>
              {LABEL[r.provider].name}
              <Text dimColor> {r.error || r.notConfigured ? '' : `(${r.issues.length})`}</Text>
            </Text>
            {r.notConfigured && <Text dimColor>  not configured: {r.notConfigured}</Text>}
            {r.error && <Text color="red">  {r.error}</Text>}
            {!r.error && !r.notConfigured && r.issues.length === 0 && <Text dimColor>  nothing open</Text>}
            {r.issues.map(i => (
              <Box flexDirection="row" gap={1}>
                <Text> </Text>
                <Button key={`insert:${r.provider}:${i.key}`} plain onPress={press => void insert($, i, press)}>
                  {i.key}
                </Button>
                <Text wrap="truncate-end">
                  {i.title}
                  {i.status && <Text color="cyan"> {i.status}</Text>}
                  {i.priority && <Text color="yellow"> {i.priority}</Text>}
                  {i.context && <Text dimColor> {i.context}</Text>}
                  <Text dimColor> {age(i.updatedAt, now)}</Text>
                </Text>
                <Link href={i.url} label="open" />
              </Box>
            ))}
          </Box>
        ))}
        {checkedAt !== undefined && (
          <Box marginTop={1}>
            <Text dimColor>
              updated {new Date(checkedAt).toLocaleTimeString()} · every {refreshMs() / 60_000} min · press an
              issue's key to put it in the prompt
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
