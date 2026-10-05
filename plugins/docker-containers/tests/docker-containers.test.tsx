import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { formatTable, parsePs } from '../hooks/docker'

type Run = { exitCode: number; stdout?: string; stderr?: string }
const result = ({ exitCode, stdout = '', stderr = '' }: Run) => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

// `docker ps --format '{{json .}}'` prints one JSON object per line.
const jsonl = (rows: object[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
const PS = [
  {
    ID: 'aaa111', Image: 'nginx:1.27', Command: '"/docker-entrypoint.…"', RunningFor: '3 hours ago',
    Status: 'Up 3 hours', Ports: '0.0.0.0:8080->80/tcp', Names: 'webapp-web-1', State: 'running',
  },
  {
    ID: 'bbb222', Image: 'postgres:16', Command: '"docker-entrypoint.s…"', RunningFor: '3 hours ago',
    Status: 'Up 3 hours (healthy)', Ports: '5432/tcp', Names: 'webapp-db-1', State: 'running',
  },
]
const STOPPED = {
  ID: 'ddd444', Image: 'busybox', Command: '"sh"', RunningFor: '2 hours ago',
  Status: 'Exited (0) 2 hours ago', Ports: '', Names: 'old-job', State: 'exited',
}
const OK: Run = { exitCode: 0, stdout: jsonl(PS) }

// Answers every `docker ps` with `answer` (an Error stands for a run that rejects) and records
// every argv.
function fakeDocker(on: On, answer: Run | Error) {
  const asked: string[][] = []
  on('process.run', async ($, e) => {
    asked.push([...e.argv])
    if (answer instanceof Error) return { deny: answer.message } // the run rejects with it
    return result(answer)
  })
  return asked
}

async function openPane($: Engine, on: On, surface: 'terminal' | 'desktop') {
  const clock = mock.clock(on)
  const pane = { isOpen: true }
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', async () => ({
    value: pane.isOpen
      ? [{ id: 'docker-containers', title: 'docker ps', isShown: true, isFocused: false, isPlaced: true }]
      : [],
  }) as never)
  await $.command.run({ command: 'docker', args: '' } as never)
  await clock.settle() // let the first, unawaited refresh finish
  const ui = await $.ui.mount({
    plugin: 'docker-containers', surface, component: 'Pane',
    props: { title: 'docker ps', isFocused: false } as never, requestId: 'docker-containers',
  })
  return { ui, clock, pane }
}

test('parses docker ps lines and lays them out as the docker ps table', () => {
  const containers = parsePs(jsonl(PS))
  expect(containers[0]).toEqual({
    id: 'aaa111', image: 'nginx:1.27', command: '"/docker-entrypoint.…"', created: '3 hours ago',
    status: 'Up 3 hours', ports: '0.0.0.0:8080->80/tcp', name: 'webapp-web-1',
  })
  const { header, rows } = formatTable(containers)
  expect(header).toBe(
    'CONTAINER ID   IMAGE         COMMAND                  CREATED       STATUS                 PORTS                  NAMES',
  )
  expect(rows).toEqual([
    'aaa111         nginx:1.27    "/docker-entrypoint.…"   3 hours ago   Up 3 hours             0.0.0.0:8080->80/tcp   webapp-web-1',
    'bbb222         postgres:16   "docker-entrypoint.s…"   3 hours ago   Up 3 hours (healthy)   5432/tcp               webapp-db-1',
  ])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`shows docker ps, one row per container in its order, on ${surface}`, async ($, on) => {
    const asked = fakeDocker(on, OK)
    const { ui } = await openPane($, on, surface)
    expect(asked).toEqual([['docker', 'ps', '--format', '{{json .}}']])
    expect(await ui.find({ type: 'Text', text: /^CONTAINER ID {3}IMAGE .* NAMES$/ })).toBeDefined()
    const rows = await ui.findAll({ type: 'Text', text: /^(aaa111|bbb222) / })
    expect(rows.map(r => r.text?.slice(0, 6))).toEqual(['aaa111', 'bbb222'])
    expect(rows[0]?.text).toMatch(/nginx:1\.27 .* 3 hours ago .* Up 3 hours .* 0\.0\.0\.0:8080->80\/tcp {3}webapp-web-1$/)
    expect(await ui.find({ text: /every 2s/ })).toBeDefined()
  })

  test(`a machine without docker shows one dim line on ${surface}`, async ($, on) => {
    fakeDocker(on, new Error('$.process.run(docker) failed to start: ENOENT: Executable not found in $PATH: "docker"'))
    const { ui } = await openPane($, on, surface)
    expect((await ui.find({ type: 'Text', text: 'Docker: not installed' }))?.props.dimColor).toBe(true)
    expect(await ui.findAll({ type: 'Text' })).toHaveLength(1)
  })

  test(`a stopped daemon shows one dim line on ${surface}`, async ($, on) => {
    fakeDocker(on, {
      exitCode: 1,
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    })
    const { ui } = await openPane($, on, surface)
    expect((await ui.find({ type: 'Text', text: 'Docker: daemon not running' }))?.props.dimColor).toBe(true)
    expect(await ui.findAll({ type: 'Text' })).toHaveLength(1)
  })

  test(`a denied socket is shown in red on ${surface}`, async ($, on) => {
    fakeDocker(on, {
      exitCode: 1,
      stderr: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
    })
    const { ui } = await openPane($, on, surface)
    expect((await ui.find({ type: 'Text', text: 'permission denied on the Docker socket' }))?.props.color).toBe('red')
  })

  test(`other docker failures show their last line in red on ${surface}`, async ($, on) => {
    fakeDocker(on, { exitCode: 1, stderr: 'context "nope": context not found' })
    const { ui } = await openPane($, on, surface)
    expect((await ui.find({ type: 'Text', text: 'context "nope": context not found' }))?.props.color).toBe('red')
  })

  test(`a docker timeout is an error, not a missing CLI, on ${surface}`, async ($, on) => {
    fakeDocker(on, new Error('process timed out after 5000 ms'))
    const { ui } = await openPane($, on, surface)
    expect((await ui.find({ type: 'Text', text: /timed out/ }))?.props.color).toBe('red')
    expect(await ui.find({ text: /not installed/ })).toBeUndefined()
  })

  test(`an empty list says so on ${surface}`, async ($, on) => {
    fakeDocker(on, { exitCode: 0, stdout: '' })
    const { ui } = await openPane($, on, surface)
    expect(await ui.find({ text: 'No containers running.' })).toBeDefined()
  })

  test(`context and all reach the docker command on ${surface}`, { options: { context: 'remote', all: true } }, async ($, on) => {
    const asked = fakeDocker(on, { exitCode: 0, stdout: jsonl([...PS, STOPPED]) })
    const { ui } = await openPane($, on, surface)
    expect(asked).toEqual([['docker', '--context', 'remote', 'ps', '--all', '--format', '{{json .}}']])
    expect(await ui.find({ type: 'Text', text: /^ddd444 .* Exited \(0\) 2 hours ago .* old-job$/ })).toBeDefined()
    expect(await ui.find({ text: /every 2s · remote/ })).toBeDefined()
  })

  test(`polls every 2s by default and stops once the pane is closed on ${surface}`, async ($, on) => {
    const asked = fakeDocker(on, OK)
    const { clock, pane } = await openPane($, on, surface)
    expect(asked).toHaveLength(1)
    await clock.advance(1_999)
    expect(asked).toHaveLength(1)
    await clock.advance(1)
    expect(asked).toHaveLength(2)
    await clock.advance(2_000)
    expect(asked).toHaveLength(3)
    // A test cannot fire `ui.close` (a mods API call), so this covers the per-tick pane check
    // that backs the `ui.close` hook up.
    pane.isOpen = false
    await clock.advance(2_000)
    await clock.advance(60_000)
    expect(asked).toHaveLength(3)
  })

  test(`refresh_seconds sets the interval on ${surface}`, { options: { refresh_seconds: 30 } }, async ($, on) => {
    const asked = fakeDocker(on, OK)
    const { ui, clock } = await openPane($, on, surface)
    expect(await ui.find({ text: /every 30s/ })).toBeDefined()
    await clock.advance(29_000)
    expect(asked).toHaveLength(1)
    await clock.advance(1_000)
    expect(asked).toHaveLength(2)
  })

  test(`a slow docker ps skips ticks instead of stacking calls on ${surface}`, async ($, on) => {
    let calls = 0
    let finish = () => {}
    on('process.run', async () => {
      calls++
      await new Promise<void>(resolve => { finish = resolve })
      return result(OK)
    })
    const { ui, clock } = await openPane($, on, surface)
    expect(calls).toBe(1)
    await clock.advance(2_000)
    await clock.advance(2_000)
    expect(calls).toBe(1) // still the first call
    finish()
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /^aaa111 / })).toBeDefined()
    await clock.advance(2_000)
    expect(calls).toBe(2)
  })

  test(`the copy button copies the container name on ${surface}`, async ($, on) => {
    fakeDocker(on, OK)
    const copied: string[] = []
    on('ui.copy', async ($, e) => {
      copied.push(e.text)
      return { value: { isCopied: true as const } }
    })
    const { ui } = await openPane($, on, surface)
    expect((await ui.find({ key: 'copy:bbb222' }))?.text).toBe('copy')
    await ui.press({ key: 'copy:bbb222' })
    expect(copied).toEqual(['webapp-db-1'])
  })
}
