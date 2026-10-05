import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildProviders } from '../hooks/providers'
import { parsePs } from '../hooks/providers/docker'
import { groupCliRows } from '../hooks/providers/modal'
import { buildingServiceIds, normalizeState as renderState, parseDeploys, pickServices } from '../hooks/providers/render'
import { deploymentsUrl, normalizeState as vercelState, parseDeployments } from '../hooks/providers/vercel'
import { fitRows } from '../hooks/tab-pane'
import { age } from '../hooks/util'
import { branchFromHead } from '../hooks/workspace'

const NOW = 1_800_000_000_000
const MIN = 60_000
const PANE = 'observe'
const iso = (ms: number) => new Date(ms).toISOString()
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

// ---- docker ----

type Run = { exitCode: number; stdout?: unknown; stderr?: string }
const jsonl = (rows: object[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
const PS = [
  { ID: 'aaa111', Image: 'nginx:1.27', Status: 'Up 3 hours', Ports: '0.0.0.0:8080->80/tcp', Names: 'webapp-web-1', State: 'running' },
  { ID: 'bbb222', Image: 'postgres:16', Status: 'Up 3 hours (healthy)', Ports: '5432/tcp', Names: 'webapp-db-1', State: 'running' },
]
const STOPPED = { ID: 'ddd444', Image: 'busybox', Status: 'Exited (0) 2 hours ago', Ports: '', Names: 'old-job', State: 'exited' }
const DOCKER_OK: Run = { exitCode: 0, stdout: jsonl(PS) }

// ---- modal ----

const HELPER = {
  me: 'alice',
  env: 'main',
  apps: [
    {
      app_id: 'ap-1', app_name: 'train-llm', created_by: 'alice',
      containers: [{ container_id: 'ta-1', started_at: 0 }, { container_id: 'ta-2', started_at: 0 }],
    },
    { app_id: 'ap-2', app_name: 'batch-embed', created_by: 'bob', containers: [{ container_id: 'ta-3', started_at: 0 }] },
  ],
}
const CLI_ROWS = [{ container_id: 'ta-9', app_id: 'ap-9', app_name: 'cli-only-app', start_time: 'Pending' }]
const BILLING = [
  { object_id: 'ap-1', cost: '1.25' },
  { object_id: 'ap-1', cost: '0.50' },
  { object_id: 'ap-2', cost: '3.00' },
]
type ModalAnswers = { helper: Run; list?: Run; billing: Run }
const MODAL_OK: ModalAnswers = { helper: { exitCode: 0, stdout: HELPER }, billing: { exitCode: 0, stdout: BILLING } }

// ---- render ----

const SERVICES = [
  { service: { id: 'srv-1', name: 'api', branch: 'main', dashboardUrl: 'https://dashboard.render.com/web/srv-1', serviceDetails: {} } },
  {
    service: {
      id: 'srv-2', name: 'api-pr-7', branch: 'feature-x', dashboardUrl: 'https://dashboard.render.com/web/srv-2',
      serviceDetails: { parentServer: { id: 'srv-1', name: 'api' } },
    },
  },
]
// Current status of each service's one deploy; tests change it to move builds along.
type States = Record<string, string>
const deploysFor = (id: string, states: States) =>
  id === 'srv-1'
    ? [{ deploy: { id: 'dep-1', status: states['srv-1'], trigger: 'new_commit', commit: { id: 'fff0001112223', message: 'Bump deps\nbody' }, createdAt: iso(NOW - 30 * MIN) } }]
    : id === 'srv-2'
      ? [{ deploy: { id: 'dep-2', status: states['srv-2'], trigger: 'manual', commit: { id: 'eee0001112223', message: 'Preview it' }, createdAt: iso(NOW - 60 * MIN) } }]
      : []
const SERVICES_URL = 'https://api.render.com/v1/services?limit=100'
const deploysOf = (id: string, limit = 15) => `https://api.render.com/v1/services/${id}/deploys?limit=${limit}`

// ---- vercel ----

const vercelBody = (state = 'BUILDING') => ({
  deployments: [
    {
      uid: 'dpl_2', name: 'web', url: 'web-prod.vercel.app', created: NOW - 120 * MIN, readyState: 'READY',
      target: 'production', creator: { username: 'bob' },
      meta: { githubCommitRef: 'main', githubCommitSha: '1234567aaaa', githubCommitMessage: 'Release' },
    },
    {
      uid: 'dpl_1', name: 'web', url: 'web-abc.vercel.app', created: NOW - 5 * MIN, readyState: state,
      target: null, creator: { username: 'alice' },
      meta: { githubCommitRef: 'feature-x', githubCommitSha: 'abcdef1234567', githubCommitMessage: 'Add login\n\nlong body' },
    },
  ],
})

// ---- the harness ----

type Reply = { status: number; body: unknown } | 'unreachable'
type Setup = {
  env?: Record<string, string>
  files?: Record<string, string>
  docker?: Run | Error
  modal?: ModalAnswers
  states?: States
  services?: () => Reply
  deploys?: (id: string) => Reply | undefined
  vercel?: () => Reply
  placed?: false
}

// Stubs everything the mod reaches; returns handles to drive it.
function setup(on: On, s: Setup = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, s.env ?? { RENDER_API_KEY: 'rtok-secret', VERCEL_TOKEN: 'vtok-secret' })
  const files = s.files ?? { '/work/.git/HEAD': 'ref: refs/heads/feature-x\n' }
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path]! } : { deny: 'ENOENT' }))
  const pane = { open: false }
  on('ui.open', () => {
    if (s.placed === false) return { value: { isPlaced: false as const, reason: 'this desktop places no panes' } }
    pane.open = true
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({
    value: pane.open ? [{ id: PANE, title: 'Observe', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const copied: string[] = []
  on('ui.copy', async ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })

  const argvs: string[][] = []
  const modal = s.modal ?? MODAL_OK
  on('process.run', async ($, e) => {
    argvs.push([...e.argv])
    let answer: Run | Error
    if (e.argv[0] === 'docker') answer = s.docker ?? DOCKER_OK
    else if (e.argv[0] === 'sh') answer = modal.helper
    else if (e.argv[1] === 'container') answer = modal.list ?? { exitCode: 1, stderr: 'no list' }
    else answer = modal.billing
    if (answer instanceof Error) return { deny: answer.message } // the run rejects with it
    const { exitCode, stdout = '', stderr = '' } = answer
    return {
      value: {
        exitCode, stderr, isStdoutTruncated: false, isStderrTruncated: false,
        stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
      },
    }
  })

  const states: States = s.states ?? { 'srv-1': 'build_failed', 'srv-2': 'live' }
  const urls: string[] = []
  const auths: (string | undefined)[] = []
  on('http.fetch', async ($, e) => {
    urls.push(e.url)
    auths.push(e.init?.headers?.Authorization)
    const m = /\/services\/([^/]+)\/deploys/.exec(e.url)
    const reply: Reply = e.url.includes('vercel.com')
      ? (s.vercel?.() ?? { status: 200, body: vercelBody() })
      : m
        ? (s.deploys?.(m[1]!) ?? { status: 200, body: deploysFor(m[1]!, states) })
        : (s.services?.() ?? { status: 200, body: SERVICES })
    if (reply === 'unreachable') return { deny: 'getaddrinfo ENOTFOUND' }
    return { value: { status: reply.status, ok: reply.status < 300, headers: {}, text: JSON.stringify(reply.body) } }
  })
  return { clock, pane, toasts, copied, argvs, urls, auths, states }
}

const PANE_PROPS = {
  title: 'Observe', isFocused: false, bodyColumns: 100, placement: 'inline',
  scroll: { offset: 0, bodyRows: 30 }, view: {},
}

async function openPane($: Engine, clock: { settle: () => Promise<void> }, args: string, surface: Surface = 'terminal') {
  await $.command.run({ command: 'observe', args } as never)
  await clock.settle() // let the first, unawaited refresh finish
  return $.ui.mount({
    plugin: 'observe', surface, component: 'Pane', requestId: PANE,
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

for (const surface of SURFACES) {
  describe(`tabs on ${surface}`, () => {
    test('/observe <provider> opens the pane on that tab, with a tab per provider', async ($, on) => {
      const { clock, argvs, urls } = setup(on)
      const ui = await openPane($, clock, 'modal', surface)
      expect((await ui.find({ key: 'tab:modal' }))?.props.variant).toBe('primary')
      for (const id of ['docker', 'render', 'vercel']) {
        expect((await ui.find({ key: `tab:${id}` }))?.props.variant).toBe('secondary')
      }
      expect(await ui.find({ text: /3 running containers/ })).toBeDefined()
      // only the tab on screen is fetched
      expect(argvs.some(a => a[0] === 'docker')).toBe(false)
      expect(urls).toEqual([])
    })

    test('pressing a tab switches provider and fetches it', async ($, on) => {
      const { clock, argvs } = setup(on)
      const ui = await openPane($, clock, 'modal', surface)
      await ui.press({ key: 'tab:docker' })
      await clock.settle()
      expect((await ui.find({ key: 'tab:docker' }))?.props.variant).toBe('primary')
      expect(argvs.at(-1)).toEqual(['docker', 'ps', '--format', '{{json .}}'])
      expect(await ui.find({ text: /2 containers running/ })).toBeDefined()
      expect(await ui.find({ text: /train-llm/ })).toBeUndefined()
    })

    test('every tab draws the same layout: summary, Refresh, rows, footer', async ($, on) => {
      const { clock } = setup(on)
      const ui = await openPane($, clock, 'docker', surface)
      for (const id of ['docker', 'modal', 'render', 'vercel']) {
        await ui.press({ key: `tab:${id}` })
        await clock.settle()
        expect(await ui.find({ key: 'refresh' })).toBeDefined()
        expect(await ui.find({ text: /^updated .* · every \d+s/ })).toBeDefined()
      }
    })
  })

  describe(`docker on ${surface}`, () => {
    test('one row per container in docker ps order, with a copy button', async ($, on) => {
      const { clock, argvs, copied } = setup(on)
      const ui = await openPane($, clock, 'docker', surface)
      expect(argvs).toEqual([['docker', 'ps', '--format', '{{json .}}']])
      const all = textOf(await ui.find({ type: 'Box' }))
      expect(all).toMatch(/● webapp-web-1 nginx:1\.27 Up 3 hours 0\.0\.0\.0:8080->80\/tcp/)
      expect(all).toMatch(/● webapp-db-1 {2}postgres:16 Up 3 hours \(healthy\) 5432\/tcp/)
      expect(all.indexOf('webapp-web-1')).toBeLessThan(all.indexOf('webapp-db-1'))
      expect(await ui.find({ text: /every 2s/ })).toBeDefined()
      await ui.press({ key: 'copy:bbb222' })
      expect(copied).toEqual(['webapp-db-1'])
    })

    test('a machine without docker shows one dim line', async ($, on) => {
      const { clock } = setup(on, {
        docker: new Error('$.process.run(docker) failed to start: ENOENT: Executable not found in $PATH: "docker"'),
      })
      const ui = await openPane($, clock, 'docker', surface)
      expect((await ui.find({ type: 'Text', text: 'Docker is not installed.' }))?.props.dimColor).toBe(true)
    })

    test('a stopped daemon shows one dim line', async ($, on) => {
      const { clock } = setup(on, {
        docker: { exitCode: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' },
      })
      const ui = await openPane($, clock, 'docker', surface)
      expect((await ui.find({ type: 'Text', text: 'The Docker daemon is not running.' }))?.props.dimColor).toBe(true)
    })

    test('a denied socket, another failure and a timeout are shown in red', async ($, on) => {
      const failures: [Run | Error, string | RegExp][] = [
        [{ exitCode: 1, stderr: 'permission denied while trying to connect to the Docker daemon socket' }, 'permission denied on the Docker socket'],
        [{ exitCode: 1, stderr: 'context "nope": context not found' }, 'context "nope": context not found'],
        [new Error('process timed out after 5000 ms'), /timed out/],
      ]
      const s: Setup = {}
      const { clock } = setup(on, s)
      const ui = await openPane($, clock, 'docker', surface)
      for (const [answer, text] of failures) {
        s.docker = answer
        await ui.press({ key: 'refresh' })
        await clock.settle()
        expect((await ui.find({ type: 'Text', text }))?.props.color).toBe('red')
        expect(await ui.find({ text: /not installed/ })).toBeUndefined()
      }
    })

    test('an empty list says so', async ($, on) => {
      const { clock } = setup(on, { docker: { exitCode: 0, stdout: '' } })
      const ui = await openPane($, clock, 'docker', surface)
      expect(await ui.find({ text: 'No containers running.' })).toBeDefined()
    })

    test('docker_context and docker_all reach the docker command', { options: { docker_context: 'remote', docker_all: true } }, async ($, on) => {
      const { clock, argvs } = setup(on, { docker: { exitCode: 0, stdout: jsonl([...PS, STOPPED]) } })
      const ui = await openPane($, clock, 'docker', surface)
      expect(argvs).toEqual([['docker', '--context', 'remote', 'ps', '--all', '--format', '{{json .}}']])
      const all = textOf(await ui.find({ type: 'Box' }))
      expect(all).toMatch(/3 containers · remote/)
      expect(all).toMatch(/● old-job +busybox Exited \(0\) 2 hours ago/)
    })
  })

  describe(`modal on ${surface}`, () => {
    test('groups containers by app with creator and cost', async ($, on) => {
      const { clock } = setup(on, { env: {} })
      const ui = await openPane($, clock, 'modal', surface)
      const all = textOf(await ui.find({ type: 'Box' }))
      expect(all).toMatch(/3 running containers · main/)
      expect(all).toMatch(/train-llm +×2 alice \$1\.75 pending/)
      expect(all).toMatch(/batch-embed bob \$3\.00 pending/)
      expect(all).toMatch(/every 20s · cost: billed full hours, last 7d/)
    })

    test("the Mine only button keeps the user's own apps", async ($, on) => {
      const { clock } = setup(on, { env: {} })
      const ui = await openPane($, clock, 'modal', surface)
      await ui.press({ key: 'mine' })
      expect(await ui.find({ text: /2 running containers/ })).toBeDefined()
      expect(await ui.find({ text: /batch-embed/ })).toBeUndefined()
      await ui.press({ key: 'mine' })
      expect(await ui.find({ text: /batch-embed/ })).toBeDefined()
    })

    test('falls back to the plain CLI when the helper fails', async ($, on) => {
      const { clock } = setup(on, {
        env: { MODAL_ENVIRONMENT: 'dev' },
        modal: {
          helper: { exitCode: 1, stderr: "ImportError: cannot import name '_Client'" },
          list: { exitCode: 0, stdout: CLI_ROWS },
          billing: { exitCode: 0, stdout: [] },
        },
      })
      const ui = await openPane($, clock, 'modal', surface)
      expect(await ui.find({ text: /cli-only-app/ })).toBeDefined()
      expect(await ui.find({ text: /creators unavailable/ })).toBeDefined()
      expect(await ui.find({ text: /· dev/ })).toBeDefined()
      expect(await ui.find({ key: 'mine' })).toBeUndefined()
    })

    test('modal_environment wins over MODAL_ENVIRONMENT', { options: { modal_environment: 'staging' } }, async ($, on) => {
      const { clock, argvs } = setup(on, {
        env: { MODAL_ENVIRONMENT: 'dev' },
        modal: { helper: { exitCode: 1, stderr: 'no helper' }, list: { exitCode: 0, stdout: [] }, billing: { exitCode: 0, stdout: [] } },
      })
      const ui = await openPane($, clock, 'modal', surface)
      expect(argvs.find(a => a[0] === 'sh')?.at(-1)).toBe('staging')
      expect(argvs.find(a => a[1] === 'container')).toEqual(['modal', 'container', 'list', '--json', '--env', 'staging'])
      expect(await ui.find({ text: /staging/ })).toBeDefined()
    })

    test('shows the error when nothing can be listed', async ($, on) => {
      const { clock } = setup(on, {
        env: {},
        modal: { helper: { exitCode: 127 }, list: { exitCode: 1, stderr: 'Token missing' }, billing: { exitCode: 1, stderr: 'Token missing' } },
      })
      const ui = await openPane($, clock, 'modal', surface)
      expect((await ui.find({ type: 'Text', text: 'Token missing' }))?.props.color).toBe('red')
    })

    test('keeps listing when billing is denied', async ($, on) => {
      const { clock } = setup(on, {
        env: {},
        modal: { helper: { exitCode: 0, stdout: HELPER }, billing: { exitCode: 1, stderr: 'PermissionDenied: billing requires a manager role' } },
      })
      const ui = await openPane($, clock, 'modal', surface)
      expect(await ui.find({ text: /cost unavailable: PermissionDenied/ })).toBeDefined()
      expect(await ui.find({ text: /train-llm/ })).toBeDefined()
      expect(await ui.find({ text: /\$—/ })).toBeUndefined()
    })
  })

  describe(`render on ${surface}`, () => {
    test('lists deploys newest first, normalized, with the current branch marked', async ($, on) => {
      const { clock } = setup(on)
      const ui = await openPane($, clock, 'render', surface)
      const all = textOf(await ui.find({ type: 'Box' }))
      expect(all.indexOf('Bump deps')).toBeLessThan(all.indexOf('Preview it'))
      expect(all).toMatch(/ {2}error api +prod main fff0001 new commit 30m/)
      expect(all).toMatch(/› ready api-pr-7 preview feature-x eee0001 manual 1h/)
      expect(all).toContain('https://dashboard.render.com/web/srv-2/deploys/dep-2')
      expect(all).toMatch(/2 deploys · on feature-x/)
      expect(all).not.toContain('body')
      expect(all).not.toContain('secret')
      expect(all).toMatch(/every 60s/)
    })

    test('a missing key shows inline and makes no request', async ($, on) => {
      const { clock, urls } = setup(on, { env: {} })
      const ui = await openPane($, clock, 'render', surface)
      expect((await ui.find({ type: 'Text', text: 'RENDER_API_KEY is not set' }))?.props.color).toBe('red')
      expect(urls).toEqual([])
    })

    test('a rejected key, an unreachable API and a rate limit say so', async ($, on) => {
      const s: Setup = {}
      const { clock } = setup(on, s)
      const failures: [Reply, string | RegExp][] = [
        [{ status: 401, body: {} }, 'Render rejected the key (HTTP 401): check RENDER_API_KEY'],
        ['unreachable', /^Render unreachable: /],
        [{ status: 500, body: { message: 'boom' } }, 'Render HTTP 500: boom'],
        [{ status: 429, body: {} }, /^Render rate limit hit \(HTTP 429\)/],
      ]
      const ui = await openPane($, clock, 'render', surface)
      for (const [reply, text] of failures) {
        s.services = () => reply
        await ui.press({ key: 'refresh' })
        await clock.settle()
        expect(await ui.find({ type: 'Text', text })).toBeDefined()
      }
    })

    test('one service failing keeps the rest', async ($, on) => {
      const { clock } = setup(on, { deploys: id => (id === 'srv-2' ? { status: 503, body: {} } : undefined) })
      const ui = await openPane($, clock, 'render', surface)
      expect(await ui.find({ text: 'Render HTTP 503' })).toBeDefined()
      expect(await ui.find({ text: /Bump deps/ })).toBeDefined()
    })

    test('no services says so', async ($, on) => {
      const { clock } = setup(on, { services: () => ({ status: 200, body: [] }) })
      const ui = await openPane($, clock, 'render', surface)
      expect(await ui.find({ text: 'No deploys found.' })).toBeDefined()
    })

    test('the Refresh button does a full refresh', async ($, on) => {
      const { clock, urls } = setup(on)
      const ui = await openPane($, clock, 'render', surface)
      expect(urls.length).toBe(3)
      await ui.press({ key: 'refresh' })
      await clock.settle()
      expect(urls.slice(3)).toEqual([SERVICES_URL, deploysOf('srv-1'), deploysOf('srv-2')])
    })

    test('deploy_max_rows caps the list and the per-service request', { options: { deploy_max_rows: 1 } }, async ($, on) => {
      const { clock, urls } = setup(on)
      const ui = await openPane($, clock, 'render', surface)
      const all = textOf(await ui.find({ type: 'Box' }))
      expect(all).toContain('Bump deps')
      expect(all).not.toContain('Preview it')
      expect(urls[1]).toBe(deploysOf('srv-1', 1))
    })
  })

  describe(`vercel on ${surface}`, () => {
    test('lists deployments newest first, normalized, with the current branch marked', async ($, on) => {
      const { clock } = setup(on)
      const ui = await openPane($, clock, 'vercel', surface)
      const all = textOf(await ui.find({ type: 'Box' }))
      expect(all.indexOf('Add login')).toBeLessThan(all.indexOf('Release'))
      expect(all).toMatch(/› building web preview feature-x abcdef1 alice 5m/)
      expect(all).toMatch(/ {2}ready {4}web prod main 1234567 bob 2h/)
      expect(all).toContain('https://web-abc.vercel.app')
      expect(all).toMatch(/2 deploys, 1 building · on feature-x/)
      expect(all).not.toContain('long body')
      expect(all).not.toContain('secret')
      expect(all).toMatch(/every 10s/)
    })

    test('a missing token shows inline and makes no request', async ($, on) => {
      const { clock, urls } = setup(on, { env: {} })
      const ui = await openPane($, clock, 'vercel', surface)
      expect((await ui.find({ type: 'Text', text: 'VERCEL_TOKEN is not set' }))?.props.color).toBe('red')
      expect(urls).toEqual([])
    })

    test('a rejected token, an unreachable API and a rate limit say so', async ($, on) => {
      const s: Setup = {}
      const { clock } = setup(on, s)
      const failures: [Reply, string | RegExp][] = [
        [{ status: 403, body: {} }, 'Vercel rejected the token (HTTP 403): check VERCEL_TOKEN'],
        ['unreachable', /^Vercel unreachable: /],
        [{ status: 500, body: { error: { message: 'boom' } } }, 'Vercel HTTP 500: boom'],
        [{ status: 429, body: {} }, 'Vercel rate limit hit (HTTP 429): raise the refresh intervals'],
      ]
      const ui = await openPane($, clock, 'vercel', surface)
      for (const [reply, text] of failures) {
        s.vercel = () => reply
        await ui.press({ key: 'refresh' })
        await clock.settle()
        expect(await ui.find({ type: 'Text', text })).toBeDefined()
      }
    })

    test('an empty list says so', async ($, on) => {
      const { clock } = setup(on, { vercel: () => ({ status: 200, body: { deployments: [] } }) })
      const ui = await openPane($, clock, 'vercel', surface)
      expect(await ui.find({ text: 'No deploys found.' })).toBeDefined()
    })
  })
}

describe('the command', () => {
  test('no argument reopens the last tab; the first provider at the start', async ($, on) => {
    const { clock } = setup(on)
    const first = await $.command.run({ command: 'observe', args: '' } as never)
    expect(first.text).toBe('Observe pane opened on Docker.')
    await $.command.run({ command: 'observe', args: ' Render ' } as never)
    const ui = await openPane($, clock, '')
    expect((await ui.find({ key: 'tab:render' }))?.props.variant).toBe('primary')
  })

  test('an unknown provider is named with the valid ones and opens nothing', async ($, on) => {
    const { clock, pane } = setup(on)
    const out = await $.command.run({ command: 'observe', args: 'k8s' } as never)
    await clock.settle()
    expect(out.text).toBe('No provider named "k8s". Use one of: docker, modal, render, vercel.')
    expect(pane.open).toBe(false)
  })

  test('the providers setting picks and orders the tabs', { options: { providers: ['vercel', 'docker', 'nope'] } }, async ($, on) => {
    const { clock } = setup(on)
    const ui = await openPane($, clock, '')
    expect((await ui.find({ key: 'tab:vercel' }))?.props.variant).toBe('primary')
    expect(await ui.find({ key: 'tab:docker' })).toBeDefined()
    expect(await ui.find({ key: 'tab:modal' })).toBeUndefined()
    const out = await $.command.run({ command: 'observe', args: 'modal' } as never)
    expect(out.text).toBe('No provider named "modal". Use one of: vercel, docker.')
  })

  test('a single provider draws no tab row', { options: { providers: ['docker'] } }, async ($, on) => {
    const { clock } = setup(on)
    const ui = await openPane($, clock, '')
    expect(await ui.find({ key: 'tab:docker' })).toBeUndefined()
    expect(await ui.find({ text: /2 containers running/ })).toBeDefined()
  })

  test('says so when the surface does not show the pane', async ($, on) => {
    const { clock } = setup(on, { placed: false })
    const out = await $.command.run({ command: 'observe', args: 'docker' } as never)
    await clock.settle()
    expect(out.text).toBe('The Observe pane is open, but this surface is not showing it: this desktop places no panes')
  })

  test('session.start registers the command and resumes polling when the pane is open', async ($, on) => {
    const { clock, argvs, pane } = setup(on)
    const registered: { name: string; argumentHint?: string }[] = []
    on('command.register', ($, e) => {
      registered.push({ name: e.name, argumentHint: e.argumentHint })
      return { value: { command: e.name } }
    })
    on('session.start', () => ({ cwd: '/work' }))
    pane.open = true
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never)
    await clock.settle()
    expect(registered).toEqual([{ name: 'observe', argumentHint: '[docker|modal|render|vercel]' }])
    expect(argvs).toHaveLength(1)
  })
})

describe('refresh cadence', () => {
  test('docker polls every 2s by default and stops once the pane is closed', async ($, on) => {
    const { clock, argvs, pane } = setup(on)
    await openPane($, clock, 'docker')
    expect(argvs).toHaveLength(1)
    await clock.advance(1_999)
    expect(argvs).toHaveLength(1)
    await clock.advance(1)
    expect(argvs).toHaveLength(2)
    await clock.advance(2_000)
    expect(argvs).toHaveLength(3)
    pane.open = false
    await clock.advance(60_000)
    expect(argvs).toHaveLength(3)
  })

  test('docker_refresh_seconds sets the interval', { options: { docker_refresh_seconds: 30 } }, async ($, on) => {
    const { clock, argvs } = setup(on)
    const ui = await openPane($, clock, 'docker')
    expect(await ui.find({ text: /every 30s/ })).toBeDefined()
    await clock.advance(29_000)
    expect(argvs).toHaveLength(1)
    await clock.advance(1_000)
    expect(argvs).toHaveLength(2)
  })

  test('only the tab on screen keeps polling after a switch', async ($, on) => {
    const { clock, argvs, urls } = setup(on)
    const ui = await openPane($, clock, 'docker')
    await ui.press({ key: 'tab:vercel' })
    await clock.settle()
    const dockerCalls = argvs.length
    await clock.advance(10_000)
    expect(argvs).toHaveLength(dockerCalls)
    expect(urls).toHaveLength(2)
  })

  test('modal refreshes containers every 20s and costs every 5 minutes', async ($, on) => {
    const { clock, argvs } = setup(on, { env: {} })
    await openPane($, clock, 'modal')
    const billing = () => argvs.filter(a => a[1] === 'billing').length
    const helper = () => argvs.filter(a => a[0] === 'sh').length
    expect([helper(), billing()]).toEqual([1, 1])
    await clock.advance(20_000)
    expect([helper(), billing()]).toEqual([2, 1])
    for (let i = 0; i < 14; i++) await clock.advance(20_000)
    expect([helper(), billing()]).toEqual([16, 2])
  })

  test('render: while building, fast polls fetch only the building service; a full refresh every deploy_refresh_seconds', async ($, on) => {
    const { clock, urls, states, pane } = setup(on, { states: { 'srv-1': 'build_in_progress', 'srv-2': 'live' } })
    const ui = await openPane($, clock, 'render')
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

  test("render: a fast poll that fails keeps the service's last rows and shows the error", async ($, on) => {
    let fail = false
    const { clock } = setup(on, {
      states: { 'srv-1': 'build_in_progress', 'srv-2': 'live' },
      deploys: id => (fail && id === 'srv-1' ? { status: 502, body: {} } : undefined),
    })
    const ui = await openPane($, clock, 'render')
    fail = true
    await clock.advance(10_000)
    expect(await ui.find({ text: 'Render HTTP 502' })).toBeDefined()
    expect(textOf(await ui.find({ type: 'Box' }))).toMatch(/building api +prod main/)
  })

  test('deploy_refresh_seconds and deploy_building_refresh_seconds set the intervals', { options: { deploy_refresh_seconds: 30, deploy_building_refresh_seconds: 5 } }, async ($, on) => {
    let state = 'BUILDING'
    const { clock, urls } = setup(on, { vercel: () => ({ status: 200, body: vercelBody(state) }) })
    await openPane($, clock, 'vercel')
    await clock.advance(5_000)
    expect(urls.length).toBe(2)
    state = 'READY'
    await clock.advance(5_000)
    expect(urls.length).toBe(3)
    await clock.advance(29_000)
    expect(urls.length).toBe(3)
    await clock.advance(1_000)
    expect(urls.length).toBe(4)
  })
})

describe('requests', () => {
  test("render lists services then each one's deploys, filtered by render_services, with the key as bearer", { options: { render_services: 'api' } }, async ($, on) => {
    const { clock, urls, auths } = setup(on)
    await openPane($, clock, 'render')
    expect(urls).toEqual([SERVICES_URL, deploysOf('srv-1')])
    expect(new Set(auths)).toEqual(new Set(['Bearer rtok-secret']))
  })

  test('a render_services filter that matches nothing says so', { options: { render_services: 'nope' } }, async ($, on) => {
    const { clock } = setup(on)
    const ui = await openPane($, clock, 'render')
    expect(await ui.find({ text: 'no service named nope' })).toBeDefined()
  })

  test('render_max_services caps the fan-out and says how many were left out', { options: { render_max_services: 1 } }, async ($, on) => {
    const { clock, urls } = setup(on)
    const ui = await openPane($, clock, 'render')
    expect(urls).toEqual([SERVICES_URL, deploysOf('srv-1')])
    expect(await ui.find({ text: /^1 more services not shown/ })).toBeDefined()
  })

  test("a worktree's branch is read through its gitdir", async ($, on) => {
    const { clock } = setup(on, {
      files: {
        '/work/.git': 'gitdir: /repo/.git/worktrees/wt\n',
        '/repo/.git/worktrees/wt/HEAD': 'ref: refs/heads/main\n',
      },
    })
    const ui = await openPane($, clock, 'render')
    expect(await ui.find({ text: /· on main/ })).toBeDefined()
  })

  test('vercel: v7 list, bearer token, linked project and team from .vercel/project.json', async ($, on) => {
    const { clock, urls, auths } = setup(on, {
      files: {
        '/work/.git/HEAD': 'ref: refs/heads/main\n',
        '/work/.vercel/project.json': JSON.stringify({ projectId: 'prj_1', orgId: 'team_9' }),
      },
    })
    const ui = await openPane($, clock, 'vercel')
    expect(urls[0]).toBe('https://api.vercel.com/v7/deployments?limit=15&projectId=prj_1&teamId=team_9')
    expect(auths[0]).toBe('Bearer vtok-secret')
    expect(await ui.find({ text: 'project from .vercel/project.json' })).toBeDefined()
  })

  test('the vercel link is found from a subdirectory; a personal link sends no team', async ($, on) => {
    const { clock, urls } = setup(on, {
      files: { '/.vercel/project.json': JSON.stringify({ projectId: 'prj_up', orgId: 'user_abc' }) },
    })
    await openPane($, clock, 'vercel')
    expect(urls[0]).toBe('https://api.vercel.com/v7/deployments?limit=15&projectId=prj_up')
  })

  test('vercel settings win over the link; a slug goes as slug', { options: { vercel_team: 'acme', vercel_project: 'web' } }, async ($, on) => {
    const { clock, urls } = setup(on, {
      files: { '/work/.vercel/project.json': JSON.stringify({ projectId: 'prj_1', orgId: 'team_9' }) },
    })
    await openPane($, clock, 'vercel')
    expect(urls[0]).toBe('https://api.vercel.com/v7/deployments?limit=15&projectId=web&slug=acme')
  })
})

describe('finish toast', () => {
  const building = { 'srv-1': 'live', 'srv-2': 'build_in_progress' }

  test('with notify_on_finish, a closed pane still toasts when the branch deploy is ready', { options: { notify_on_finish: true } }, async ($, on) => {
    const { clock, urls, pane, toasts, states } = setup(on, { states: { ...building } })
    await openPane($, clock, 'render')
    pane.open = false
    await clock.advance(10_000) // still building: keeps watching
    expect(toasts).toEqual([])
    states['srv-2'] = 'live'
    await clock.advance(10_000)
    expect(toasts).toEqual(['api-pr-7 (feature-x) is ready on Render'])
    const after = urls.length
    await clock.advance(600_000) // nothing left to watch: stopped
    expect(urls.length).toBe(after)
  })

  test('a failed branch deploy toasts too', { options: { notify_on_finish: true } }, async ($, on) => {
    const { clock, pane, toasts, states } = setup(on, { states: { ...building } })
    await openPane($, clock, 'render')
    pane.open = false
    states['srv-2'] = 'update_failed'
    await clock.advance(10_000)
    expect(toasts).toEqual(['api-pr-7 (feature-x) failed on Render'])
  })

  test('a build on a tab switched away from toasts when it finishes', { options: { notify_on_finish: true } }, async ($, on) => {
    let state = 'BUILDING'
    const { clock, toasts } = setup(on, { vercel: () => ({ status: 200, body: vercelBody(state) }) })
    const ui = await openPane($, clock, 'vercel')
    await ui.press({ key: 'tab:docker' })
    await clock.settle()
    state = 'READY'
    await clock.advance(10_000)
    expect(toasts).toEqual(['web (feature-x) is ready on Vercel'])
  })

  test('off by default: closing the pane stops polling, no toast', async ($, on) => {
    const { clock, urls, pane, toasts, states } = setup(on, { states: { ...building } })
    await openPane($, clock, 'render')
    pane.open = false
    states['srv-2'] = 'live'
    await clock.advance(60_000)
    expect(urls.length).toBe(3)
    expect(toasts).toEqual([])
  })

  test('no toast while the tab is on screen', { options: { notify_on_finish: true } }, async ($, on) => {
    const { clock, toasts, states } = setup(on, { states: { ...building } })
    await openPane($, clock, 'render')
    states['srv-2'] = 'live'
    await clock.advance(10_000)
    expect(toasts).toEqual([])
  })
})

describe('pure helpers', () => {
  test('state normalization', () => {
    expect(['created', 'live', 'deactivated', 'build_failed', 'canceled', 'who_knows', undefined].map(renderState))
      .toEqual(['building', 'ready', 'ready', 'error', 'canceled', 'error', 'error'])
    expect(['QUEUED', 'READY', 'BLOCKED', 'DELETED', undefined].map(vercelState))
      .toEqual(['building', 'ready', 'error', 'canceled', 'error'])
  })

  test('parsing tolerates missing fields', () => {
    const service = { id: 's', name: 'svc', preview: false }
    expect(parseDeploys(service, [{}, { deploy: { id: 'd' } }])).toEqual([
      { id: 'd', name: 'svc', group: 's', env: 'prod', state: 'error', branch: undefined, sha: undefined, message: undefined, who: undefined, createdAt: 0, url: undefined },
    ])
    const [d] = parseDeployments({ deployments: [{ uid: 'u', name: 'n', created: 1 }] })
    expect(d).toMatchObject({ id: 'u', name: 'n', env: 'preview', state: 'error', branch: undefined, url: undefined })
    expect(parsePs(jsonl([{ ID: 'x', Image: 'i', Status: 'Created', Names: 'n' }]))[0]).toMatchObject({ state: 'idle', tags: [{ text: 'i' }, { text: 'Created', dimColor: true }] })
    expect(groupCliRows(CLI_ROWS)[0]?.containers).toEqual([{ container_id: 'ta-9', started_at: 0 }])
  })

  test('service cap and building services', () => {
    expect(pickServices(SERVICES, [], 1)).toMatchObject({ services: [{ id: 'srv-1', preview: false }], skipped: 1 })
    expect(pickServices(SERVICES, ['api-pr-7'], 5).services).toMatchObject([{ id: 'srv-2', preview: true }])
    const deploys = parseDeploys({ id: 's', name: 'svc', preview: false }, [{ deploy: { id: 'a', status: 'queued' } }, { deploy: { id: 'b', status: 'queued' } }])
    expect(buildingServiceIds(deploys)).toEqual(['s'])
  })

  test('urls, providers, branch, age, row fitting', () => {
    expect(deploymentsUrl({ team: 'team_x', project: 'p' }, 5)).toBe('https://api.vercel.com/v7/deployments?limit=5&projectId=p&teamId=team_x')
    expect(buildProviders({}).map(p => p.id)).toEqual(['docker', 'modal', 'render', 'vercel'])
    expect(buildProviders({ providers: 'Render, render,vercel' }).map(p => p.id)).toEqual(['render', 'vercel'])
    expect(branchFromHead('ref: refs/heads/feat/x\n')).toBe('feat/x')
    expect(branchFromHead('0123abc\n')).toBeUndefined()
    expect([0, 59 * MIN, 60 * MIN, 47 * 60 * MIN, 48 * 60 * MIN].map(age)).toEqual(['0m', '59m', '1h', '47h', '2d'])
    const rows = [{ id: 'a', title: 'a', sub: 's' }, { id: 'b', title: 'b' }, { id: 'c', title: 'c', sub: 's' }]
    expect(fitRows(rows, 3).map(r => r.id)).toEqual(['a', 'b'])
    expect(fitRows(rows, 0).map(r => r.id)).toEqual(['a'])
  })
})
