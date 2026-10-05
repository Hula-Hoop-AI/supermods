import type { On, UiPane } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

const PANE = 'my-issues'
const HOUR = 3_600_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

const ENV = {
  LINEAR_API_KEY: 'lin_api_secret',
  JIRA_BASE_URL: 'https://acme.atlassian.net/',
  JIRA_EMAIL: 'me@acme.dev',
  JIRA_API_TOKEN: 'jira-secret',
  MONDAY_API_TOKEN: 'monday-secret',
}

const GH_ROWS = [
  {
    number: 12, title: 'Fix the login redirect', url: 'https://github.com/octo/app/issues/12',
    updatedAt: ago(2 * HOUR), repository: { name: 'app', nameWithOwner: 'octo/app' },
    labels: [{ name: 'bug' }, { name: 'P1' }],
  },
]
const LINEAR_BODY = {
  data: {
    viewer: {
      assignedIssues: {
        nodes: [
          {
            identifier: 'ENG-123', title: 'Ship the importer', url: 'https://linear.app/acme/issue/ENG-123',
            updatedAt: ago(30 * 60_000), priorityLabel: 'High', state: { name: 'In Progress' },
          },
          {
            identifier: 'ENG-7', title: 'Old idea', url: 'https://linear.app/acme/issue/ENG-7',
            updatedAt: ago(30 * 24 * HOUR), priorityLabel: 'No priority', state: { name: 'Backlog' },
          },
        ],
      },
    },
  },
}
const JIRA_BODY = {
  issues: [
    {
      id: '10001', key: 'PROJ-7',
      fields: { summary: 'Rotate the keys', status: { name: 'To Do' }, priority: { name: 'Medium' }, updated: '2026-10-01T09:00:00.000+0300' },
    },
  ],
  isLast: true,
}
const MONDAY_BOARDS = {
  data: {
    boards: [
      { id: '111', name: 'Sprint board', columns: [{ id: 'person' }, { id: 'reviewer' }] },
      { id: '222', name: 'No people here', columns: [] },
    ],
  },
}
const MONDAY_ITEMS = {
  data: {
    b0: [
      {
        items_page: {
          items: [
            { id: '9001', name: 'Write launch post', url: 'https://acme.monday.com/boards/111/pulses/9001', updated_at: ago(3 * 24 * HOUR), column_values: [{ text: 'Working on it', is_done: false }] },
            { id: '9002', name: 'Already shipped', url: 'https://acme.monday.com/boards/111/pulses/9002', updated_at: ago(HOUR), column_values: [{ text: 'Done', is_done: true }] },
          ],
        },
      },
    ],
  },
}

type Reply = { status?: number; body: unknown } | 'hang'
type Http = { url: string; method?: string; headers: Record<string, string>; body?: string }
type Run = { exitCode: number; stdout?: unknown; stderr?: string } | 'missing'
type World = {
  gh?: Run
  linear?: Reply
  jira?: Reply
  mondayBoards?: Reply
  mondayItems?: Reply
}

const response = (r: { status?: number; body: unknown }) => {
  const status = r.status ?? 200
  return {
    value: {
      status, ok: status < 300, headers: {},
      text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
    },
  }
}

/** Stubs gh and every provider's HTTP API, and records what the mod asked for. */
function fakeWorld(on: On, clock: MockClock, world: World = {}) {
  const argvs: string[][] = []
  const requests: Http[] = []
  on('process.run', async ($, e) => {
    argvs.push([...e.argv])
    const run = world.gh ?? { exitCode: 0, stdout: GH_ROWS }
    if (run === 'missing') return { deny: 'spawn gh ENOENT' }
    const stdout = typeof run.stdout === 'string' ? run.stdout : JSON.stringify(run.stdout ?? [])
    return { value: { exitCode: run.exitCode, stdout, stderr: run.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', async ($, e) => {
    const req = { url: e.url, method: e.init?.method, headers: { ...e.init?.headers }, body: e.init?.body }
    requests.push(req)
    let reply: Reply
    if (e.url.startsWith('https://api.linear.app/')) reply = world.linear ?? { body: LINEAR_BODY }
    else if (e.url.startsWith('https://acme.atlassian.net/')) reply = world.jira ?? { body: JIRA_BODY }
    else if (req.body?.includes('items_page')) reply = world.mondayItems ?? { body: MONDAY_ITEMS }
    else reply = world.mondayBoards ?? { body: MONDAY_BOARDS }
    if (reply === 'hang') {
      await clock.sleep(60_000)
      reply = { body: {} }
    }
    return response(reply)
  })
  return { argvs, requests }
}

let paneOpen = false
function fakePanes(on: On) {
  paneOpen = false
  on('ui.open', async () => {
    paneOpen = true
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', async () => {
    const panes: UiPane[] = paneOpen ? [{ id: PANE, title: 'My issues', isShown: true, isFocused: false, isPlaced: true }] : []
    return { value: panes }
  })
}

async function openPane($: Engine, on: On, surface: 'terminal' | 'desktop', world: World = {}, env: Record<string, string> = ENV) {
  const clock = mock.clock(on, { now: Date.now() })
  mock.env(on, env)
  fakePanes(on)
  const calls = fakeWorld(on, clock, world)
  await $.command.run({ command: 'issues', args: '' } as never)
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'my-issues', surface, component: 'Pane',
    props: { title: 'My issues', isFocused: false } as never, requestId: PANE,
  })
  return { ui, clock, ...calls }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`groups open issues by provider on ${surface}`, async ($, on) => {
    const { ui } = await openPane($, on, surface)
    expect(await ui.find({ text: /5 open issues assigned to you/ })).toBeDefined()
    expect(await ui.find({ text: /^GitHub/ })).toBeDefined()
    expect(await ui.find({ key: 'insert:github:octo/app#12' })).toBeDefined()
    expect(await ui.find({ text: /Fix the login redirect.*open.*P1.*2h/ })).toBeDefined()
    expect(await ui.find({ text: /Ship the importer.*In Progress.*High.*30m/ })).toBeDefined()
    expect(await ui.find({ text: /Old idea.*Backlog/ })).toBeDefined()
    expect(await ui.find({ text: /No priority/ })).toBeUndefined()
    expect(await ui.find({ text: /Rotate the keys.*To Do.*Medium/ })).toBeDefined()
    expect(await ui.find({ text: /Write launch post.*Working on it.*Sprint board.*3d/ })).toBeDefined()
    expect(await ui.find({ text: /Already shipped/ })).toBeUndefined()
    const links = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
    expect(links).toContain('https://acme.atlassian.net/browse/PROJ-7')
    expect(links).toContain('https://github.com/octo/app/issues/12')
  })

  test(`builds each provider's request on ${surface}`, async ($, on) => {
    const { argvs, requests } = await openPane($, on, surface)
    expect(argvs).toEqual([[
      'gh', 'search', 'issues', '--assignee', '@me', '--state', 'open', '--sort', 'updated',
      '--limit', '20', '--json', 'number,title,url,repository,updatedAt,labels',
    ]])
    const linear = requests.find(r => r.url === 'https://api.linear.app/graphql')
    expect(linear?.method).toBe('POST')
    expect(linear?.headers.Authorization).toBe('lin_api_secret')
    const linearBody = JSON.parse(linear?.body ?? '{}')
    expect(linearBody.variables).toEqual({ first: 20 })
    expect(linearBody.query).toMatch(/assignedIssues\(first: \$first, orderBy: updatedAt, filter: \{ state: \{ type: \{ nin: \["completed", "canceled"\] \} \} \}\)/)

    const jira = requests.find(r => r.url.startsWith('https://acme.atlassian.net/'))
    const url = new URL(jira?.url ?? 'https://x')
    expect(url.pathname).toBe('/rest/api/3/search/jql')
    expect(url.searchParams.get('jql')).toBe('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC')
    expect(url.searchParams.get('maxResults')).toBe('20')
    expect(url.searchParams.get('fields')).toBe('summary,status,priority,updated')
    expect(jira?.headers.Authorization).toBe(`Basic ${btoa('me@acme.dev:jira-secret')}`)

    const monday = requests.filter(r => r.url === 'https://api.monday.com/v2')
    expect(monday.length).toBe(2)
    expect(monday[0]?.headers.Authorization).toBe('monday-secret')
    expect(monday[0]?.headers['API-Version']).toBe('2026-07')
    expect(JSON.parse(monday[0]?.body ?? '{}').query).toMatch(/boards\(limit: 10, order_by: used_at, state: active\) \{ id name columns\(types: \[people\]\)/)
    const items = JSON.parse(monday[1]?.body ?? '{}').query as string
    expect(items).toMatch(/b0: boards\(ids: \["111"\]\)/)
    expect(items).toMatch(/operator: or, rules: \[\{ column_id: "person", compare_value: \["assigned_to_me"\], operator: any_of \}, \{ column_id: "reviewer"/)
    expect(items).not.toMatch(/"222"/)
  })

  test(`says how to configure each provider when nothing is set on ${surface}`, async ($, on) => {
    const { ui, requests } = await openPane($, on, surface, { gh: 'missing' }, {})
    expect(await ui.find({ text: /not configured: gh CLI not found/ })).toBeDefined()
    expect(await ui.find({ text: /not configured: set LINEAR_API_KEY/ })).toBeDefined()
    expect(await ui.find({ text: /not configured: set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN/ })).toBeDefined()
    expect(await ui.find({ text: /not configured: set MONDAY_API_TOKEN/ })).toBeDefined()
    expect(requests.length).toBe(0)
  })

  test(`names only the missing Jira settings and a gh login on ${surface}`, async ($, on) => {
    const { ui } = await openPane($, on, surface, {
      gh: { exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' },
    }, { JIRA_BASE_URL: 'https://acme.atlassian.net' })
    expect(await ui.find({ text: /not configured: gh is not logged in/ })).toBeDefined()
    expect(await ui.find({ text: /not configured: set JIRA_EMAIL, JIRA_API_TOKEN \(/ })).toBeDefined()
  })

  test(`keeps the other providers when some fail on ${surface}`, async ($, on) => {
    const { ui } = await openPane($, on, surface, {
      gh: { exitCode: 1, stderr: 'warning\nHTTP 502: Bad Gateway' },
      linear: { status: 401, body: { errors: [{ message: 'Authentication required, not authenticated' }] } },
      jira: { status: 400, body: { errorMessages: ["Field 'sprint' does not exist"] } },
      mondayBoards: { status: 503, body: '<html>\n<body>Service Unavailable</body>' },
    })
    expect(await ui.find({ text: /^\s*HTTP 503$/ })).toBeDefined()
    expect(await ui.find({ text: /HTTP 502: Bad Gateway/ })).toBeDefined()
    expect(await ui.find({ text: /HTTP 401: Authentication required/ })).toBeDefined()
    expect(await ui.find({ text: /HTTP 400: Field 'sprint' does not exist/ })).toBeDefined()
    expect(await ui.find({ text: /0 open issues/ })).toBeDefined()
  })

  test(`shows GraphQL errors sent with a 200 on ${surface}`, async ($, on) => {
    const { ui } = await openPane($, on, surface, {
      mondayItems: { body: { errors: [{ message: 'Complexity budget exhausted' }] } },
    })
    expect(await ui.find({ text: /Complexity budget exhausted/ })).toBeDefined()
    expect(await ui.find({ text: /Ship the importer/ })).toBeDefined()
  })

  test(`times out a provider that does not answer on ${surface}`, async ($, on) => {
    const { ui, clock } = await openPane($, on, surface, { linear: 'hang' })
    expect(await ui.find({ text: /Loading your issues/ })).toBeDefined()
    await clock.advance(20_000)
    expect(await ui.find({ text: /timed out after 20s/ })).toBeDefined()
    expect(await ui.find({ text: /Rotate the keys/ })).toBeDefined()
  })

  test(`shows an empty provider as nothing open on ${surface}`, async ($, on) => {
    const { ui } = await openPane($, on, surface, {
      gh: { exitCode: 0, stdout: [] },
      mondayBoards: { body: { data: { boards: [{ id: '222', name: 'x', columns: [] }] } } },
    })
    expect(await ui.find({ text: /nothing open/ })).toBeDefined()
  })

  test(`pressing an issue puts a reference in the prompt on ${surface}`, async ($, on) => {
    const filled: { text: string; mode: string }[] = []
    on('prompt.fill', async ($, e) => {
      filled.push({ text: e.text, mode: e.mode })
      return { isFilled: true }
    })
    const { ui } = await openPane($, on, surface)
    await ui.press({ key: 'insert:linear:ENG-123' })
    expect(filled).toEqual([{ text: 'ENG-123: Ship the importer https://linear.app/acme/issue/ENG-123 ', mode: 'insert' }])
  })

  test(`copies the reference where there is no prompt box on ${surface}`, async ($, on) => {
    const copied: string[] = []
    const toasts: string[] = []
    on('prompt.fill', async () => ({ isFilled: false, refusal: 'no_composer' as const }))
    on('ui.copy', async ($, e) => {
      copied.push(e.text)
      return { value: { isCopied: true } }
    })
    on('ui.toast', async ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    const { ui } = await openPane($, on, surface)
    await ui.press({ key: 'insert:jira:PROJ-7' })
    expect(copied).toEqual(['PROJ-7: Rotate the keys https://acme.atlassian.net/browse/PROJ-7'])
    expect(toasts).toEqual(['Copied PROJ-7 to the clipboard'])
  })

  test(`refreshes on the button, on the interval, and stops once closed on ${surface}`, async ($, on) => {
    const { ui, clock, argvs } = await openPane($, on, surface)
    expect(argvs.length).toBe(1)
    await ui.press({ key: 'refresh' })
    expect(argvs.length).toBe(2)
    await clock.advance(5 * 60_000)
    expect(argvs.length).toBe(3)
    // Closed: the next tick finds no pane and stops the timer for good.
    paneOpen = false
    await clock.advance(5 * 60_000)
    paneOpen = true
    await clock.advance(15 * 60_000)
    expect(argvs.length).toBe(3)
  })
}

test('github_scope "repo" lists the current repo', { options: { github_scope: 'repo' } }, async ($, on) => {
  const { argvs, ui } = await openPane($, on, 'terminal', {
    gh: { exitCode: 0, stdout: [{ number: 3, title: 'Local bug', url: 'https://github.com/me/here/issues/3', updatedAt: ago(HOUR), labels: [] }] },
  })
  expect(argvs[0]?.slice(0, 3)).toEqual(['gh', 'issue', 'list'])
  expect(await ui.find({ key: 'insert:github:me/here#3' })).toBeDefined()
})

test('github_scope owners and repos each get a search, merged without duplicates', { options: { github_scope: 'octo, octo/app other/lib' } }, async ($, on) => {
  const { argvs, ui } = await openPane($, on, 'terminal')
  expect(argvs.map(a => a.slice(13))).toEqual([['--repo', 'octo/app', '--repo', 'other/lib'], ['--owner', 'octo']])
  expect(await ui.find({ text: /^GitHub.*\(1\)/ })).toBeDefined()
})

test('a provider turned off is neither fetched nor drawn', { options: { linear: false, jira: false, monday: false } }, async ($, on) => {
  const { requests, ui } = await openPane($, on, 'desktop')
  expect(requests.length).toBe(0)
  expect(await ui.find({ text: /^Linear/ })).toBeUndefined()
  expect(await ui.find({ text: /1 open issue assigned/ })).toBeDefined()
})

test('every provider off says so', { options: { github: false, linear: false, jira: false, monday: false } }, async ($, on) => {
  const { ui } = await openPane($, on, 'terminal')
  expect(await ui.find({ text: /Every provider is turned off/ })).toBeDefined()
})

test('jira_jql, limit and monday_boards shape the requests', { options: { jira_jql: 'project = OPS', limit: 5, monday_boards: '123, 456' } }, async ($, on) => {
  const { argvs, requests } = await openPane($, on, 'terminal')
  expect(argvs[0]).toContain('5')
  const jira = new URL(requests.find(r => r.url.includes('atlassian'))?.url ?? 'https://x')
  expect(jira.searchParams.get('jql')).toBe('project = OPS')
  expect(jira.searchParams.get('maxResults')).toBe('5')
  expect(JSON.parse(requests.find(r => r.url.includes('linear'))?.body ?? '{}').variables).toEqual({ first: 5 })
  const monday = requests.filter(r => r.url.includes('monday')).map(r => JSON.parse(r.body ?? '{}').query as string)
  expect(monday[0]).toMatch(/boards\(ids: \["123", "456"\]\)/)
  expect(monday[1]).toMatch(/items_page\(limit: 5,/)
})

test('a non-numeric monday board id is an error, not a request', { options: { monday_boards: '123, "x"' } }, async ($, on) => {
  const { requests, ui } = await openPane($, on, 'terminal')
  expect(requests.filter(r => r.url.includes('monday')).length).toBe(0)
  expect(await ui.find({ text: /monday_boards takes numeric board ids/ })).toBeDefined()
})

test('a token in the settings wins over the environment', { options: { linear_api_key: 'from-settings', jira_base_url: 'ftp://nope' } }, async ($, on) => {
  const { requests, ui } = await openPane($, on, 'terminal')
  expect(requests.find(r => r.url.includes('linear'))?.headers.Authorization).toBe('from-settings')
  expect(await ui.find({ text: /Jira site URL must start with https/ })).toBeDefined()
})

test('refresh_minutes sets the interval', { options: { refresh_minutes: 1 } }, async ($, on) => {
  const { clock, argvs } = await openPane($, on, 'terminal')
  await clock.advance(60_000)
  expect(argvs.length).toBe(2)
})
