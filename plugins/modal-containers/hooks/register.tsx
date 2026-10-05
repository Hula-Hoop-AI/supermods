import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { App, Costs, Snapshot } from '../types'
import { HELPER_PY, helperArgv } from './helper'

const PANE = 'modal-containers'
const POLL_MS = 20_000
const COST_EVERY = 15 // billing is hourly, so refresh costs every 15th poll (5 min)
const COST_DAYS = 7
const snapshot = atom({ plugin: 'modal-containers', key: 'snapshot' } as const, {
  apps: [],
} as Snapshot)
const costs = atom({ plugin: 'modal-containers', key: 'costs' } as const, { byApp: {} } as Costs)
const mineOnly = atom({ plugin: 'modal-containers', key: 'mineOnly' } as const, false)

let timer: Timer | undefined
let tick = 0
let configuredEnv = '' // the `environment` setting; a change there reloads the module

const lastLine = (stderr: string, exitCode: number) =>
  stderr.trim().split('\n').pop() || `exit ${exitCode}`
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function runJson($: EngineInterface, argv: string[], stdin?: string) {
  const { exitCode, stdout, stderr } = await $.process.run(argv, { stdin, timeoutMs: 120_000 })
  if (exitCode !== 0) throw new Error(lastLine(stderr, exitCode))
  return JSON.parse(stdout)
}

// `modal container list --json` rows, grouped by app; no creators.
type CliRow = { container_id: string; app_id: string; app_name: string; start_time: string }
function groupCliRows(rows: CliRow[]): App[] {
  const apps = new Map<string, App>()
  for (const r of rows) {
    const app = apps.get(r.app_id) ?? { app_id: r.app_id, app_name: r.app_name, containers: [] }
    // start_time looks like "2026-10-04 12:00:00+03:00", or "Pending"
    const t = Date.parse(r.start_time.replace(' ', 'T'))
    app.containers.push({ container_id: r.container_id, started_at: Number.isNaN(t) ? 0 : t / 1000 })
    apps.set(r.app_id, app)
  }
  return [...apps.values()]
}

async function refreshContainers($: EngineInterface) {
  // The mod's own setting, then MODAL_ENVIRONMENT; neither means Modal's own default:
  // the profile's environment, else the workspace's.
  const env = configuredEnv || (await $.env.get('MODAL_ENVIRONMENT')) || ''
  let next: Snapshot
  try {
    const out = await runJson($, helperArgv(env), HELPER_PY)
    next = { apps: out.apps, me: out.me, env: out.env || undefined }
  } catch (helperErr) {
    try {
      const rows: CliRow[] = await runJson($, [
        'modal', 'container', 'list', '--json', ...(env ? ['--env', env] : []),
      ])
      next = { apps: groupCliRows(rows), env: env || undefined, degraded: message(helperErr) }
    } catch (cliErr) {
      next = { apps: [], error: message(cliErr) }
    }
  }
  await update($, snapshot, () => ({ ...next, checkedAt: Date.now() }))
}

// Cost per app over the last COST_DAYS, from the public billing report (complete hours only).
async function refreshCosts($: EngineInterface) {
  const start = new Date(Date.now() - COST_DAYS * 86_400_000).toISOString().slice(0, 13) + ':00:00'
  let next: Costs
  try {
    const rows: { object_id: string; cost: string }[] = await runJson($, [
      'modal', 'billing', 'report', '--start', start, '--resolution', 'h', '--json',
    ])
    const byApp: Record<string, number> = {}
    for (const r of rows) byApp[r.object_id] = (byApp[r.object_id] ?? 0) + Number(r.cost)
    next = { byApp }
  } catch (err) {
    next = { byApp: {}, error: message(err) }
  }
  await update($, costs, () => ({ ...next, checkedAt: Date.now() }))
}

// Polls only while the pane is open; stops itself once the pane is closed.
function startPolling($: EngineInterface) {
  timer?.cancel()
  tick = 0
  void refreshContainers($)
  void refreshCosts($)
  timer = $.clock.every(POLL_MS, async () => {
    const panes = await $.ui.panes()
    if (!panes.some(p => p.id === PANE)) {
      timer?.cancel()
      timer = undefined
      return
    }
    await refreshContainers($)
    if (++tick % COST_EVERY === 0) await refreshCosts($)
  })
}

function age(startedAt: number): string {
  if (!startedAt) return 'pending'
  const mins = Math.max(0, Math.floor((Date.now() - startedAt * 1000) / 60_000))
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`
}

function money(dollars: number | undefined): string {
  if (dollars === undefined) return '$—'
  return dollars < 0.01 ? '<$0.01' : `$${dollars.toFixed(2)}`
}

export const register: Register = (on, options) => {
  configuredEnv = String(options.environment ?? '').trim()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'modal',
      description: 'Show your running Modal containers in a pane',
    })
    // A reload (a settings change, a new version) drops the old timers but keeps the
    // pane open: pick the polling back up so it does not freeze on stale data.
    if ((await $.ui.panes()).some(p => p.id === PANE)) startPolling($)
    return next(e)
  })

  on('command.run', { command: 'modal' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Modal' })
    startPolling($)
    return { text: 'Modal containers pane opened (refreshes every 20s).' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { apps, me, env, error, degraded, checkedAt } = await read($, snapshot)
    const cost = await read($, costs)
    // The filter needs creators, which only the helper provides.
    const onlyMine = (await read($, mineOnly)) && me !== undefined
    const shown = onlyMine ? apps.filter(a => a.created_by === me) : apps
    const count = shown.reduce((n, a) => n + a.containers.length, 0)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 7)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>
            {count} running container{count === 1 ? '' : 's'}
            <Text dimColor> · {env ?? 'default env'}</Text>
          </Text>
          {me !== undefined && (
            <Button
              key="mine"
              variant={onlyMine ? 'primary' : 'secondary'}
              onPress={() => void update($, mineOnly, v => !v)}
            >
              {onlyMine ? 'Mine only' : 'All runs'}
            </Button>
          )}
        </Box>
        {error && <Text color="red">{error}</Text>}
        {degraded && <Text dimColor>creators unavailable ({degraded}); showing the CLI's list</Text>}
        {cost.error && <Text dimColor>cost unavailable: {cost.error}</Text>}
        {checkedAt === undefined && <Text dimColor>Checking…</Text>}
        {checkedAt !== undefined && !error && shown.length === 0 && (
          <Text dimColor>{onlyMine ? `No runs by ${me}.` : 'Nothing running.'}</Text>
        )}
        {shown.slice(0, room).map(a => {
          const oldest = Math.min(...a.containers.map(c => c.started_at || Infinity))
          return (
            <Text>
              {age(Number.isFinite(oldest) ? oldest : 0).padStart(7)} {a.app_name || a.app_id}
              {a.containers.length > 1 && <Text bold> ×{a.containers.length}</Text>}
              {a.created_by !== undefined && <Text color="cyan"> {a.created_by || 'unknown'}</Text>}
              {!cost.error && <Text color="green"> {money(cost.byApp[a.app_id])}</Text>}
            </Text>
          )
        })}
        {shown.length > room && <Text dimColor>…and {shown.length - room} more apps</Text>}
        {checkedAt !== undefined && (
          <Text dimColor>
            updated {new Date(checkedAt).toLocaleTimeString()} · cost: billed full hours, last {COST_DAYS}d
          </Text>
        )}
      </Box>
    )
  })
}
