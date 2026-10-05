import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildProviders } from '../hooks/providers'
import { parsePs } from '../hooks/providers/docker'
import { mergeLogs, parseInfo, parseInspect, parseSize, parseStats } from '../hooks/providers/docker-detail'
import { groupCliRows, shortId } from '../hooks/providers/modal'
import { cliError, hasNoNvidiaSmi, parseCpuMem, parseLimits, parseNvidiaSmi } from '../hooks/providers/modal-detail'
import { gib, meter, metricLines } from '../hooks/providers/detail-view'
import { buildingServiceIds, normalizeState as renderState, parseDeploys, pickServices } from '../hooks/providers/render'
import { deploymentsUrl, normalizeState as vercelState, parseDeployments, productionDomain, projectUrl } from '../hooks/providers/vercel'
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
const STATS = {
  BlockIO: '1.93MB / 0B', CPUPerc: '120.50%', Container: 'aaa111', ID: 'aaa111', MemPerc: '30.00%',
  MemUsage: '2.3GiB / 7.7GiB', Name: 'webapp-web-1', NetIO: '1.63kB / 512B', PIDs: '2',
}
const hostConfig = (h: object) => JSON.stringify([{ HostConfig: { NanoCpus: 0, CpuQuota: 0, CpuPeriod: 0, Memory: 0, DeviceRequests: null, ...h } }])
const INSPECT_OPEN = hostConfig({})
const INSPECT_LIMITED = hostConfig({ NanoCpus: 1_500_000_000, Memory: 536_870_912 })
const INSPECT_GPU = hostConfig({ DeviceRequests: [{ Driver: '', Count: -1, Capabilities: [['gpu']] }] })
const INFO = { NCPU: 8, MemTotal: 8_217_014_272 }
// Answers docker inspect, info, stats and exec for the metrics pane.
const dockerAnswers = (inspect: string, stats: object = STATS) => (args: string[]): Run => {
  if (args[0] === 'inspect') return { exitCode: 0, stdout: inspect }
  if (args[0] === 'info') return { exitCode: 0, stdout: INFO }
  if (args[0] === 'stats') return { exitCode: 0, stdout: JSON.stringify(stats) + '\n' }
  if (args[0] === 'exec') return { exitCode: 0, stdout: NVIDIA_SMI }
  return { exitCode: 1, stderr: 'not stubbed' }
}

// ---- modal ----

const TA1 = 'ta-01AAAAAAAAAAAAAAAAAAAAA111'
const TA2 = 'ta-01AAAAAAAAAAAAAAAAAAAAA222'
const TA3 = 'ta-01AAAAAAAAAAAAAAAAAAAAA333'
const HELPER = {
  me: 'alice',
  env: 'main',
  apps: [
    {
      app_id: 'ap-1', app_name: 'train-llm', created_by: 'alice',
      // started_at is epoch seconds; the later one is listed first here, the earlier one first on screen
      containers: [
        { container_id: TA1, started_at: (NOW - 12 * MIN) / 1000 },
        { container_id: TA2, started_at: (NOW - 30 * MIN) / 1000 },
      ],
    },
    { app_id: 'ap-2', app_name: 'batch-embed', created_by: 'bob', containers: [{ container_id: TA3, started_at: 0 }] },
  ],
}
const CLI_ROWS = [{ container_id: 'ta-9', app_id: 'ap-9', app_name: 'cli-only-app', start_time: 'Pending' }]
const BILLING = [
  { object_id: 'ap-1', cost: '1.25' },
  { object_id: 'ap-1', cost: '0.50' },
  { object_id: 'ap-2', cost: '3.00' },
]
// `logs` and `exec` answer per call when given functions; `exec` gets the remote command.
type ModalAnswers = {
  helper: Run
  list?: Run
  billing: Run
  logs?: Run | (() => Promise<Run> | Run)
  exec?: (cmd: string[]) => Run
}
const MODAL_OK: ModalAnswers = { helper: { exitCode: 0, stdout: HELPER }, billing: { exitCode: 0, stdout: BILLING } }
const LOGS_PANE = 'observe-logs'
const METRICS_PANE = 'observe-metrics'

// Captured from real containers through `modal container exec --no-pty` (process list trimmed).
const NVIDIA_SMI = `Mon Oct  5 14:35:44 2026
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 580.95.05              Driver Version: 580.95.05      CUDA Version: 13.0     |
+-----------------------------------------+------------------------+----------------------+
| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |
| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |
|                                         |                        |               MIG M. |
|=========================================+========================+======================|
|   0  NVIDIA RTX PRO 6000 Blac...    On  |   00000000:0B:00.0 Off |                    0 |
| N/A   80C    P0            599W /  600W |    2210MiB /  97887MiB |    100%      Default |
|                                         |                        |             Disabled |
+-----------------------------------------+------------------------+----------------------+

+-----------------------------------------------------------------------------------------+
| Processes:                                                                              |
|  GPU   GI   CI              PID   Type   Process name                        GPU Memory |
|        ID   ID                                                               Usage      |
|=========================================================================================|
|    0   N/A  N/A               1    M+C   /bin/dumb-init                         2194MiB |
+-----------------------------------------------------------------------------------------+
`
const NO_NVIDIA_SMI =
  'executing processes for container: executing command "nvidia-smi" in sandbox: error finding executable "nvidia-smi" in PATH [/usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin]: no such file or directory\n'
const CGROUP_V2_MISSING =
  'cat: /sys/fs/cgroup/cpu.stat: No such file or directory\ncat: /sys/fs/cgroup/memory.current: No such file or directory\ncat: /sys/fs/cgroup/memory.max: No such file or directory\n'
const CGROUP_V1 = '25380000000\n324083712\n729889800192\n'
const LIMITS_V1 = '18000000\n1000000\nMemTotal:       1073741824 kB\nMemFree:        1069080364 kB\n'
const PROC = '0.00 0.00 0.00 0/0 0\nMemTotal:       1073741824 kB\nMemFree:        1068817124 kB\nMemAvailable:   1068817124 kB\nBuffers:               0 kB\n'
// cgroup v2 in its documented format (Modal's sandboxes expose v1, so this one is written by hand).
const CGROUP_V2 = 'usage_usec 5000000\nuser_usec 4000000\nsystem_usec 1000000\n2147483648\nmax\n'
const NO_CONTAINER =
  `╭─ Error ──────────────────────────────────────────────────────────────────────╮\n│ No Container with ID '${TA1}' found                   │\n╰──────────────────────────────────────────────────────────────────────────────╯\n`

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
      uid: 'dpl_2', name: 'web', projectId: 'prj_web', url: 'web-prod.vercel.app', created: NOW - 120 * MIN, readyState: 'READY',
      target: 'production', creator: { username: 'bob' },
      meta: { githubCommitRef: 'main', githubCommitSha: '1234567aaaa', githubCommitMessage: 'Release' },
    },
    {
      uid: 'dpl_1', name: 'web', projectId: 'prj_web', url: 'web-abc.vercel.app', created: NOW - 5 * MIN, readyState: state,
      target: null, creator: { username: 'alice' },
      meta: { githubCommitRef: 'feature-x', githubCommitSha: 'abcdef1234567', githubCommitMessage: 'Add login\n\nlong body' },
    },
  ],
})

// Two apps: docs (no production domain) deployed between web's two deploys.
const twoApps = () => {
  const body = vercelBody('READY')
  const docs = (uid: string, ago: number) => ({
    uid, name: 'docs', projectId: 'prj_docs', url: `${uid}.vercel.app`, created: NOW - ago * MIN, readyState: 'READY',
    target: 'production', creator: { username: 'carol' }, meta: { githubCommitRef: 'main' },
  })
  return { deployments: [...body.deployments, docs('dpl_d1', 60), docs('dpl_d2', 90)] }
}

const PROJECTS: Record<string, object> = {
  prj_web: { id: 'prj_web', name: 'web', targets: { production: { alias: ['web-acme.vercel.app', 'web.vercel.app'] } } },
  prj_docs: { id: 'prj_docs', name: 'docs', targets: {} },
}
const projectOf = (id: string, team = '') => `https://api.vercel.com/v9/projects/${id}${team ? `?${team}` : ''}`

// ---- the harness ----

type Reply = { status: number; body: unknown } | 'unreachable'
type Setup = {
  env?: Record<string, string>
  files?: Record<string, string>
  docker?: Run | Error
  dockerDetail?: (args: string[]) => Run // docker logs, stats, inspect, info, exec (args after --context)
  modal?: ModalAnswers
  states?: States
  services?: () => Reply
  deploys?: (id: string) => Reply | undefined
  vercel?: () => Reply
  projects?: (idOrName: string) => Reply
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
  const details = new Map<string, string>() // the Modal logs and metrics panes open: id to title
  on('ui.open', ($, e) => {
    if (s.placed === false) return { value: { isPlaced: false as const, reason: 'this desktop places no panes' } }
    if (e.id === PANE) pane.open = true
    else details.set(e.id, e.title ?? '')
    return { value: { isPlaced: true as const } }
  })
  const listed = (id: string, title: string) => ({ id, title, isShown: true, isFocused: false, isPlaced: true })
  on('ui.panes', () => ({
    value: [...(pane.open ? [listed(PANE, 'Observe')] : []), ...[...details].map(([id, title]) => listed(id, title))],
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
    if (e.argv[0] === 'docker') {
      const args = e.argv[1] === '--context' ? e.argv.slice(3) : e.argv.slice(1)
      answer = args[0] === 'ps' ? (s.docker ?? DOCKER_OK) : (s.dockerDetail?.(args) ?? { exitCode: 1, stderr: 'not stubbed' })
    }
    else if (e.argv[0] === 'sh') answer = modal.helper
    else if (e.argv[2] === 'list') answer = modal.list ?? { exitCode: 1, stderr: 'no list' }
    else if (e.argv[2] === 'logs') {
      const a = modal.logs ?? { exitCode: 0 }
      answer = typeof a === 'function' ? await a() : a
    } else if (e.argv[2] === 'exec') answer = modal.exec?.(e.argv.slice(5)) ?? { exitCode: 0 }
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
    const project = /\/v9\/projects\/([^/?]+)/.exec(e.url)?.[1]
    const reply: Reply = project
      ? (s.projects?.(project) ?? (PROJECTS[project] ? { status: 200, body: PROJECTS[project] } : { status: 404, body: {} }))
      : e.url.includes('vercel.com')
      ? (s.vercel?.() ?? { status: 200, body: vercelBody() })
      : m
        ? (s.deploys?.(m[1]!) ?? { status: 200, body: deploysFor(m[1]!, states) })
        : (s.services?.() ?? { status: 200, body: SERVICES })
    if (reply === 'unreachable') return { deny: 'getaddrinfo ENOTFOUND' }
    return { value: { status: reply.status, ok: reply.status < 300, headers: {}, text: JSON.stringify(reply.body) } }
  })
  return { clock, pane, details, toasts, copied, argvs, urls, auths, states }
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

// A Modal logs or metrics pane, once a row's button opened it.
const mountDetail = ($: Engine, requestId: string, surface: Surface, bodyColumns = PANE_PROPS.bodyColumns) =>
  $.ui.mount({
    plugin: 'observe', surface, component: 'Pane', requestId,
    viewport: { columns: 120, rows: 40 }, props: { ...PANE_PROPS, bodyColumns } as never,
  })

type Found = { text?: string; props: Record<string, unknown>; children?: unknown[] }
// A found Text and the Text nodes inside it, depth first.
function textNodes(n: Found | undefined): Found[] {
  if (!n) return []
  const kids = (n.children ?? []).filter((c): c is Found => typeof c === 'object' && c !== null && 'props' in c)
  const own = { ...n, text: n.text ?? (n.children ?? []).filter(c => typeof c === 'string').join('') }
  return [own, ...kids.flatMap(textNodes)]
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
      expect((await ui.find({ key: 'logs:aaa111' }))?.text).toBe('logs')
      expect((await ui.find({ key: 'metrics:bbb222' }))?.text).toBe('metrics')
    })

    test("logs opens the shared pane on the container's stdout and stderr, in time order", async ($, on) => {
      const { clock, argvs, details } = setup(on, {
        dockerDetail: args => args[0] === 'logs'
          ? { exitCode: 0, stdout: '2026-10-05T18:43:10.90981571Z tick 4\n2026-10-05T18:43:11.911879252Z tick 5\n', stderr: '2026-10-05T18:43:10.909830418Z warn 4\n' }
          : { exitCode: 1, stderr: 'not stubbed' },
      })
      const ui = await openPane($, clock, 'docker', surface)
      await ui.press({ key: 'logs:aaa111' })
      await clock.settle()
      expect(details.get(LOGS_PANE)).toBe('Docker logs · webapp-web-1')
      expect(argvs.filter(a => a[1] === 'logs')).toEqual([['docker', 'logs', '--tail', '100', '--timestamps', 'aaa111']])
      const logs = await mountDetail($, LOGS_PANE, surface)
      const texts = (await logs.findAll({ type: 'Text' })).map(t => t.text)
      expect(texts.slice(0, 3)).toEqual(['tick 4', 'warn 4', 'tick 5'])
      await clock.advance(5_000)
      expect(argvs.filter(a => a[1] === 'logs')).toHaveLength(2)
    })

    test('metrics without limits: CPU and RAM against the host, labeled; I/O as text; no GPU section', async ($, on) => {
      const { clock, argvs, details } = setup(on, { dockerDetail: dockerAnswers(INSPECT_OPEN) })
      const ui = await openPane($, clock, 'docker', surface)
      await ui.press({ key: 'metrics:aaa111' })
      await clock.settle()
      expect(details.get(METRICS_PANE)).toBe('Docker metrics · webapp-web-1')
      const m = await mountDetail($, METRICS_PANE, surface)
      const texts = (await m.findAll({ type: 'Text' })).map(t => t.text)
      expect(texts).toEqual(expect.arrayContaining([
        `CPU   ${'█'.repeat(3)}${'░'.repeat(17)}  15%  1.2 / 8 cores host`,
        `RAM   ${'█'.repeat(6)}${'░'.repeat(14)}  30%  2.3 / 7.7 GiB host`,
        'NET   1.63kB in / 512B out',
        'BLOCK 1.93MB read / 0B written',
      ]))
      expect(texts.some(t => /GPU/.test(t ?? ''))).toBe(false)
      expect(argvs.some(a => a[1] === 'exec')).toBe(false)
      // inspect and info once; stats every refresh
      await clock.advance(5_000)
      expect(argvs.filter(a => a[1] === 'inspect')).toHaveLength(1)
      expect(argvs.filter(a => a[1] === 'info')).toHaveLength(1)
      expect(argvs.filter(a => a[1] === 'stats')).toEqual(Array(2).fill(['docker', 'stats', '--no-stream', '--format', '{{json .}}', 'aaa111']))
    })

    test("metrics against the container's own CPU and memory limits", async ($, on) => {
      const { clock } = setup(on, {
        dockerDetail: dockerAnswers(INSPECT_LIMITED, { ...STATS, MemUsage: '128MiB / 512MiB' }),
      })
      const ui = await openPane($, clock, 'docker', surface)
      await ui.press({ key: 'metrics:aaa111' })
      await clock.settle()
      const texts = (await (await mountDetail($, METRICS_PANE, surface)).findAll({ type: 'Text' })).map(t => t.text)
      expect(texts).toEqual(expect.arrayContaining([
        `CPU   ${'█'.repeat(16)}${'░'.repeat(4)}  80%  1.2 / 1.5 cores`,
        `RAM   ${'█'.repeat(5)}${'░'.repeat(15)}  25%  128 / 512 MiB`,
      ]))
    })

    test('a container with GPUs assigned gets GPU meters from a bare nvidia-smi', async ($, on) => {
      const { clock, argvs } = setup(on, { dockerDetail: dockerAnswers(INSPECT_GPU) })
      const ui = await openPane($, clock, 'docker', surface)
      await ui.press({ key: 'metrics:aaa111' })
      await clock.settle()
      expect(argvs.filter(a => a[1] === 'exec')).toEqual([['docker', 'exec', 'aaa111', 'nvidia-smi']])
      const texts = (await (await mountDetail($, METRICS_PANE, surface)).findAll({ type: 'Text' })).map(t => t.text)
      expect(texts).toEqual(expect.arrayContaining([
        'GPU0 NVIDIA RTX PRO 6000 Blac... · 599/600 W · 80°C',
        `GPU0 util ${'█'.repeat(20)} 100%`,
      ]))
    })

    test('a docker error shows in red in the metrics pane', async ($, on) => {
      const { clock } = setup(on, { dockerDetail: () => ({ exitCode: 1, stderr: 'Error: No such object: aaa111' }) })
      const ui = await openPane($, clock, 'docker', surface)
      await ui.press({ key: 'metrics:aaa111' })
      await clock.settle()
      const m = await mountDetail($, METRICS_PANE, surface)
      expect((await m.find({ type: 'Text', text: 'Error: No such object: aaa111' }))?.props.color).toBe('red')
    })

    test('docker_context reaches the logs and metrics commands', { options: { docker_context: 'remote' } }, async ($, on) => {
      const { clock, argvs } = setup(on, { dockerDetail: dockerAnswers(INSPECT_OPEN) })
      const ui = await openPane($, clock, 'docker', surface)
      await ui.press({ key: 'metrics:aaa111' })
      await ui.press({ key: 'logs:aaa111' })
      await clock.settle()
      const detail = argvs.filter(a => a[3] !== 'ps')
      expect(detail.length).toBeGreaterThan(3)
      for (const a of detail) expect(a.slice(0, 3)).toEqual(['docker', '--context', 'remote'])
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
    test("one row per container, by app then start time, each with its app's cost and logs and metrics buttons", async ($, on) => {
      const { clock } = setup(on, { env: {} })
      const ui = await openPane($, clock, 'modal', surface)
      const all = textOf(await ui.find({ type: 'Box' }))
      expect(all).toMatch(/3 running containers · main/)
      const rows = all.split('\n').filter(l => l.startsWith('●'))
      expect(rows).toEqual([
        '● batch-embed …AAA333 bob $3.00 pending',
        '● train-llm   …AAA222 alice $1.75 30m',
        '● train-llm   …AAA111 alice $1.75 12m',
      ])
      expect(all).not.toContain('×')
      expect(all).toMatch(/every 20s · cost: per app, billed full hours, last 7d/)
      for (const id of [TA1, TA2, TA3]) {
        expect((await ui.find({ key: `logs:${id}` }))?.text).toBe('logs')
        expect((await ui.find({ key: `metrics:${id}` }))?.text).toBe('metrics')
      }
    })

    test('a narrow pane shortens app names so the id, creator, cost and age stay in view', async ($, on) => {
      const { clock } = setup(on, { env: {} })
      await $.command.run({ command: 'observe', args: 'modal' } as never)
      await clock.settle()
      const ui = await $.ui.mount({
        plugin: 'observe', surface, component: 'Pane', requestId: PANE,
        viewport: { columns: 120, rows: 40 }, props: { ...PANE_PROPS, bodyColumns: 55 } as never,
      })
      const rows = textOf(await ui.find({ type: 'Box' })).split('\n').filter(l => l.startsWith('●'))
      expect(rows).toEqual([
        '● batch-e… …AAA333 bob $3.00 pending',
        '● train-l… …AAA222 alice $1.75 30m',
        '● train-l… …AAA111 alice $1.75 12m',
      ])
    })

    test("logs opens one shared pane with the container's newest lines", async ($, on) => {
      const lines = Array.from({ length: 100 }, (_, i) => `step ${i + 1}`)
      const { clock, argvs, details } = setup(on, {
        env: {},
        modal: { ...MODAL_OK, logs: { exitCode: 0, stdout: lines.join('\n') + '\n' } },
      })
      const ui = await openPane($, clock, 'modal', surface)
      await ui.press({ key: `logs:${TA1}` })
      await clock.settle()
      expect(details.get(LOGS_PANE)).toBe('Modal logs · train-llm …AAA111')
      expect(argvs.filter(a => a[2] === 'logs')).toEqual([['modal', 'container', 'logs', TA1]])
      const logs = await mountDetail($, LOGS_PANE, surface)
      expect(await logs.find({ type: 'Text', text: 'step 100' })).toBeDefined()
      expect(await logs.find({ type: 'Text', text: /^step 1$/ })).toBeUndefined() // only what fits
      expect(await logs.find({ type: 'Text', text: /every 5s · last 100 entries/ })).toBeDefined()

      await ui.press({ key: `logs:${TA3}` })
      await clock.settle()
      expect(details.get(LOGS_PANE)).toBe('Modal logs · batch-embed …AAA333')
      expect(details.size).toBe(1)
      expect(argvs.filter(a => a[2] === 'logs').at(-1)).toEqual(['modal', 'container', 'logs', TA3])
    })

    test('logs refresh every 5s, never overlap, and stop once the pane is closed', async ($, on) => {
      let calls = 0
      let finish = () => {}
      let slow = false
      const { clock, details } = setup(on, {
        env: {},
        modal: {
          ...MODAL_OK,
          logs: async () => {
            calls++
            if (slow) await new Promise<void>(resolve => (finish = resolve))
            return { exitCode: 0, stdout: 'hello\n' }
          },
        },
      })
      const ui = await openPane($, clock, 'modal', surface)
      await ui.press({ key: `logs:${TA1}` })
      await clock.settle()
      expect(calls).toBe(1)
      await clock.advance(5_000)
      expect(calls).toBe(2)
      slow = true
      await clock.advance(5_000)
      await clock.advance(5_000)
      await clock.advance(5_000)
      expect(calls).toBe(3) // the slow call holds the next ticks back
      finish()
      await clock.settle()
      await clock.advance(5_000)
      expect(calls).toBe(4)
      finish()
      // A test cannot fire `ui.close`, so this covers the per-tick pane check behind it.
      details.delete(LOGS_PANE)
      await clock.advance(5_000)
      await clock.advance(60_000)
      expect(calls).toBe(4)
    })

    test('a logs error is shown in red in the pane', async ($, on) => {
      const { clock } = setup(on, { env: {}, modal: { ...MODAL_OK, logs: { exitCode: 1, stderr: NO_CONTAINER } } })
      const ui = await openPane($, clock, 'modal', surface)
      await ui.press({ key: `logs:${TA1}` })
      await clock.settle()
      const logs = await mountDetail($, LOGS_PANE, surface)
      expect((await logs.find({ type: 'Text', text: `No Container with ID '${TA1}' found` }))?.props.color).toBe('red')
    })

    test('detail_refresh_seconds sets the logs and metrics interval', { options: { detail_refresh_seconds: 30 } }, async ($, on) => {
      const { clock, argvs } = setup(on, { env: {}, modal: { ...MODAL_OK, logs: { exitCode: 0, stdout: 'x\n' } } })
      const ui = await openPane($, clock, 'modal', surface)
      await ui.press({ key: `logs:${TA1}` })
      await clock.settle()
      expect(await (await mountDetail($, LOGS_PANE, surface)).find({ type: 'Text', text: /every 30s/ })).toBeDefined()
      await clock.advance(29_000)
      expect(argvs.filter(a => a[2] === 'logs')).toHaveLength(1)
      await clock.advance(1_000)
      expect(argvs.filter(a => a[2] === 'logs')).toHaveLength(2)
    })

    test("metrics shows GPUs, CPU cores and RAM from exec'd nvidia-smi and cat", async ($, on) => {
      let usage = 38_851_890_000_000
      const { clock, argvs, details } = setup(on, {
        env: {},
        modal: {
          ...MODAL_OK,
          exec: cmd => {
            if (cmd[0] === 'nvidia-smi') return { exitCode: 0, stdout: NVIDIA_SMI }
            if (cmd[1] === '/sys/fs/cgroup/cpu.stat') return { exitCode: 0, stdout: CGROUP_V2_MISSING }
            if (cmd[1] === '/sys/fs/cgroup/cpuacct/cpuacct.usage') {
              return { exitCode: 0, stdout: `${(usage += 6e9)}\n5041463296\n1099511627776\n` }
            }
            if (cmd[1] === '/sys/fs/cgroup/cpu/cpu.cfs_quota_us') return { exitCode: 0, stdout: LIMITS_V1 }
            return { exitCode: 0, stdout: '' }
          },
        },
      })
      const ui = await openPane($, clock, 'modal', surface)
      await ui.press({ key: `metrics:${TA1}` })
      await clock.settle()
      expect(details.get(METRICS_PANE)).toBe('Modal metrics · train-llm …AAA111')
      const execs = argvs.filter(a => a[2] === 'exec')
      for (const a of execs) expect(a.slice(0, 5)).toEqual(['modal', 'container', 'exec', '--no-pty', TA1])
      expect(execs.map(a => a[5])).toEqual(['nvidia-smi', 'cat', 'cat', 'cat'])
      expect(execs.every(a => a.slice(5).every(arg => !arg.startsWith('-')))).toBe(true)

      const m = await mountDetail($, METRICS_PANE, surface)
      const texts = async () => (await m.findAll({ type: 'Text' })).map(t => t.text)
      expect(await texts()).toEqual(expect.arrayContaining([
        'GPU0 NVIDIA RTX PRO 6000 Blac... · 599/600 W · 80°C',
        `GPU0 util ${'█'.repeat(20)} 100%`,
        `GPU0 mem  ${'░'.repeat(20)}   2%  2.2 / 95.6 GiB`,
        'CPU       measuring…',
        // Modal's cgroup limit is the host's size (it equals MemTotal), so it is labeled as such
        `RAM       ${'░'.repeat(20)}   0%  4.7 / 1024 GiB host`,
      ]))
      // one accent for every filled part, the track dim
      const util = await m.find({ type: 'Text', text: /^GPU0 util/ })
      expect(textNodes(util).map(n => [n.text, n.props.color, n.props.dimColor])).toEqual(expect.arrayContaining([
        ['█'.repeat(20), 'cyan', undefined],
      ]))
      const ram = await m.find({ type: 'Text', text: /^RAM/ })
      expect(textNodes(ram).map(n => [n.text, n.props.dimColor])).toEqual(expect.arrayContaining([['░'.repeat(20), true]]))

      await clock.advance(5_000)
      expect(await texts()).toContain(`CPU       █${'░'.repeat(19)}   7%  1.2 / 18 cores`)
      // The layout and the limits that answered are remembered: no second try at cgroup v2.
      expect(argvs.filter(a => a[6] === '/sys/fs/cgroup/cpu.stat')).toHaveLength(1)
      expect(argvs.filter(a => a[6] === '/sys/fs/cgroup/cpu/cpu.cfs_quota_us')).toHaveLength(1)
    })

    test('a narrow metrics pane narrows the bars, down to 8 cells', async ($, on) => {
      const { clock } = setup(on, {
        env: {},
        modal: { ...MODAL_OK, exec: cmd => ({ exitCode: 0, stdout: cmd[0] === 'nvidia-smi' ? NVIDIA_SMI : CGROUP_V1 }) },
      })
      const ui = await openPane($, clock, 'modal', surface)
      await ui.press({ key: `metrics:${TA1}` })
      await clock.settle()
      const m = await mountDetail($, METRICS_PANE, surface, 40)
      expect(await m.find({ type: 'Text', text: `GPU0 util ${'█'.repeat(8)} 100%` })).toBeDefined()
    })

    test('an empty exec answer keeps the last figures and tries again', async ($, on) => {
      let empty = false
      const { clock, argvs } = setup(on, {
        env: {},
        modal: {
          ...MODAL_OK,
          exec: cmd => {
            if (empty) return { exitCode: 0, stdout: '' }
            return { exitCode: 0, stdout: cmd[0] === 'nvidia-smi' ? NVIDIA_SMI : CGROUP_V2 }
          },
        },
      })
      const ui = await openPane($, clock, 'modal', surface)
      await ui.press({ key: `metrics:${TA1}` })
      await clock.settle()
      empty = true
      await clock.advance(5_000)
      const m = await mountDetail($, METRICS_PANE, surface)
      expect(await m.find({ type: 'Text', text: 'GPU0 NVIDIA RTX PRO 6000 Blac...' })).toBeDefined()
      expect(await m.find({ type: 'Text', text: /^CPU +measuring…$/ })).toBeDefined()
      // cgroup v2's "max" and no MemTotal: no denominator, so the figure alone
      expect(await m.find({ type: 'Text', text: /^RAM +2\.0 GiB$/ })).toBeDefined()
      expect(await m.find({ type: 'Text', text: /no answer/ })).toBeUndefined()
      const before = argvs.filter(a => a[2] === 'exec').length
      await clock.advance(5_000)
      expect(argvs.filter(a => a[2] === 'exec').length).toBe(before + 2)
    })

    test('a container without a GPU says so, dimmed', async ($, on) => {
      const { clock } = setup(on, {
        env: {},
        modal: {
          ...MODAL_OK,
          exec: cmd => {
            if (cmd[0] === 'nvidia-smi') return { exitCode: 0, stdout: NO_NVIDIA_SMI }
            if (cmd[1] === '/proc/loadavg') return { exitCode: 0, stdout: PROC }
            return { exitCode: 0, stdout: 'cat: no such file\n' }
          },
        },
      })
      const ui = await openPane($, clock, 'modal', surface)
      await ui.press({ key: `metrics:${TA3}` })
      await clock.settle()
      const m = await mountDetail($, METRICS_PANE, surface)
      expect((await m.find({ type: 'Text', text: 'no GPU' }))?.props.dimColor).toBe(true)
      expect(await m.find({ type: 'Text', text: 'CPU load 0.00' })).toBeDefined()
      expect(await m.find({ type: 'Text', text: `RAM ${'░'.repeat(20)}   0%  4.7 / 1024 GiB host` })).toBeDefined()
      expect((await m.findAll({ type: 'Text' })).some(t => t.props.color === 'red')).toBe(false)
    })

    test('a gone container shows the CLI error in the metrics pane', async ($, on) => {
      const { clock } = setup(on, { env: {}, modal: { ...MODAL_OK, exec: () => ({ exitCode: 1, stderr: NO_CONTAINER }) } })
      const ui = await openPane($, clock, 'modal', surface)
      await ui.press({ key: `metrics:${TA1}` })
      await clock.settle()
      const m = await mountDetail($, METRICS_PANE, surface)
      expect((await m.find({ type: 'Text', text: /No Container with ID/ }))?.props.color).toBe('red')
    })

    test('metrics exec runs only while its pane is open', async ($, on) => {
      const { clock, argvs, details } = setup(on, {
        env: {},
        modal: { ...MODAL_OK, exec: () => ({ exitCode: 0, stdout: CGROUP_V1 }) },
      })
      const ui = await openPane($, clock, 'modal', surface)
      await clock.advance(60_000)
      expect(argvs.filter(a => a[2] === 'exec')).toHaveLength(0)
      await ui.press({ key: `metrics:${TA1}` })
      await clock.settle()
      const before = argvs.filter(a => a[2] === 'exec').length
      expect(before).toBeGreaterThan(0)
      details.delete(METRICS_PANE)
      await clock.advance(5_000)
      await clock.advance(60_000)
      expect(argvs.filter(a => a[2] === 'exec')).toHaveLength(before)
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
      expect(await ui.find({ key: 'logs:ta-9' })).toBeDefined()
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
      // the headline carries the app's URL; deploy rows don't repeat their own
      expect(all).not.toContain('web-abc.vercel.app')
      expect(all).not.toContain('web-prod.vercel.app')
      expect(all).toMatch(/2 deploys in 1 app, 1 building · on feature-x/)
      expect(all.indexOf('https://web.vercel.app')).toBeLessThan(all.indexOf('Add login'))
      expect(all).not.toContain('long body')
      expect(all).not.toContain('secret')
      expect(all).toMatch(/every 10s/)
    })

    test('groups deploys under a headline per app: its production URL, else its name; apps by newest deploy', async ($, on) => {
      const { clock, copied } = setup(on, { vercel: () => ({ status: 200, body: twoApps() }) })
      const ui = await openPane($, clock, 'vercel', surface)
      const all = textOf(await ui.find({ type: 'Box' }))
      expect(all).toMatch(/4 deploys in 2 apps · on feature-x/)
      const order = ['https://web.vercel.app', 'Add login', 'Release', '\ndocs\n', 'docs prod main carol'].map(s => all.indexOf(s))
      expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true)
      expect(all.match(/docs prod main carol/g)?.length).toBe(2)
      expect(all).not.toContain('dpl_d1.vercel.app')
      expect(all).toMatch(/\n https:\/\/web\.vercel\.app \n/) // a headline: its link (and a copy button), nothing else
      // docs has no production domain: its name, bold, no link and nothing to copy
      expect((await ui.find({ type: 'Text', text: 'docs' }))?.props.bold).toBe(true)
      expect((await ui.findAll({ type: 'Link' })).map(l => l.props.href)).not.toContain('https://docs.vercel.app')
      expect(await ui.find({ key: 'copy:app:prj_docs' })).toBeUndefined()
      await ui.press({ key: 'copy:app:prj_web' })
      await clock.settle()
      expect(copied).toEqual(['https://web.vercel.app'])
      // the current branch is still marked under its headline
      expect(all).toMatch(/› ready +web +preview feature-x abcdef1 alice 5m/)
    })

    test('deploy_max_rows caps the deploys; every app with a row keeps its headline', { options: { deploy_max_rows: 3 } }, async ($, on) => {
      const { clock } = setup(on, { vercel: () => ({ status: 200, body: twoApps() }) })
      const ui = await openPane($, clock, 'vercel', surface)
      const all = textOf(await ui.find({ type: 'Box' }))
      expect(all).toMatch(/3 deploys in 2 apps/)
      expect(all).toContain('https://web.vercel.app')
      expect(all).toContain('Add login')
      expect(all).not.toContain('Release') // web's oldest deploy is past the cap
      expect(all).toMatch(/\ndocs\n/)
      expect(all.match(/docs prod main carol/g)?.length).toBe(2)
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
    expect(urls.filter(u => u.includes('/v7/deployments'))).toHaveLength(2)
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
    const { clock, urls: all } = setup(on, { vercel: () => ({ status: 200, body: vercelBody(state) }) })
    const urls = { get length() { return all.filter(u => u.includes('/v7/deployments')).length } }
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
    expect(urls[1]).toBe(projectOf('prj_web', 'slug=acme'))
  })

  test('vercel: one project lookup per app, cached an hour; Refresh looks again', async ($, on) => {
    const { clock, urls, auths } = setup(on, { vercel: () => ({ status: 200, body: twoApps() }) })
    const ui = await openPane($, clock, 'vercel')
    expect(urls).toEqual(['https://api.vercel.com/v7/deployments?limit=15', projectOf('prj_web'), projectOf('prj_docs')])
    expect(new Set(auths)).toEqual(new Set(['Bearer vtok-secret']))
    urls.length = 0
    await clock.advance(60_000) // a poll: the domains come from the cache
    expect(urls).toEqual(['https://api.vercel.com/v7/deployments?limit=15'])
    expect(textOf(await ui.find({ type: 'Box' }))).toContain('https://web.vercel.app')
    urls.length = 0
    await clock.advance(59 * 60_000) // an hour on: looked up again
    expect(urls.filter(u => u.includes('/v9/projects/')).length).toBe(2)
    urls.length = 0
    await ui.press({ key: 'refresh' })
    await clock.settle()
    expect(urls.filter(u => u.includes('/v9/projects/'))).toEqual([projectOf('prj_web'), projectOf('prj_docs')])
  })

  test('vercel: a failed project lookup falls back to the name, with no error, and is not retried each poll', async ($, on) => {
    const { clock, urls } = setup(on, { projects: () => ({ status: 403, body: {} }) })
    const ui = await openPane($, clock, 'vercel')
    const all = textOf(await ui.find({ type: 'Box' }))
    expect(all).toMatch(/\nweb\n/)
    expect(all).not.toContain('rejected')
    expect(urls.filter(u => u.includes('/v9/projects/')).length).toBe(1)
    await clock.advance(10_000) // dpl_1 is building: a fast poll
    expect(urls.filter(u => u.includes('/v9/projects/')).length).toBe(1)
  })

  test('vercel: a deployment without a projectId is grouped and looked up by its name', async ($, on) => {
    const body = vercelBody('READY')
    const { clock, urls } = setup(on, {
      vercel: () => ({ status: 200, body: { deployments: body.deployments.map(({ projectId: _, ...d }) => d) } }),
      projects: name => ({ status: 200, body: { name, targets: { production: { alias: ['www.example.com', 'web.vercel.app'] } } } }),
    })
    const ui = await openPane($, clock, 'vercel')
    expect(urls[1]).toBe(projectOf('web'))
    expect(textOf(await ui.find({ type: 'Box' }))).toMatch(/2 deploys in 1 app[\s\S]*https:\/\/www\.example\.com/)
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

  test('parses the nvidia-smi table', () => {
    expect(parseNvidiaSmi(NVIDIA_SMI)).toEqual([{
      index: 0, name: 'NVIDIA RTX PRO 6000 Blac...', util: 100, memUsedMiB: 2210, memTotalMiB: 97887,
      powerW: 599, powerCapW: 600, tempC: 80,
    }])
    expect(parseNvidiaSmi(NO_NVIDIA_SMI)).toBeUndefined()
    expect(hasNoNvidiaSmi(NO_NVIDIA_SMI)).toBe(true)
    expect(hasNoNvidiaSmi(NVIDIA_SMI)).toBe(false)
  })

  test('parses each CPU and RAM file layout and rejects missing files', () => {
    expect(parseCpuMem(0, CGROUP_V2_MISSING)).toBeUndefined()
    expect(parseCpuMem(0, CGROUP_V2)).toEqual({ usageNs: 5e9, memUsed: 2147483648, memLimit: undefined })
    expect(parseCpuMem(1, CGROUP_V1)).toEqual({ usageNs: 25380000000, memUsed: 324083712, memLimit: 729889800192 })
    expect(parseCpuMem(1, '1\n2\n9223372036854771712\n')?.memLimit).toBeUndefined()
    expect(parseCpuMem(2, PROC)).toEqual({ load: 0, memUsed: 4924700 * 1024, memLimit: 1073741824 * 1024 })
  })

  test('meter: clamps, rounds, and never draws a bar of the wrong width', () => {
    const bar = (f: number, w: number) => { const b = meter(f, w); return b.filled + b.track }
    expect(bar(0, 10)).toBe('░'.repeat(10))
    expect(bar(1, 10)).toBe('█'.repeat(10))
    expect(bar(1.7, 10)).toBe('█'.repeat(10))
    expect(bar(-0.3, 10)).toBe('░'.repeat(10))
    expect(bar(Number.NaN, 10)).toBe('░'.repeat(10))
    expect(bar(Infinity, 10)).toBe('░'.repeat(10))
    expect(meter(0.04, 10).filled).toBe('') // 0.4 of a cell rounds down
    expect(meter(0.05, 10).filled).toBe('█') // half a cell rounds up
    expect(meter(0.5, 8)).toEqual({ filled: '████', track: '░░░░' })
    expect(bar(0.5, 1)).toBe('█')
    expect(bar(0.5, 0)).toBe('')
    expect(bar(0.5, -3)).toBe('')
  })

  test('metric lines: a real RAM limit has no host label; no quota means CPU as text', () => {
    const base = { source: 'modal' as const, container_id: TA1, name: 'train-llm', memUsed: 4 * 2 ** 30, cores: 2.5 }
    const real = metricLines({ ...base, memLimit: 16 * 2 ** 30, limits: { cpus: 8, memTotal: 2 ** 40 } })
    expect(real).toEqual([
      { label: 'CPU', fraction: 2.5 / 8, text: ' 31%  2.5 / 8 cores' },
      { label: 'RAM', fraction: 0.25, text: ' 25%  4.0 / 16.0 GiB' },
    ])
    expect(metricLines({ ...base, memLimit: 2 ** 40, limits: { memTotal: 2 ** 40 } })).toEqual([
      { label: 'CPU', text: '2.50 cores' },
      { label: 'RAM', fraction: 4 / 1024, text: '  0%  4.0 / 1024 GiB host' },
    ])
    expect(gib(97887 * 2 ** 20)).toBe('95.6')
  })

  test('parses the CPU quota and the machine memory', () => {
    expect(parseLimits(1, LIMITS_V1)).toEqual({ cpus: 18, memTotal: 1073741824 * 1024 })
    expect(parseLimits(1, '-1\n100000\nMemTotal: 1024 kB\n')).toEqual({ cpus: undefined, memTotal: 1024 * 1024 })
    expect(parseLimits(0, '200000 100000\nMemTotal: 1024 kB\n').cpus).toBe(2)
    expect(parseLimits(0, 'max 100000\n').cpus).toBeUndefined()
    expect(parseLimits(0, 'cat: /sys/fs/cgroup/cpu.max: No such file or directory\nMemTotal: 1024 kB\n'))
      .toEqual({ cpus: undefined, memTotal: 1024 * 1024 })
  })

  test('docker sizes in every unit docker stats prints', () => {
    expect(['0B', '512B', '1.63kB', '1.5KB', '2.699MiB', '1.93MB', '7.7GiB', '2GB', '1TiB', ' 3MiB '].map(parseSize))
      .toEqual([0, 512, 1630, 1500, 2.699 * 2 ** 20, 1.93e6, 7.7 * 2 ** 30, 2e9, 2 ** 40, 3 * 2 ** 20])
    expect(['', '12', 'MiB', '--', undefined].map(parseSize)).toEqual([undefined, undefined, undefined, undefined, undefined])
  })

  test('docker stats, inspect and info parsing', () => {
    expect(parseStats(JSON.stringify(STATS))).toEqual({
      cores: 1.205, memUsed: 2.3 * 2 ** 30, net: '1.63kB in / 512B out', block: '1.93MB read / 0B written',
    })
    expect(parseStats('')).toBeUndefined()
    expect(parseStats(JSON.stringify({ CPUPerc: '--', MemUsage: '-- / --' }))).toEqual({ cores: undefined, memUsed: undefined, net: '—', block: '—' })
    expect(parseInspect(INSPECT_OPEN)).toEqual({ cpus: undefined, memory: undefined, hasGpu: false })
    expect(parseInspect(INSPECT_LIMITED)).toEqual({ cpus: 1.5, memory: 536_870_912, hasGpu: false })
    expect(parseInspect(hostConfig({ CpuQuota: 50_000, CpuPeriod: 100_000 })).cpus).toBe(0.5)
    expect(parseInspect(hostConfig({ CpuQuota: -1, CpuPeriod: 100_000 })).cpus).toBeUndefined()
    expect(parseInspect(INSPECT_GPU).hasGpu).toBe(true)
    expect(parseInspect(hostConfig({ DeviceRequests: [{ Capabilities: [['compute', 'utility']] }] })).hasGpu).toBe(false)
    expect(parseInfo(JSON.stringify(INFO))).toEqual({ ncpu: 8, memTotal: 8_217_014_272 })
    expect(parseInfo('{}')).toEqual({ ncpu: undefined, memTotal: undefined })
  })

  test('docker logs: stdout and stderr merged by timestamp, timestamps dropped, last 100 kept', () => {
    expect(mergeLogs('2026-10-05T18:43:11.9Z b\n2026-10-05T18:43:10Z a\n', '2026-10-05T18:43:11.10Z c\nplain\n'))
      .toEqual(['plain', 'a', 'c', 'b'])
    const many = Array.from({ length: 150 }, (_, i) => `2026-10-05T18:43:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z l${i}`)
    expect(mergeLogs(many.join('\n'), '')).toHaveLength(100)
  })

  test('reads the error out of the modal CLI box; short container ids', () => {
    expect(cliError(NO_CONTAINER, 1)).toBe(`No Container with ID '${TA1}' found`)
    expect(cliError('Token missing\n', 1)).toBe('Token missing')
    expect(cliError('', 2)).toBe('exit 2')
    expect(shortId(TA1)).toBe('…AAA111')
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
    const grouped = [{ id: 'h1', title: 'h1', heading: true }, { id: 'a', title: 'a' }, { id: 'h2', title: 'h2', heading: true }, { id: 'b', title: 'b' }]
    expect(fitRows(grouped, 3).map(r => r.id)).toEqual(['h1', 'a']) // no headline left without its rows
  })

  test('vercel production domain and project url', () => {
    expect(productionDomain({ targets: { production: { alias: ['app-team.vercel.app', 'app.vercel.app'] } } })).toBe('app.vercel.app')
    expect(productionDomain({ targets: { production: { alias: ['app.vercel.app', 'app.com'] } } })).toBe('app.com')
    expect(productionDomain({ targets: {} })).toBeUndefined()
    expect(productionDomain({ targets: { production: { alias: 'nope' } } })).toBeUndefined()
    expect(projectUrl('prj_1', 'team_x')).toBe('https://api.vercel.com/v9/projects/prj_1?teamId=team_x')
    expect(projectUrl('my app', undefined)).toBe('https://api.vercel.com/v9/projects/my%20app')
    expect(parseDeployments({ deployments: [{ uid: 'd', name: 'n', created: 0 }] })[0]?.group).toBe('n')
  })
})
