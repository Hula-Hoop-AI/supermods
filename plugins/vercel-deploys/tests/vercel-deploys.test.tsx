import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { deploymentsUrl, normalizeState, parseDeployments } from '../hooks/vercel'
import { age, branchFromHead, parseConfig } from '../hooks/register'

const NOW = 1_800_000_000_000
const MIN = 60_000
const PANE = 'vercel-deploys'

const vercelBody = (state = 'BUILDING') => ({
  deployments: [
    {
      uid: 'dpl_2', name: 'web', url: 'web-prod.vercel.app', created: NOW - 120 * MIN, readyState: 'READY',
      target: 'production', creator: { uid: 'u2', username: 'bob' },
      meta: { githubCommitRef: 'main', githubCommitSha: '1234567aaaa', githubCommitMessage: 'Release' },
    },
    {
      uid: 'dpl_1', name: 'web', url: 'web-abc.vercel.app', created: NOW - 5 * MIN, readyState: state,
      target: null, creator: { uid: 'u1', username: 'alice' }, inspectorUrl: 'https://vercel.com/acme/web/1',
      meta: { githubCommitRef: 'feature-x', githubCommitSha: 'abcdef1234567', githubCommitMessage: 'Add login\n\nlong body' },
    },
  ],
  pagination: { count: 2, next: null, prev: null },
})

type Reply = { status: number; body: unknown } | 'unreachable'
type Call = { url: string; auth?: string }

type Setup = {
  env?: Record<string, string>
  files?: Record<string, string>
  vercel?: () => Reply
}

// Stubs everything the mod reaches; returns handles to drive it.
function setup(on: On, s: Setup = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, s.env ?? { VERCEL_TOKEN: 'vtok-secret' })
  const files = s.files ?? { '/work/.git/HEAD': 'ref: refs/heads/feature-x\n' }
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path]! } : { deny: 'ENOENT' }))
  const pane = { open: false }
  on('ui.open', () => {
    pane.open = true
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({
    value: pane.open ? [{ id: PANE, title: 'Vercel deploys', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const calls: Call[] = []
  const vercel = s.vercel ?? (() => ({ status: 200, body: vercelBody() }))
  on('http.fetch', async ($, e) => {
    calls.push({ url: e.url, auth: e.init?.headers?.Authorization })
    const reply = vercel()
    if (reply === 'unreachable') return { deny: 'getaddrinfo ENOTFOUND' }
    return { value: { status: reply.status, ok: reply.status < 300, headers: {}, text: JSON.stringify(reply.body) } }
  })
  return { clock, calls, pane, toasts }
}

const PANE_PROPS = {
  title: 'Vercel deploys', isFocused: false, bodyColumns: 100, placement: 'inline',
  scroll: { offset: 0, bodyRows: 30 }, view: {},
}

async function openPane($: Engine, clock: { settle: () => Promise<void> }, surface: 'terminal' | 'desktop') {
  await $.command.run({ command: 'vercel-deploys', args: '' } as never)
  await clock.settle()
  return $.ui.mount({
    plugin: 'vercel-deploys', surface, component: 'Pane', requestId: PANE,
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

for (const surface of ['terminal', 'desktop'] as const) {
  describe(surface, () => {
    test('lists deployments newest first, normalized, with the current branch marked', async ($, on) => {
      const { clock } = setup(on)
      const ui = await openPane($, clock, surface)
      const all = textOf(await ui.find({ type: 'Box' }))
      expect(all.indexOf('Add login')).toBeGreaterThan(-1)
      expect(all.indexOf('Add login')).toBeLessThan(all.indexOf('Release'))
      expect(all).toMatch(/› building web preview feature-x abcdef1 alice 5m ago/)
      expect(all).toMatch(/ {2}ready\s+web prod main 1234567 bob 2h ago/)
      expect(all).toContain('https://web-abc.vercel.app')
      expect(all).toMatch(/on feature-x/)
      expect(all).not.toContain('long body')
      expect(all).not.toContain('secret')
      expect(all).toMatch(/next in 10s \(building\)/)
    })

    test('a missing token shows inline and makes no request', async ($, on) => {
      const { clock, calls } = setup(on, { env: {} })
      const ui = await openPane($, clock, surface)
      expect(await ui.find({ text: 'VERCEL_TOKEN is not set' })).toBeDefined()
      expect(calls.length).toBe(0)
    })

    test('a rejected token shows inline', async ($, on) => {
      const { clock } = setup(on, { vercel: () => ({ status: 401, body: { error: { code: 'forbidden', message: 'Not authorized' } } }) })
      const ui = await openPane($, clock, surface)
      expect(await ui.find({ text: 'Vercel rejected the token (HTTP 401): check VERCEL_TOKEN' })).toBeDefined()
    })

    test('unreachable, server errors and rate limits say so', async ($, on) => {
      let reply: Reply = 'unreachable'
      const { clock } = setup(on, { vercel: () => reply })
      const ui = await openPane($, clock, surface)
      expect(await ui.find({ text: /Vercel unreachable/ })).toBeDefined()
      reply = { status: 500, body: { error: { message: 'internal error' } } }
      await ui.press({ key: 'refresh' })
      await clock.settle()
      expect(await ui.find({ text: 'Vercel HTTP 500: internal error' })).toBeDefined()
      reply = { status: 429, body: {} }
      await ui.press({ key: 'refresh' })
      await clock.settle()
      expect(await ui.find({ text: /Vercel rate limit hit/ })).toBeDefined()
    })

    test('an empty list says so', async ($, on) => {
      const { clock } = setup(on, { vercel: () => ({ status: 200, body: { deployments: [] } }) })
      const ui = await openPane($, clock, surface)
      expect(await ui.find({ text: 'No deployments found.' })).toBeDefined()
    })

    test('the Refresh button fetches again', async ($, on) => {
      const { clock, calls } = setup(on)
      const ui = await openPane($, clock, surface)
      expect(calls.length).toBe(1)
      await ui.press({ key: 'refresh' })
      await clock.settle()
      expect(calls.length).toBe(2)
    })

    test('max_rows caps the list', { options: { max_rows: 1 } }, async ($, on) => {
      const { clock, calls } = setup(on)
      const ui = await openPane($, clock, surface)
      const all = textOf(await ui.find({ type: 'Box' }))
      expect(all).toContain('Add login')
      expect(all).not.toContain('Release')
      expect(calls[0]!.url).toContain('limit=1')
    })
  })
}

describe('requests', () => {
  test('v7 list, bearer token, linked project and team from .vercel/project.json', async ($, on) => {
    const { clock, calls } = setup(on, {
      files: {
        '/work/.git/HEAD': 'ref: refs/heads/main\n',
        '/work/.vercel/project.json': JSON.stringify({ projectId: 'prj_1', orgId: 'team_9' }),
      },
    })
    const ui = await openPane($, clock, 'terminal')
    expect(calls[0]!.url).toBe('https://api.vercel.com/v7/deployments?limit=15&projectId=prj_1&teamId=team_9')
    expect(calls[0]!.auth).toBe('Bearer vtok-secret')
    expect(await ui.find({ text: 'project from .vercel/project.json' })).toBeDefined()
  })

  test('the link is found from a subdirectory', async ($, on) => {
    const { clock, calls } = setup(on, {
      files: { '/.vercel/project.json': JSON.stringify({ projectId: 'prj_up' }) },
    })
    await openPane($, clock, 'terminal')
    expect(calls[0]!.url).toBe('https://api.vercel.com/v7/deployments?limit=15&projectId=prj_up')
  })

  test('settings win over the link; a slug goes as slug', { options: { team: 'acme', project: 'web' } }, async ($, on) => {
    const { clock, calls } = setup(on, {
      files: { '/work/.vercel/project.json': JSON.stringify({ projectId: 'prj_1', orgId: 'team_9' }) },
    })
    await openPane($, clock, 'terminal')
    expect(calls[0]!.url).toBe('https://api.vercel.com/v7/deployments?limit=15&projectId=web&slug=acme')
  })

  test('a team id setting goes as teamId', { options: { team: 'team_abc' } }, async ($, on) => {
    const { clock, calls } = setup(on)
    await openPane($, clock, 'terminal')
    expect(calls[0]!.url).toBe('https://api.vercel.com/v7/deployments?limit=15&teamId=team_abc')
  })

  test('a personal link sends no team', async ($, on) => {
    const { clock, calls } = setup(on, {
      files: { '/work/.vercel/project.json': JSON.stringify({ projectId: 'prj_1', orgId: 'user_abc' }) },
    })
    await openPane($, clock, 'terminal')
    expect(calls[0]!.url).toBe('https://api.vercel.com/v7/deployments?limit=15&projectId=prj_1')
  })

  test('a worktree\'s branch is read through its gitdir', async ($, on) => {
    const { clock } = setup(on, {
      files: {
        '/work/.git': 'gitdir: /repo/.git/worktrees/w1\n',
        '/repo/.git/worktrees/w1/HEAD': 'ref: refs/heads/main\n',
      },
    })
    const ui = await openPane($, clock, 'terminal')
    expect(textOf(await ui.find({ type: 'Box' }))).toMatch(/› ready\s+web prod main/)
  })
})

describe('refresh cadence', () => {
  test('fast while building, slow once nothing builds, stopped when the pane closes', async ($, on) => {
    let state = 'BUILDING'
    const { clock, calls, pane } = setup(on, { vercel: () => ({ status: 200, body: vercelBody(state) }) })
    await openPane($, clock, 'terminal')
    expect(calls.length).toBe(1)
    await clock.advance(10_000)
    expect(calls.length).toBe(2)
    state = 'READY'
    await clock.advance(10_000) // this poll sees nothing building
    expect(calls.length).toBe(3)
    await clock.advance(10_000)
    expect(calls.length).toBe(3)
    await clock.advance(50_000)
    expect(calls.length).toBe(4)
    pane.open = false
    await clock.advance(60_000)
    await clock.advance(600_000)
    expect(calls.length).toBe(4)
  })

  test('refresh_seconds and building_refresh_seconds set the intervals', { options: { refresh_seconds: 30, building_refresh_seconds: 5 } }, async ($, on) => {
    let state = 'BUILDING'
    const { clock, calls } = setup(on, { vercel: () => ({ status: 200, body: vercelBody(state) }) })
    await openPane($, clock, 'terminal')
    await clock.advance(5_000)
    expect(calls.length).toBe(2)
    state = 'READY'
    await clock.advance(5_000)
    expect(calls.length).toBe(3)
    await clock.advance(30_000)
    expect(calls.length).toBe(4)
  })

  test('session.start registers the command and resumes polling when the pane is open', async ($, on) => {
    const { clock, calls, pane } = setup(on)
    const registered: string[] = []
    on('command.register', ($, e) => {
      registered.push(e.name)
      return { value: { command: e.name } }
    })
    on('session.start', () => ({ cwd: '/work' }))
    pane.open = true
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never)
    await clock.settle()
    expect(registered).toEqual(['vercel-deploys'])
    expect(calls.length).toBe(1)
  })
})

describe('finish toast', () => {
  test('with notify_on_finish, a closed pane still toasts when the branch build is ready', { options: { notify_on_finish: true } }, async ($, on) => {
    let state = 'BUILDING'
    const { clock, calls, pane, toasts } = setup(on, { vercel: () => ({ status: 200, body: vercelBody(state) }) })
    await openPane($, clock, 'terminal')
    pane.open = false
    await clock.advance(10_000) // still building: keeps watching
    expect(toasts).toEqual([])
    state = 'READY'
    await clock.advance(10_000)
    expect(toasts).toEqual(['web (feature-x) is ready on Vercel'])
    const after = calls.length
    await clock.advance(600_000) // nothing left to watch: stopped
    expect(calls.length).toBe(after)
  })

  test('a failed branch build toasts too', { options: { notify_on_finish: true } }, async ($, on) => {
    let state = 'BUILDING'
    const { clock, pane, toasts } = setup(on, { vercel: () => ({ status: 200, body: vercelBody(state) }) })
    await openPane($, clock, 'terminal')
    pane.open = false
    state = 'ERROR'
    await clock.advance(10_000)
    expect(toasts).toEqual(['web (feature-x) failed on Vercel'])
  })

  test('off by default: closing the pane stops polling, no toast', async ($, on) => {
    let state = 'BUILDING'
    const { clock, calls, pane, toasts } = setup(on, { vercel: () => ({ status: 200, body: vercelBody(state) }) })
    await openPane($, clock, 'terminal')
    pane.open = false
    state = 'READY'
    await clock.advance(60_000)
    expect(calls.length).toBe(1)
    expect(toasts).toEqual([])
  })

  test('no toast while the pane is open', { options: { notify_on_finish: true } }, async ($, on) => {
    let state = 'BUILDING'
    const { clock, toasts } = setup(on, { vercel: () => ({ status: 200, body: vercelBody(state) }) })
    await openPane($, clock, 'terminal')
    state = 'READY'
    await clock.advance(10_000)
    expect(toasts).toEqual([])
  })
})

describe('pure helpers', () => {
  test('state normalization', () => {
    expect(['QUEUED', 'INITIALIZING', 'BUILDING', 'READY', 'ERROR', 'BLOCKED', 'CANCELED', 'DELETED', 'WAT'].map(normalizeState))
      .toEqual(['building', 'building', 'building', 'ready', 'error', 'error', 'canceled', 'canceled', 'error'])
  })

  test('parsing tolerates missing git metadata', () => {
    const [d] = parseDeployments({ deployments: [{ uid: 'x', name: 'n', created: 1, readyState: 'READY', url: null, inspectorUrl: 'https://i' }] })
    expect(d).toMatchObject({ env: 'preview', state: 'ready', url: 'https://i' })
    expect(d!.branch).toBeUndefined()
    expect(parseDeployments({ deployments: [{ uid: 'y', name: 'n', created: 1, state: 'READY', target: 'staging', customEnvironment: { slug: 'qa' } }] })[0]!.env).toBe('qa')
    expect(parseDeployments({}).length).toBe(0)
  })

  test('deploymentsUrl, config parsing, branch, age', () => {
    expect(deploymentsUrl({}, 5)).toBe('https://api.vercel.com/v7/deployments?limit=5')
    expect(parseConfig({ team: ' acme ', max_rows: 0, refresh_seconds: 120 }))
      .toMatchObject({ team: 'acme', project: '', maxRows: 15, slowMs: 120_000, fastMs: 10_000, notify: false })
    expect(branchFromHead('ref: refs/heads/feat/a-b\n')).toBe('feat/a-b')
    expect(branchFromHead('0123abcd\n')).toBeUndefined()
    expect([age(NOW - 59 * MIN, NOW), age(NOW - 3 * 60 * MIN, NOW), age(NOW - 72 * 60 * MIN, NOW)]).toEqual(['59m', '3h', '3d'])
  })
})
