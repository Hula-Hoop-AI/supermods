import type { PluginOptions } from 'claude-code'

import type { Io } from '../io'
import type { Carry, ObserveRow, Snapshot } from '../../types'
import { age, DETAILS, lastLine, message, plural } from '../util'
import type { ProviderOf } from './index'
import { HELPER_PY, helperArgv } from './modal-helper'

const POLL_MS = 20_000
const COST_REFRESH_MS = 5 * 60_000 // billing is hourly
const COST_DAYS = 7
const MINE = 'mine'

type Container = { container_id: string; started_at: number } // epoch seconds; 0 while pending
type App = {
  app_id: string
  app_name: string
  created_by?: string // absent when only the plain CLI answered
  containers: Container[]
}
type Listing = { apps: App[]; me?: string; env?: string; error?: string; degraded?: string }

async function runJson(io: Io, argv: string[], stdin?: string) {
  const { exitCode, stdout, stderr } = await io.run(argv, { stdin, timeoutMs: 120_000 })
  if (exitCode !== 0) throw new Error(lastLine(stderr, exitCode))
  return JSON.parse(stdout)
}

// `modal container list --json` rows, grouped by app; no creators.
type CliRow = { container_id: string; app_id: string; app_name: string; start_time: string }
export function groupCliRows(rows: CliRow[]): App[] {
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

async function listContainers(io: Io, env: string): Promise<Listing> {
  try {
    const out = await runJson(io, helperArgv(env), HELPER_PY)
    return { apps: out.apps, me: out.me, env: out.env || undefined }
  } catch (helperErr) {
    try {
      const rows: CliRow[] = await runJson(io, [
        'modal', 'container', 'list', '--json', ...(env ? ['--env', env] : []),
      ])
      return { apps: groupCliRows(rows), env: env || undefined, degraded: message(helperErr) }
    } catch (cliErr) {
      return { apps: [], error: message(cliErr) }
    }
  }
}

// Cost per app over the last COST_DAYS, from the public billing report (complete hours only).
async function fetchCosts(io: Io, now: number): Promise<Carry> {
  const start = new Date(now - COST_DAYS * 86_400_000).toISOString().slice(0, 13) + ':00:00'
  try {
    const rows: { object_id: string; cost: string }[] = await runJson(io, [
      'modal', 'billing', 'report', '--start', start, '--resolution', 'h', '--json',
    ])
    const costs: Record<string, number> = {}
    for (const r of rows) costs[r.object_id] = (costs[r.object_id] ?? 0) + Number(r.cost)
    return { costs, costsAt: now }
  } catch (err) {
    return { costsAt: now, costError: message(err) }
  }
}

function money(dollars: number | undefined): string {
  if (dollars === undefined) return '$—'
  return dollars < 0.01 ? '<$0.01' : `$${dollars.toFixed(2)}`
}

// ULIDs share their leading (time) characters, so the tail tells containers apart.
export const shortId = (id: string) => `…${id.slice(-6)}`

// One row per container, by app then start time (pending last). Modal bills per app, so each
// row repeats its app's cost.
export function containerRows(apps: App[], costs: Record<string, number> | undefined, now: number): ObserveRow[] {
  return apps
    .flatMap(a => a.containers.map(c => ({ a, c, name: a.app_name || a.app_id })))
    .sort((x, y) => x.name.localeCompare(y.name) || (x.c.started_at || Infinity) - (y.c.started_at || Infinity))
    .map(({ a, c, name }) => ({
      id: c.container_id,
      state: c.started_at ? 'ok' : 'busy',
      title: name,
      tags: [
        { text: shortId(c.container_id), dimColor: true },
        ...(a.created_by !== undefined ? [{ text: a.created_by || 'unknown', color: 'cyan' }] : []),
        ...(costs ? [{ text: money(costs[a.app_id]), color: 'green' }] : []),
      ],
      age: c.started_at ? age(now - c.started_at * 1000) : 'pending',
      owner: a.created_by,
      actions: DETAILS.map(key => ({ key, label: key })),
    }))
}

export type ModalConfig = { environment: string }

export async function fetchModal(io: Io, cfg: ModalConfig, prev: Snapshot, force: boolean): Promise<Snapshot> {
  // The mod's own setting, then MODAL_ENVIRONMENT; neither means Modal's own default:
  // the profile's environment, else the workspace's.
  const env = cfg.environment || (await io.env.MODAL_ENVIRONMENT()) || ''
  const now = await io.now()
  const { carry: kept } = prev
  const fresh = !force && kept?.costsAt !== undefined && now - kept.costsAt < COST_REFRESH_MS ? kept : undefined
  const [listing, carry] = await Promise.all([listContainers(io, env), fresh ?? fetchCosts(io, now)])
  return {
    rows: containerRows(listing.apps, carry.costs, now),
    me: listing.me,
    context: listing.env ?? 'default env',
    error: listing.error,
    notes: [
      listing.degraded ? `creators unavailable (${listing.degraded}); showing the CLI's list` : '',
      carry.costError ? `cost unavailable: ${carry.costError}` : '',
    ].filter(Boolean),
    carry,
  }
}

export function modal(options: PluginOptions): ProviderOf<'modal'> {
  return {
    id: 'modal',
    title: 'Modal',
    config: { environment: String(options.modal_environment ?? '').trim() },
    footnote: `cost: per app, billed full hours, last ${COST_DAYS}d`,
    intervalMs: () => POLL_MS,
    // The filter needs creators, which only the helper provides.
    toggles: snap => (snap.me === undefined ? [] : [{ key: MINE, on: 'Mine only', off: 'All runs' }]),
    view(snap, isOn) {
      const onlyMine = isOn(MINE) && snap.me !== undefined
      const rows = onlyMine ? snap.rows.filter(r => r.owner === snap.me) : snap.rows
      return {
        rows,
        summary: plural(rows.length, 'running container'),
        empty: onlyMine ? `No runs by ${snap.me}.` : 'Nothing running.',
      }
    },
  }
}
