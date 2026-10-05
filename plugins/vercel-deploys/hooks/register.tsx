import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { DeployState, Snapshot } from '../types'
import { ApiError, deploymentsUrl, httpError, message, parseDeployments } from './vercel'

const PANE = 'vercel-deploys'
const COMMAND = 'vercel-deploys'
const MAX_DIR_DEPTH = 40
const SHA_LENGTH = 7
const MAX_MESSAGE = 60
const STATE_COLORS: Record<DeployState, string | undefined> = {
  building: 'yellow',
  ready: 'green',
  error: 'red',
  canceled: undefined, // drawn dim
}

const snapshot = atom({ plugin: 'vercel-deploys', key: 'snapshot' } as const, { deploys: [] } as Snapshot)
const watching = atom({ plugin: 'vercel-deploys', key: 'watching' } as const, [] as string[])

export type Config = {
  team: string
  project: string
  maxRows: number
  slowMs: number
  fastMs: number
  notify: boolean
}

const num = (v: PluginOptions[string] | undefined, fallback: number, min: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= min ? n : fallback
}

export function parseConfig(options: PluginOptions): Config {
  return {
    team: String(options.team ?? '').trim(),
    project: String(options.project ?? '').trim(),
    maxRows: Math.floor(num(options.max_rows, 15, 1)),
    slowMs: num(options.refresh_seconds, 60, 15) * 1000,
    fastMs: num(options.building_refresh_seconds, 10, 5) * 1000,
    notify: options.notify_on_finish === true,
  }
}

let config = parseConfig({}) // replaced by register; a settings change reloads the module
let timer: Timer | undefined
let inflight: Promise<Snapshot> | undefined

// ---- the workspace: current branch and Vercel link ----

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

const parentDir = (dir: string) => (dir === '/' ? undefined : dir.replace(/[\\/][^\\/]*$/, '') || '/')
const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)

export const branchFromHead = (head: string) => /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim()

type Workspace = { branch?: string; linkedProject?: string; linkedOrg?: string }

// Walks up from the session's directory for .git (a directory, or in a worktree a file naming
// its gitdir) and .vercel/project.json, reading files only: no git process.
async function detectWorkspace($: EngineInterface): Promise<Workspace> {
  const ws: Workspace = {}
  let gitFound = false
  let linkFound = false
  let dir: string | undefined = await $.session.cwd()
  for (let i = 0; dir && i < MAX_DIR_DEPTH && !(gitFound && linkFound); i++, dir = parentDir(dir)) {
    if (!linkFound) {
      const link = await readText($, `${dir}/.vercel/project.json`)
      if (link !== undefined) {
        linkFound = true
        try {
          const { projectId, orgId } = JSON.parse(link)
          ws.linkedProject = typeof projectId === 'string' ? projectId : undefined
          ws.linkedOrg = typeof orgId === 'string' ? orgId : undefined
        } catch {
          // a broken link file: fall back to the settings
        }
      }
    }
    if (!gitFound) {
      let head = await readText($, `${dir}/.git/HEAD`)
      if (head === undefined) {
        const gitdir = /^gitdir:\s*(.+)$/m.exec((await readText($, `${dir}/.git`)) ?? '')?.[1]?.trim()
        if (gitdir) head = await readText($, `${isAbsolute(gitdir) ? gitdir : `${dir}/${gitdir}`}/HEAD`)
      }
      if (head !== undefined) {
        gitFound = true
        ws.branch = branchFromHead(head)
      }
    }
  }
  return ws
}

// ---- fetching ----

async function fetchDeploys($: EngineInterface, ws: Workspace): Promise<Pick<Snapshot, 'deploys' | 'error' | 'note'>> {
  const token = await $.env.get('VERCEL_TOKEN')
  if (!token) return { deploys: [], error: 'VERCEL_TOKEN is not set' }
  const linked = !config.project && ws.linkedProject !== undefined
  // A personal account's orgId is a user id, which the API takes as no team at all.
  const linkedTeam = ws.linkedOrg?.startsWith('team_') ? ws.linkedOrg : undefined
  const url = deploymentsUrl({ team: config.team || linkedTeam, project: config.project || ws.linkedProject }, config.maxRows)
  try {
    let res
    try {
      res = await $.http.fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
    } catch (err) {
      throw new ApiError(`Vercel unreachable: ${message(err)}`)
    }
    if (!res.ok) throw httpError(res.status, res.text)
    let body
    try {
      body = JSON.parse(res.text)
    } catch {
      throw new ApiError('Vercel sent a response that is not JSON')
    }
    return { deploys: parseDeployments(body), note: linked ? 'project from .vercel/project.json' : undefined }
  } catch (err) {
    return { deploys: [], error: message(err) }
  }
}

// ---- refreshing ----

async function doRefresh($: EngineInterface): Promise<Snapshot> {
  const ws = await detectWorkspace($)
  const fetched = await fetchDeploys($, ws)
  const next: Snapshot = {
    ...fetched,
    deploys: fetched.deploys.sort((a, b) => b.createdAt - a.createdAt).slice(0, config.maxRows),
    branch: ws.branch,
    checkedAt: await $.clock.now(),
  }
  await update($, snapshot, () => next)
  return next
}

// One refresh at a time: a press during a poll waits for the poll's answer.
function refresh($: EngineInterface): Promise<Snapshot> {
  inflight ??= doRefresh($).finally(() => {
    inflight = undefined
  })
  return inflight
}

// Remembers the current branch's builds; with the pane closed, toasts the ones that finished.
async function settleWatch($: EngineInterface, snap: Snapshot, isOpen: boolean) {
  const before = new Set(await read($, watching))
  const onBranch = snap.branch ? snap.deploys.filter(d => d.branch === snap.branch) : []
  if (config.notify && !isOpen) {
    for (const d of onBranch) {
      if (!before.has(d.id)) continue
      if (d.state === 'ready') $.ui.toast(`${d.project} (${d.branch}) is ready on Vercel`)
      if (d.state === 'error') $.ui.toast(`${d.project} (${d.branch}) failed on Vercel`)
    }
  }
  const now = config.notify ? onBranch.filter(d => d.state === 'building').map(d => d.id) : []
  await update($, watching, () => now)
}

export const intervalMs = (snap: Snapshot, cfg: Config) =>
  snap.deploys.some(d => d.state === 'building') ? cfg.fastMs : cfg.slowMs

function schedule($: EngineInterface, snap: Snapshot) {
  timer?.cancel()
  timer = $.clock.after(intervalMs(snap, config), () => void poll($))
}

const isPaneOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

// Polls while the pane is open. Once it closes, polling stops, unless notify_on_finish has
// current-branch builds to watch; then it runs until they finish.
async function poll($: EngineInterface) {
  timer = undefined
  const isOpen = await isPaneOpen($)
  if (!isOpen && (await read($, watching)).length === 0) return
  const snap = await refresh($)
  await settleWatch($, snap, isOpen)
  if (!isOpen && (await read($, watching)).length === 0) return
  schedule($, snap)
}

async function refreshNow($: EngineInterface) {
  const snap = await refresh($)
  await settleWatch($, snap, true)
  schedule($, snap)
}

// ---- drawing ----

export function age(createdAt: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - createdAt) / 60_000))
  if (mins < 60) return `${mins}m`
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h`
  return `${Math.floor(mins / 1440)}d`
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export const register: Register = (on, options) => {
  config = parseConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show recent Vercel deployments in a pane' })
    // A reload (a settings change, a new version) drops the old timer but keeps the pane
    // open, or a watched build pending: pick polling back up.
    if ((await isPaneOpen($)) || (await read($, watching)).length) void poll($)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: 'Vercel deploys' })
    void refreshNow($)
    return { text: 'Vercel deploys pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const { deploys, error, note, branch, checkedAt } = await read($, snapshot)
    const now = checkedAt ?? 0
    const building = deploys.some(d => d.state === 'building')

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>
            Vercel deploys
            {branch && <Text dimColor> · on </Text>}
            {branch && <Text color="cyan">{branch}</Text>}
          </Text>
          <Button key="refresh" onPress={() => void refreshNow($)}>
            Refresh
          </Button>
        </Box>
        {error && <Text color="red">{error}</Text>}
        {!error && note && <Text dimColor>{note}</Text>}
        {checkedAt === undefined && <Text dimColor>Checking…</Text>}
        {checkedAt !== undefined && !error && deploys.length === 0 && <Text dimColor>No deployments found.</Text>}
        {deploys.map(d => {
          const mine = branch !== undefined && d.branch === branch
          const color = STATE_COLORS[d.state]
          return (
            <Box flexDirection="column">
              <Text>
                <Text color="cyan">{mine ? '› ' : '  '}</Text>
                <Text color={color} dimColor={!color} bold={d.state !== 'canceled'}>
                  {d.state.padEnd(8)}
                </Text>{' '}
                {d.project} <Text dimColor>{d.env}</Text>
                {d.branch && (
                  <Text color={mine ? 'cyan' : undefined} bold={mine}>
                    {' '}
                    {d.branch}
                  </Text>
                )}
                {d.sha && <Text dimColor> {d.sha.slice(0, SHA_LENGTH)}</Text>}
                {d.creator && <Text color="magenta"> {d.creator}</Text>}
                <Text dimColor> {age(d.createdAt, now)} ago</Text>
              </Text>
              {(d.message || d.url) && (
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>{'    '}{d.message ? truncate(d.message, MAX_MESSAGE) : ''}</Text>
                  {d.url && <Link href={d.url} />}
                </Box>
              )}
            </Box>
          )
        })}
        {checkedAt !== undefined && (
          <Text dimColor>
            updated {new Date(checkedAt).toLocaleTimeString()} · next in{' '}
            {Math.round((building ? config.fastMs : config.slowMs) / 1000)}s{building ? ' (building)' : ''}
          </Text>
        )}
      </Box>
    )
  })
}
