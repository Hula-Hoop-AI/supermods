import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

type Run = { exitCode: number; stdout?: unknown; stderr?: string }
const result = ({ exitCode, stdout = '', stderr = '' }: Run) => ({
  value: {
    exitCode,
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    stderr,
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
})

const HELPER = {
  me: 'alice',
  env: 'main',
  apps: [
    {
      app_id: 'ap-1', app_name: 'train-llm', created_by: 'alice',
      containers: [{ container_id: 'ta-1', started_at: 0 }, { container_id: 'ta-2', started_at: 0 }],
    },
    {
      app_id: 'ap-2', app_name: 'batch-embed', created_by: 'bob',
      containers: [{ container_id: 'ta-3', started_at: 0 }],
    },
  ],
}
const CLI_ROWS = [
  { container_id: 'ta-9', app_id: 'ap-9', app_name: 'cli-only-app', start_time: 'Pending' },
]
const BILLING = [
  { object_id: 'ap-1', cost: '1.25' },
  { object_id: 'ap-1', cost: '0.50' },
  { object_id: 'ap-2', cost: '3.00' },
]

// Answers process.run per command: the helper runs under `sh`, the rest are `modal ...`.
function fakeModal(on: On, answers: { helper: Run; list?: Run; billing: Run }) {
  on('process.run', async ($, e) => {
    if (e.argv[0] === 'sh') return result(answers.helper)
    if (e.argv[1] === 'container') return result(answers.list ?? { exitCode: 1, stderr: 'no list' })
    return result(answers.billing)
  })
}

async function openPane($: Engine, on: On, surface: 'terminal' | 'desktop') {
  const clock = mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  await $.command.run({ command: 'modal', args: '' } as never)
  await clock.settle() // let the first, unawaited refreshes finish
  return $.ui.mount({
    plugin: 'modal-containers', surface, component: 'Pane',
    props: { title: 'Modal', isFocused: false } as never, requestId: 'modal-containers',
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`groups containers by app with creator and cost on ${surface}`, async ($, on) => {
    mock.env(on, {})
    fakeModal(on, { helper: { exitCode: 0, stdout: HELPER }, billing: { exitCode: 0, stdout: BILLING } })
    const ui = await openPane($, on, surface)
    expect(await ui.find({ text: /3 running containers/ })).toBeDefined()
    expect(await ui.find({ text: /main/ })).toBeDefined()
    expect(await ui.find({ text: /train-llm.*×2.*alice.*\$1\.75/ })).toBeDefined()
    expect(await ui.find({ text: /batch-embed.*bob.*\$3\.00/ })).toBeDefined()
  })

  test(`the Mine only button keeps the user's own apps on ${surface}`, async ($, on) => {
    mock.env(on, {})
    fakeModal(on, { helper: { exitCode: 0, stdout: HELPER }, billing: { exitCode: 0, stdout: BILLING } })
    const ui = await openPane($, on, surface)
    await ui.press({ key: 'mine' })
    expect(await ui.find({ text: /2 running containers/ })).toBeDefined()
    expect(await ui.find({ text: /batch-embed/ })).toBeUndefined()
    await ui.press({ key: 'mine' })
    expect(await ui.find({ text: /batch-embed/ })).toBeDefined()
  })

  test(`falls back to the plain CLI when the helper fails on ${surface}`, async ($, on) => {
    mock.env(on, { MODAL_ENVIRONMENT: 'dev' })
    fakeModal(on, {
      helper: { exitCode: 1, stderr: "ImportError: cannot import name '_Client'" },
      list: { exitCode: 0, stdout: CLI_ROWS },
      billing: { exitCode: 0, stdout: [] },
    })
    const ui = await openPane($, on, surface)
    expect(await ui.find({ text: /cli-only-app/ })).toBeDefined()
    expect(await ui.find({ text: /creators unavailable/ })).toBeDefined()
    expect(await ui.find({ text: /dev/ })).toBeDefined()
    expect(await ui.find({ key: 'mine' })).toBeUndefined()
  })

  test(`the environment setting wins over MODAL_ENVIRONMENT on ${surface}`, { options: { environment: 'staging' } }, async ($, on) => {
    mock.env(on, { MODAL_ENVIRONMENT: 'dev' })
    const asked: string[][] = []
    on('process.run', async ($, e) => {
      asked.push([...e.argv])
      return result(e.argv[0] === 'sh' ? { exitCode: 1, stderr: 'no helper' } : { exitCode: 0, stdout: [] })
    })
    const ui = await openPane($, on, surface)
    expect(asked.find(a => a[0] === 'sh')?.at(-1)).toBe('staging')
    expect(asked.find(a => a[1] === 'container')).toEqual(['modal', 'container', 'list', '--json', '--env', 'staging'])
    expect(await ui.find({ text: /staging/ })).toBeDefined()
  })

  test(`shows the error when nothing can be listed on ${surface}`, async ($, on) => {
    mock.env(on, {})
    fakeModal(on, {
      helper: { exitCode: 127 },
      list: { exitCode: 1, stderr: 'Token missing' },
      billing: { exitCode: 1, stderr: 'Token missing' },
    })
    const ui = await openPane($, on, surface)
    expect(await ui.find({ text: 'Token missing' })).toBeDefined()
  })

  test(`keeps listing when billing is denied on ${surface}`, async ($, on) => {
    mock.env(on, {})
    fakeModal(on, {
      helper: { exitCode: 0, stdout: HELPER },
      billing: { exitCode: 1, stderr: 'PermissionDenied: billing requires a manager role' },
    })
    const ui = await openPane($, on, surface)
    expect(await ui.find({ text: /cost unavailable: PermissionDenied/ })).toBeDefined()
    expect(await ui.find({ text: /train-llm/ })).toBeDefined()
    expect(await ui.find({ text: /\$—/ })).toBeUndefined()
  })
}
