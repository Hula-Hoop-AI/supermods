import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildingServiceIds, normalizeState, parseDeploys, pickServices } from '../hooks/render'
import { age, branchFromHead, parseConfig } from '../hooks/register'

const NOW = 1_800_000_000_000
const MIN = 60_000
const PANE = 'render-deploys'
const iso = (ms: number) => new Date(ms).toISOString()

const SERVICES = [
  {
    service: {
      id: 'srv-1', name: 'api', branch: 'main', dashboardUrl: 'https://dashboard.render.com/web/srv-1',
      serviceDetails: { url: 'https://api.onrender.com' },
    },
    cursor: 'a',
  },
  {
    service: {
      id: 'srv-2', name: 'api-pr-7', branch: 'feature-x', dashboardUrl: 'https://dashboard.render.com/web/srv-2',
      serviceDetails: { parentServer: { id: 'srv-1', name: 'api' } },
    },
    cursor: 'b',
  },
]

// Current status of each service's one deploy; tests change it to move builds along.
type States = Record<string, string>
const deploysFor = (id: string, states: States) =>
  id === 'srv-1'
    ? [{ deploy: { id: 'dep-1', status: states['srv-1'], trigger: 'new_commit', commit: { id: 'fff0001112223', message: 'Bump deps\nbody' }, createdAt: iso(NOW - 30 * MIN) }, cursor: 'x' }]
    : id === 'srv-2'
      ? [{ deploy: { id: 'dep-2', status: states['srv-2'], trigger: 'manual', commit: { id: 'eee0001112223', message: 'Preview it' }, createdAt: iso(NOW - 60 * MIN) }, cursor: 'y' }]
      : []

type Reply = { status: number; body: unknown } | 'unreachable'

type Setup = {
  env?: Record<string, string>
  files?: Record<string, string>
  states?: States
  services?: () => Reply
  deploys?: (id: string) => Reply | undefined
}

// Stubs everything the mod reaches; returns handles to drive it.
function setup(on: On, s: Setup = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, s.env ?? { RENDER_API_KEY: 'rtok-secret' })
  const files = s.files ?? { '/work/.git/HEAD': 'ref: refs/heads/feature-x\n' }
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path]! } : { deny: 'ENOENT' }))
  const pane = { open: false }
  on('ui.open', () => {
    pane.open = true
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({
    value: pane.open ? [{ id: PANE, title: 'Render deploys', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const states: States = s.states ?? { 'srv-1': 'build_failed', 'srv-2': 'live' }
  const urls: string[] = []
  const auths: (string | undefined)[] = []
  on('http.fetch', async ($, e) => {
    urls.push(e.url)
    auths.push(e.init?.headers?.Authorization)
    const m = /\/services\/([^/]+)\/deploys/.exec(e.url)
    const reply: Reply = m
      ? (s.deploys?.(m[1]!) ?? { status: 200, body: deploysFor(m[1]!, states) })
      : (s.services?.() ?? { status: 200, body: SERVICES })
    if (reply === 'unreachable') return { deny: 'getaddrinfo ENOTFOUND' }
    return { value: { status: reply.status, ok: reply.status < 300, headers: {}, text: JSON.stringify(reply.body) } }
  })
  return { clock, urls, auths, pane, toasts, states }
}

const PANE_PROPS = {
  title: 'Render deploys', isFocused: false, bodyColumns: 100, placement: 'inline',
  scroll: { offset: 0, bodyRows: 30 }, view: {},
}

async function openPane($: Engine, clock: { settle: () => Promise<void> }, surface: 'terminal' | 'desktop') {
  await $.command.run({ command: 'render-deploys', args: '' } as never)
  await clock.settle()
  return $.ui.mount({
    plugin: 'render-deploys', surface, component: 'Pane', requestId: PANE,
    viewport: { columns: 120, rows: 40 }, props: PANE_PROPS as never,
  })
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
// The drawing's text in order, links as their href.
function textOf(n: unknown): string {
  if (n === null || n === undefined || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  const node = n as Node
  if (node.type === 'Link') return ` ${String(node.props?.href)} `
  return textOf(node.children ?? node.props?.children) + (node.type === 'Text' ? '' : '\n')
}

const SERVICES_URL = 'https://api.render.com/v1/services?limit=100'
const deploysOf = (id: string) => `https://api.render.com/v1/services/${id}/deploys?limit=15`

for (const surface of ['terminal', 'desktop'] as const) {
  describe(surface, () => {
    test('lists deploys newest first, normalized, with the current branch marked', async ($, on) => {
      const { clock } = setup(on)
      const ui = await openPane($, clock, surface)
      const all = textOf(await ui.find({ type: 'Box' }))
      expect(all.indexOf('Bump deps')).toBeGreaterThan(-1)
      expect(all.indexOf('Bump deps')).toBeLessThan(all.indexOf('Preview it'))
      expect(all).toMatch(/ {2}error\s+api prod main fff0001 new commit 30m ago/)
      expect(all).toMatch(/› ready\s+api-pr-7 preview feature-x eee0001 manual 1h ago/)
      expect(all).toContain('https://dashboard.render.com/web/srv-1/deploys/dep-1')
      expect(all).toMatch(/on feature-x/)
      expect(all).not.toContain('body')
      expect(all).not.toContain('secret')
      expect(all).toMatch(/next in 60s/)
    })

    test('a missing key shows inline and makes no request', async ($, on) => {
      const { clock, urls } = setup(on, { env: {} })
      const ui = await openPane($, clock, surface)
      expect(await ui.find({ text: 'RENDER_API_KEY is not set' })).toBeDefined()
      expect(urls.length).toBe(0)
    })

    test('a rejected key shows inline', async ($, on) => {
      const { clock } = setup(on, { services: () => ({ status: 401, body: { message: 'unauthorized' } }) })
      const ui = await openPane($, clock, surface)
      expect(await ui.find({ text: 'Render rejected the key (HTTP 401): check RENDER_API_KEY' })).toBeDefined()
    })

    test('unreachable, server errors and rate limits say so', async ($, on) => {
      let reply: Reply = 'unreachable'
      const { clock } = setup(on, { services: () => reply })
      const ui = await openPane($, clock, surface)
      expect(await ui.find({ text: /Render unreachable/ })).toBeDefined()
      reply = { status: 500, body: { message: 'internal error' } }
      await ui.press({ key: 'refresh' })
      await clock.settle()
      expect(await ui.find({ text: 'Render HTTP 500: internal error' })).toBeDefined()
      reply = { status: 429, body: {} }
      await ui.press({ key: 'refresh' })
      await clock.settle()
      expect(await ui.find({ text: /Render rate limit hit \(HTTP 429\)/ })).toBeDefined()
    })

    test('one service failing keeps the rest', async ($, on) => {
      const { clock } = setup(on, { deploys: id => (id === 'srv-2' ? { status: 503, body: {} } : undefined) })
      const ui = await openPane($, clock, surface)
      expect(await ui.find({ text: 'Render HTTP 503' })).toBeDefined()
      expect(await ui.find({ text: /Bump deps/ })).toBeDefined()
    })

    test('no services says so', async ($, on) => {
      const { clock } = setup(on, { services: () => ({ status: 200, body: [] }) })
      const ui = await openPane($, clock, surface)
      expect(await ui.find({ text: 'No deploys found.' })).toBeDefined()
    })

    test('the Refresh button does a full refresh', async ($, on) => {
      const { clock, urls } = setup(on)
      const ui = await openPane($, clock, surface)
      expect(urls.length).toBe(3)
      await ui.press({ key: 'refresh' })
      await clock.settle()
      expect(urls.slice(3)).toEqual([SERVICES_URL, deploysOf('srv-1'), deploysOf('srv-2')])
    })

    test('max_rows caps the list and the per-service request', { options: { max_rows: 1 } }, async ($, on) => {
      const { clock, urls } = setup(on)
      const ui = await openPane($, clock, surface)
      const all = textOf(await ui.find({ type: 'Box' }))
      expect(all).toContain('Bump deps')
      expect(all).not.toContain('Preview it')
      expect(urls[1]).toBe('https://api.render.com/v1/services/srv-1/deploys?limit=1')
    })
  })
}

describe('requests', () => {
  test('lists services then each one\'s deploys, filtered by services, with the key as bearer', { options: { services: 'api' } }, async ($, on) => {
    const { clock, urls, auths } = setup(on)
    await openPane($, clock, 'terminal')
    expect(urls).toEqual([SERVICES_URL, deploysOf('srv-1')])
    expect(auths.every(a => a === 'Bearer rtok-secret')).toBe(true)
  })

  test('a service filter that matches nothing says so', { options: { services: 'nope' } }, async ($, on) => {
    const { clock } = setup(on)
    const ui = await openPane($, clock, 'terminal')
    expect(await ui.find({ text: 'no service named nope' })).toBeDefined()
  })

  test('max_services caps the fan-out and says how many were left out', { options: { max_services: 1 } }, async ($, on) => {
    const { clock, urls } = setup(on)
    const ui = await openPane($, clock, 'terminal')
    expect(urls).toEqual([SERVICES_URL, deploysOf('srv-1')])
    expect(await ui.find({ text: '1 more services not shown: set services or max_services' })).toBeDefined()
  })

  test('a worktree\'s branch is read through its gitdir', async ($, on) => {
    const { clock } = setup(on, {
      files: {
        '/work/.git': 'gitdir: /repo/.git/worktrees/w1\n',
        '/repo/.git/worktrees/w1/HEAD': 'ref: refs/heads/main\n',
      },
    })
    const ui = await openPane($, clock, 'terminal')
    expect(textOf(await ui.find({ type: 'Box' }))).toMatch(/› error\s+api prod main/)
  })
})

describe('refresh cadence and load', () => {
  test('while building, fast polls fetch only the building service; a full refresh every refresh_seconds', async ($, on) => {
    const { clock, urls, states, pane } = setup(on, { states: { 'srv-1': 'build_in_progress', 'srv-2': 'live' } })
    const ui = await openPane($, clock, 'terminal')
    expect(urls.length).toBe(3)
    for (let i = 0; i < 5; i++) await clock.advance(10_000)
    expect(urls.slice(3)).toEqual(Array(5).fill(deploysOf('srv-1')))
    // the other service's rows survive the partial polls
    expect(await ui.find({ text: /Preview it/ })).toBeDefined()
    await clock.advance(10_000) // 60s since the last full refresh
    expect(urls.slice(8)).toEqual([SERVICES_URL, deploysOf('srv-1'), deploysOf('srv-2')])
    states['srv-1'] = 'live'
    await clock.advance(10_000) // sees the build finish
    expect(urls.length).toBe(12)
    await clock.advance(10_000)
    expect(urls.length).toBe(12) // nothing building: slow cadence
    await clock.advance(50_000)
    expect(urls.length).toBe(15) // full refresh
    pane.open = false
    await clock.advance(600_000)
    expect(urls.length).toBe(15)
  })

  test('a fast poll that fails keeps the service\'s last rows and shows the error', async ($, on) => {
    let fail = false
    const { clock } = setup(on, {
      states: { 'srv-1': 'build_in_progress', 'srv-2': 'live' },
      deploys: id => (fail && id === 'srv-1' ? { status: 502, body: {} } : undefined),
    })
    const ui = await openPane($, clock, 'terminal')
    fail = true
    await clock.advance(10_000)
    expect(await ui.find({ text: 'Render HTTP 502' })).toBeDefined()
    expect(textOf(await ui.find({ type: 'Box' }))).toMatch(/building\s+api prod main/)
  })

  test('refresh_seconds and building_refresh_seconds set the intervals', { options: { refresh_seconds: 30, building_refresh_seconds: 5 } }, async ($, on) => {
    const { clock, urls, states } = setup(on, { states: { 'srv-1': 'queued', 'srv-2': 'live' } })
    await openPane($, clock, 'terminal')
    await clock.advance(5_000)
    expect(urls.length).toBe(4)
    states['srv-1'] = 'live'
    await clock.advance(5_000)
    expect(urls.length).toBe(5)
    await clock.advance(30_000)
    expect(urls.length).toBe(8)
  })

  test('session.start registers the command and resumes polling when the pane is open', async ($, on) => {
    const { clock, urls, pane } = setup(on)
    const registered: string[] = []
    on('command.register', ($, e) => {
      registered.push(e.name)
      return { value: { command: e.name } }
    })
    on('session.start', () => ({ cwd: '/work' }))
    pane.open = true
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never)
    await clock.settle()
    expect(registered).toEqual(['render-deploys'])
    expect(urls.length).toBe(3)
  })
})

describe('finish toast', () => {
  const building = { 'srv-1': 'live', 'srv-2': 'build_in_progress' }

  test('with notify_on_finish, a closed pane still toasts when the branch deploy is live', { options: { notify_on_finish: true } }, async ($, on) => {
    const { clock, urls, pane, toasts, states } = setup(on, { states: { ...building } })
    await openPane($, clock, 'terminal')
    pane.open = false
    await clock.advance(10_000) // still building: keeps watching
    expect(toasts).toEqual([])
    states['srv-2'] = 'live'
    await clock.advance(10_000)
    expect(toasts).toEqual(['api-pr-7 (feature-x) is live on Render'])
    const after = urls.length
    await clock.advance(600_000) // nothing left to watch: stopped
    expect(urls.length).toBe(after)
  })

  test('a failed branch deploy toasts too', { options: { notify_on_finish: true } }, async ($, on) => {
    const { clock, pane, toasts, states } = setup(on, { states: { ...building } })
    await openPane($, clock, 'terminal')
    pane.open = false
    states['srv-2'] = 'update_failed'
    await clock.advance(10_000)
    expect(toasts).toEqual(['api-pr-7 (feature-x) failed on Render'])
  })

  test('off by default: closing the pane stops polling, no toast', async ($, on) => {
    const { clock, urls, pane, toasts, states } = setup(on, { states: { ...building } })
    await openPane($, clock, 'terminal')
    pane.open = false
    states['srv-2'] = 'live'
    await clock.advance(60_000)
    expect(urls.length).toBe(3)
    expect(toasts).toEqual([])
  })

  test('no toast while the pane is open', { options: { notify_on_finish: true } }, async ($, on) => {
    const { clock, toasts, states } = setup(on, { states: { ...building } })
    await openPane($, clock, 'terminal')
    states['srv-2'] = 'live'
    await clock.advance(10_000)
    expect(toasts).toEqual([])
  })
})

describe('pure helpers', () => {
  test('state normalization', () => {
    expect(['created', 'queued', 'build_in_progress', 'update_in_progress', 'pre_deploy_in_progress', 'live', 'deactivated',
      'build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'wat'].map(normalizeState))
      .toEqual(['building', 'building', 'building', 'building', 'building', 'ready', 'ready', 'error', 'error', 'error', 'canceled', 'error'])
  })

  test('parsing tolerates missing fields', () => {
    const [r] = parseDeploys({ id: 's', name: 'svc', preview: false }, [{ deploy: { id: 'd', status: 'queued' } }, {}])
    expect(r).toMatchObject({ service: 'svc', serviceId: 's', env: 'prod', state: 'building', createdAt: 0 })
    expect(r!.url).toBeUndefined()
  })

  test('service cap and building services', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ service: { id: `s${i}`, name: `n${i}` } }))
    const { services, skipped } = pickServices(many, [], 10)
    expect(services.length).toBe(10)
    expect(skipped).toBe(15)
    const d = (serviceId: string, state: 'building' | 'ready') => ({ id: `${serviceId}${state}`, serviceId, service: serviceId, env: 'prod', state, createdAt: 0 })
    expect(buildingServiceIds([d('a', 'building'), d('a', 'building'), d('b', 'ready')])).toEqual(['a'])
  })

  test('config parsing, branch, age', () => {
    expect(parseConfig({ services: 'a, b', max_services: 0, max_rows: 0, refresh_seconds: 120 }))
      .toMatchObject({ services: ['a', 'b'], maxServices: 10, maxRows: 15, slowMs: 120_000, fastMs: 10_000, notify: false })
    expect(branchFromHead('ref: refs/heads/feat/a-b\n')).toBe('feat/a-b')
    expect(branchFromHead('0123abcd\n')).toBeUndefined()
    expect([age(NOW - 59 * MIN, NOW), age(NOW - 3 * 60 * MIN, NOW), age(NOW - 72 * 60 * MIN, NOW)]).toEqual(['59m', '3h', '3d'])
  })
})
