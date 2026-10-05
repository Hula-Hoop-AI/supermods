import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { Deploy, DeployState, Service, Snapshot } from '../types'
import {
  ApiError,
  buildingServiceIds,
  deploysUrl,
  httpError,
  message,
  parseDeploys,
  pickServices,
  servicesUrl,
} from './render'

const PANE = 'render-deploys'
const COMMAND = 'render-deploys'
const MAX_DIR_DEPTH = 40
const SHA_LENGTH = 7
const MAX_MESSAGE = 60
const STATE_COLORS: Record<DeployState, string | undefined> = {
  building: 'yellow',
  ready: 'green',
  error: 'red',
  canceled: undefined, // drawn dim
}

const snapshot = atom({ plugin: 'render-deploys', key: 'snapshot' } as const, { deploys: [], services: [] } as Snapshot)
const watching = atom({ plugin: 'render-deploys', key: 'watching' } as const, [] as string[])

export type Config = {
  services: string[]
  maxServices: number
  maxRows: number
  slowMs: number
  fastMs: number
  notify: boolean
}

const list = (v: PluginOptions[string] | undefined) =>
  (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map(s => s.trim())
    .filter(Boolean)

const num = (v: PluginOptions[string] | undefined, fallback: number, min: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= min ? n : fallback
}

export function parseConfig(options: PluginOptions): Config {
  return {
    services: list(options.services),
    maxServices: Math.floor(num(options.max_services, 10, 1)),
    maxRows: Math.floor(num(options.max_rows, 15, 1)),
    slowMs: num(options.refresh_seconds, 60, 15) * 1000,
    fastMs: num(options.building_refresh_seconds, 10, 5) * 1000,
    notify: options.notify_on_finish === true,
  }
}

let config = parseConfig({}) // replaced by register; a settings change reloads the module
let timer: Timer | undefined
let inflight: Promise<Snapshot> | undefined

// ---- the current branch ----

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

// Walks up from the session's directory for .git (a directory, or in a worktree a file naming
// its gitdir), reading files only: no git process.
async function detectBranch($: EngineInterface): Promise<string | undefined> {
  let dir: string | undefined = await $.session.cwd()
  for (let i = 0; dir && i < MAX_DIR_DEPTH; i++, dir = parentDir(dir)) {
    let head = await readText($, `${dir}/.git/HEAD`)
    if (head === undefined) {
      const gitdir = /^gitdir:\s*(.+)$/m.exec((await readText($, `${dir}/.git`)) ?? '')?.[1]?.trim()
      if (gitdir) head = await readText($, `${isAbsolute(gitdir) ? gitdir : `${dir}/${gitdir}`}/HEAD`)
    }
    if (head !== undefined) return branchFromHead(head)
  }
  return undefined
}

// ---- fetching ----

async function getJson($: EngineInterface, url: string, token: string) {
  let res
  try {
    res = await $.http.fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  } catch (err) {
    throw new ApiError(`Render unreachable: ${message(err)}`)
  }
  if (!res.ok) throw httpError(res.status, res.text)
  try {
    return JSON.parse(res.text)
  } catch {
    throw new ApiError('Render sent a response that is not JSON')
  }
}

// One request per service; a failing service keeps its previous rows (in `failed`) and names the error.
async function fetchDeploys($: EngineInterface, services: Service[], token: string) {
  const results = await Promise.allSettled(
    services.map(async s => {
      const body = await getJson($, deploysUrl(s.id, config.maxRows), token)
      return parseDeploys(s, Array.isArray(body) ? body : [])
    }),
  )
  const failed = new Set(services.filter((_, i) => results[i]!.status === 'rejected').map(s => s.id))
  const rejected = results.find(r => r.status === 'rejected')
  return {
    deploys: results.flatMap(r => (r.status === 'fulfilled' ? r.value : [])),
    failed,
    error: rejected ? message(rejected.reason) : undefined,
  }
}

const newest = (deploys: Deploy[]) => deploys.sort((a, b) => b.createdAt - a.createdAt).slice(0, config.maxRows)

// The service list and every service's deploys.
async function fullFetch($: EngineInterface, token: string, now: number): Promise<Snapshot> {
  try {
    const body = await getJson($, servicesUrl(), token)
    const { services, skipped } = pickServices(Array.isArray(body) ? body : [], config.services, config.maxServices)
    const { deploys, error } = await fetchDeploys($, services, token)
    const notes = [
      skipped ? `${skipped} more services not shown: set services or max_services` : '',
      config.services.length && !services.length ? `no service named ${config.services.join(', ')}` : '',
    ].filter(Boolean)
    return { deploys: newest(deploys), services, error, note: notes.join('; ') || undefined, fullAt: now }
  } catch (err) {
    return { deploys: [], services: [], error: message(err) }
  }
}

// Only the services with a deploy building; every other row is kept from the last snapshot.
async function buildingFetch($: EngineInterface, token: string, prev: Snapshot): Promise<Snapshot> {
  const ids = new Set(buildingServiceIds(prev.deploys))
  const { deploys, failed, error } = await fetchDeploys($, prev.services.filter(s => ids.has(s.id)), token)
  const kept = prev.deploys.filter(d => !ids.has(d.serviceId) || failed.has(d.serviceId))
  return { deploys: newest([...kept, ...deploys]), services: prev.services, error, note: prev.note, fullAt: prev.fullAt }
}

async function doRefresh($: EngineInterface, forceFull: boolean): Promise<Snapshot> {
  const prev = await read($, snapshot)
  const branch = await detectBranch($)
  const now = await $.clock.now()
  const token = await $.env.get('RENDER_API_KEY')
  const full = forceFull || prev.fullAt === undefined || prev.services.length === 0 || now - prev.fullAt >= config.slowMs
  const fetched: Snapshot = !token
    ? { deploys: [], services: [], error: 'RENDER_API_KEY is not set' }
    : full
      ? await fullFetch($, token, now)
      : await buildingFetch($, token, prev)
  const next = { ...fetched, branch, checkedAt: now }
  await update($, snapshot, () => next)
  return next
}

// One refresh at a time: a press during a poll waits for the poll's answer.
function refresh($: EngineInterface, forceFull: boolean): Promise<Snapshot> {
  inflight ??= doRefresh($, forceFull).finally(() => {
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
      if (d.state === 'ready') $.ui.toast(`${d.service} (${d.branch}) is live on Render`)
      if (d.state === 'error') $.ui.toast(`${d.service} (${d.branch}) failed on Render`)
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
  const snap = await refresh($, false)
  await settleWatch($, snap, isOpen)
  if (!isOpen && (await read($, watching)).length === 0) return
  schedule($, snap)
}

async function refreshNow($: EngineInterface) {
  const snap = await refresh($, true)
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
    await $.command.register({ name: COMMAND, description: 'Show recent Render deploys in a pane' })
    // A reload (a settings change, a new version) drops the old timer but keeps the pane
    // open, or a watched build pending: pick polling back up.
    if ((await isPaneOpen($)) || (await read($, watching)).length) void poll($)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: 'Render deploys' })
    void refreshNow($)
    return { text: 'Render deploys pane opened.' }
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
            Render deploys
            {branch && <Text dimColor> · on </Text>}
            {branch && <Text color="cyan">{branch}</Text>}
          </Text>
          <Button key="refresh" onPress={() => void refreshNow($)}>
            Refresh
          </Button>
        </Box>
        {error && <Text color="red">{error}</Text>}
        {note && <Text dimColor>{note}</Text>}
        {checkedAt === undefined && <Text dimColor>Checking…</Text>}
        {checkedAt !== undefined && !error && deploys.length === 0 && <Text dimColor>No deploys found.</Text>}
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
                {d.service} <Text dimColor>{d.env}</Text>
                {d.branch && (
                  <Text color={mine ? 'cyan' : undefined} bold={mine}>
                    {' '}
                    {d.branch}
                  </Text>
                )}
                {d.sha && <Text dimColor> {d.sha.slice(0, SHA_LENGTH)}</Text>}
                {d.trigger && <Text color="magenta"> {d.trigger}</Text>}
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
