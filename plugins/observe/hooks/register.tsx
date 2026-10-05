import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

import type { Logs, Metrics, ProviderId, Snapshot, Target } from '../types'
import type { Io } from './io'
import { buildProviders, fetchProvider } from './providers'
import type { Provider } from './providers'
import { detailTitle, fetchDetailLogs, fetchDetailMetrics } from './providers/details'
import { logsPane, metricsPane } from './providers/detail-view'
import { tabPane } from './tab-pane'
import type { Row } from './tab-pane'
import { DETAILS, message, num } from './util'
import type { Detail } from './util'

const PANE = 'observe'
const COMMAND = 'observe'
const EMPTY: Snapshot = { rows: [] }
const DETAIL_REFRESH_S = 5
// The per-container panes the Modal and Docker tabs share, one of each: another row's button
// points it at that container.
const LOGS_PANE = 'observe-logs'
const METRICS_PANE = 'observe-metrics'
const DETAIL_PANES: Record<Detail, string> = { logs: LOGS_PANE, metrics: METRICS_PANE }

// '' until a tab is picked: the first provider shows
const tab = atom({ plugin: 'observe', key: 'tab' } as const, '' as ProviderId | '')
const snapshots = atom({ plugin: 'observe', key: 'snapshots' } as const, {} as Partial<Record<ProviderId, Snapshot>>)
const toggles = atom({ plugin: 'observe', key: 'toggles' } as const, {} as Record<string, boolean>)
const watching = atom({ plugin: 'observe', key: 'watching' } as const, {} as Partial<Record<ProviderId, string[]>>)
const logs = atom({ plugin: 'observe', key: 'logs' } as const, null as Logs | null)
const metrics = atom({ plugin: 'observe', key: 'metrics' } as const, null as Metrics | null)

// Replaced by register; a settings change reloads the module.
let providers: Provider[] = []
let notify = false
let detailMs = DETAIL_REFRESH_S * 1000
const detailTimers: Partial<Record<Detail, Timer>> = {}
const detailBusy: Record<Detail, boolean> = { logs: false, metrics: false }
let timer: Timer | undefined
let pollRound = 0
const inflight = new Map<ProviderId, Promise<Snapshot>>()

const bind = ($: EngineInterface): Io => ({
  run: (argv, options) => $.process.run(argv, options),
  fetch: (url, headers) => $.http.fetch(url, { headers }),
  env: {
    MODAL_ENVIRONMENT: () => $.env.get('MODAL_ENVIRONMENT'),
    RENDER_API_KEY: () => $.env.get('RENDER_API_KEY'),
    VERCEL_TOKEN: () => $.env.get('VERCEL_TOKEN'),
  },
  now: () => $.clock.now(),
  readFile: path => $.fs.read(path),
  cwd: () => $.session.cwd(),
})

const findProvider = (id: string) => providers.find(p => p.id === id)

// The tab last shown, or the first one when the settings no longer list it.
const activeProvider = async ($: EngineInterface) => findProvider(await read($, tab)) ?? providers[0]!

const isPaneOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

async function doRefresh($: EngineInterface, p: Provider, force: boolean): Promise<Snapshot> {
  const prev = (await read($, snapshots))[p.id] ?? EMPTY
  let fetched: Snapshot
  try {
    fetched = await fetchProvider(bind($), p, prev, force)
  } catch (err) {
    fetched = { rows: [], error: message(err) }
  }
  const next = { ...fetched, checkedAt: await $.clock.now() }
  await update($, snapshots, all => ({ ...all, [p.id]: next }))
  return next
}

// One refresh per provider at a time: a press during a poll waits for the poll's answer.
function refresh($: EngineInterface, p: Provider, force: boolean): Promise<Snapshot> {
  let run = inflight.get(p.id)
  if (!run) {
    run = doRefresh($, p, force).finally(() => inflight.delete(p.id))
    inflight.set(p.id, run)
  }
  return run
}

// Remembers the current branch's busy rows; while their tab is not on screen, toasts the ones
// that finished.
async function settleWatch($: EngineInterface, p: Provider, snap: Snapshot, isVisible: boolean) {
  const before = new Set((await read($, watching))[p.id] ?? [])
  const mine = snap.rows.filter(r => r.highlight)
  if (notify && !isVisible) {
    for (const r of mine) {
      if (!before.has(r.id)) continue
      const what = `${r.title}${snap.branch ? ` (${snap.branch})` : ''}`
      if (r.state === 'ok') $.ui.toast(`${what} is ready on ${p.title}`)
      if (r.state === 'error') $.ui.toast(`${what} failed on ${p.title}`)
    }
  }
  const now = notify ? mine.filter(r => r.state === 'busy').map(r => r.id) : []
  await update($, watching, all => ({ ...all, [p.id]: now }))
}

// The tab on screen, and every provider with a watched row still busy.
async function pollTargets($: EngineInterface) {
  const visible = (await isPaneOpen($)) ? await activeProvider($) : undefined
  const watched = await read($, watching)
  return { visible, all: providers.filter(p => p === visible || watched[p.id]?.length) }
}

// Refreshes the targets and schedules the next round; with none left it stops. A newer round
// (a tab press, Refresh) takes the schedule over from one still running.
async function poll($: EngineInterface, force = false) {
  const round = ++pollRound
  timer?.cancel()
  timer = undefined
  const { visible, all } = await pollTargets($)
  if (!all.length) return
  const intervals = await Promise.all(
    all.map(async p => {
      const snap = await refresh($, p, force && p === visible)
      await settleWatch($, p, snap, p === visible)
      return p.intervalMs(snap)
    }),
  )
  if (round !== pollRound || !(await pollTargets($)).all.length) return
  timer = $.clock.after(Math.min(...intervals), () => void poll($))
}

// One call at a time per pane: a tick that finds the previous one still running is skipped.
// The answer is dropped if the pane moved on to another container meanwhile.
async function refreshDetail($: EngineInterface, kind: Detail) {
  if (detailBusy[kind]) return
  detailBusy[kind] = true
  try {
    if (kind === 'logs') {
      const cur = await read($, logs)
      if (!cur) return
      const next = await fetchDetailLogs(bind($), cur)
      await update($, logs, now => (now && sameTarget(now, cur) ? next : now))
    } else {
      const cur = await read($, metrics)
      if (!cur) return
      const next = await fetchDetailMetrics(bind($), cur)
      await update($, metrics, now => (now && sameTarget(now, cur) ? next : now))
    }
  } finally {
    detailBusy[kind] = false
  }
}

function stopDetail(kind: Detail) {
  detailTimers[kind]?.cancel()
  delete detailTimers[kind]
}

// Refreshes while the pane is open. `ui.close` stops it at once; the pane check on each tick
// also stops it should a close go unheard (e.g. across a reload).
function startDetail($: EngineInterface, kind: Detail) {
  stopDetail(kind)
  void refreshDetail($, kind)
  detailTimers[kind] = $.clock.every(detailMs, async () => {
    if ((await $.ui.panes()).some(p => p.id === DETAIL_PANES[kind])) await refreshDetail($, kind)
    else stopDetail(kind)
  })
}

const sameTarget = (a: Target, b: Target) => a.source === b.source && a.container_id === b.container_id

async function openDetail($: EngineInterface, kind: Detail, target: Target) {
  if (kind === 'logs') await update($, logs, () => ({ ...target, lines: [] }))
  else await update($, metrics, () => target)
  const title = detailTitle(kind, target)
  const opened = await $.ui.open({ id: DETAIL_PANES[kind], title })
  if (!opened.isPlaced) $.ui.toast(notPlaced(title, opened.reason))
  startDetail($, kind)
}

// The container a Modal or Docker row stands for; undefined on the other tabs.
function targetOf(p: Provider, row: Row): Target | undefined {
  if (p.id === 'modal') return { source: 'modal', container_id: row.id, name: row.title }
  if (p.id === 'docker') return { source: 'docker', container_id: row.id, name: row.title, context: p.config.context || undefined }
  return undefined
}

async function copy($: EngineInterface, text: string, surface: RenderSurface) {
  const r = await $.ui.copy({ text, surface })
  $.ui.toast(r.isCopied ? `Copied ${text}` : `Could not copy (${r.reason})`)
}

function notPlaced(what: string, reason: string) {
  return `${what} is open, but this surface is not showing it: ${reason}`
}

export const register: Register = (on, options) => {
  providers = buildProviders(options)
  notify = options.notify_on_finish === true
  detailMs = num(options.detail_refresh_seconds, DETAIL_REFRESH_S, 2, 3600) * 1000
  const ids = providers.map(p => p.id)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: `Watch ${providers.map(p => p.title).join(', ')} in a pane`,
      argumentHint: `[${ids.join('|')}]`,
    })
    // A reload (a settings change, a new version) drops the old timers but keeps the panes
    // open, or a watched build pending: pick polling back up.
    void poll($)
    const open = await $.ui.panes()
    for (const kind of DETAILS) if (open.some(p => p.id === DETAIL_PANES[kind])) startDetail($, kind)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const wanted = e.args.trim().toLowerCase()
    const chosen = wanted ? findProvider(wanted) : await activeProvider($)
    if (!chosen) return { text: `No provider named "${wanted}". Use one of: ${ids.join(', ')}.` }
    await update($, tab, () => chosen.id)
    const opened = await $.ui.open({ id: PANE, title: 'Observe' })
    void poll($, true)
    return {
      text: opened.isPlaced ? `Observe pane opened on ${chosen.title}.` : notPlaced('The Observe pane', opened.reason),
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    void poll($)
    return closed
  })

  on('ui.close', { id: LOGS_PANE }, async ($, e, next) => {
    stopDetail('logs')
    return next(e)
  })

  on('ui.close', { id: METRICS_PANE }, async ($, e, next) => {
    stopDetail('metrics')
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: LOGS_PANE }, async ($, e) =>
    logsPane($.ui.resolve(e), e.props.scroll.bodyRows, await read($, logs), detailMs / 1000),
  )

  on('ui.render', { component: 'Pane', requestId: METRICS_PANE }, async ($, e) =>
    metricsPane($.ui.resolve(e), await read($, metrics), detailMs / 1000, e.props.bodyColumns),
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const p = await activeProvider($)
    const snap = (await read($, snapshots))[p.id] ?? EMPTY
    const flags = await read($, toggles)
    const isOn = (key: string) => flags[`${p.id}.${key}`] === true
    const view = p.view(snap, isOn)

    return tabPane($.ui.resolve(e), e.viewport, {
      tabs: providers.map(({ id, title }) => ({ id, title })),
      activeTab: p.id,
      onTab: id => {
        const picked = findProvider(id)
        if (picked) void update($, tab, () => picked.id).then(() => poll($))
      },
      summary: view.summary,
      context: snap.context,
      actions: [
        ...(p.toggles?.(snap) ?? []).map(t => ({
          key: t.key,
          label: isOn(t.key) ? t.on : t.off,
          isActive: isOn(t.key),
          onPress: () => void update($, toggles, all => ({ ...all, [`${p.id}.${t.key}`]: !isOn(t.key) })),
        })),
        { key: 'refresh', label: 'Refresh', onPress: () => void poll($, true) },
      ],
      error: snap.error,
      notes: snap.notes,
      checkedAt: snap.checkedAt,
      empty: snap.unavailable ?? view.empty,
      rows: view.rows,
      onCopy: (text, surface) => void copy($, text, surface),
      columns: e.props.bodyColumns,
      onRowAction: (row, key) => {
        const kind = DETAILS.find(d => d === key)
        const target = targetOf(p, row)
        if (kind && target) void openDetail($, kind, target)
      },
      footer: [`every ${Math.round(p.intervalMs(snap) / 1000)}s`, p.footnote].filter(Boolean).join(' · '),
    })
  })
}
