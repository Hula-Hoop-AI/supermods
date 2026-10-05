import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { DockerSnapshot } from '../types'
import { dockerArgv, formatTable, readDocker } from './docker'

const PANE = 'docker-containers'
const DEFAULT_REFRESH_S = 2
const DOCKER_TIMEOUT_MS = 5_000 // longer than a tick: ticks are skipped while a call is still running
const docker = atom({ plugin: 'docker-containers', key: 'docker' } as const, {
  containers: [],
} as DockerSnapshot)

let timer: Timer | undefined
let isRefreshing = false
// The plugin's settings; a change there reloads the module.
let context = ''
let all = false
let refreshMs = DEFAULT_REFRESH_S * 1000

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

// One `docker ps` at a time: a tick that finds the previous call still running is skipped, so
// a slow daemon never stacks calls.
async function refresh($: EngineInterface) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const [ps] = await Promise.allSettled([
      $.process.run(dockerArgv(context, all), { timeoutMs: DOCKER_TIMEOUT_MS }),
    ])
    let next: DockerSnapshot
    try {
      next = readDocker(ps)
    } catch (err) {
      next = { containers: [], error: message(err) }
    }
    await update($, docker, () => ({ ...next, checkedAt: Date.now() }))
  } finally {
    isRefreshing = false
  }
}

function stopPolling() {
  timer?.cancel()
  timer = undefined
}

// Refreshes while the pane is open. `ui.close` stops it at once; the pane check on each
// tick also stops it should a close go unheard (e.g. across a reload).
function startPolling($: EngineInterface) {
  stopPolling()
  void refresh($)
  timer = $.clock.every(refreshMs, async () => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) await refresh($)
    else stopPolling()
  })
}

function clampNumber(v: unknown, fallback: number, min: number, max: number) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

export const register: Register = (on, options) => {
  context = String(options.context ?? '').trim()
  all = options.all === true
  refreshMs = clampNumber(options.refresh_seconds, DEFAULT_REFRESH_S, 1, 3600) * 1000

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'docker',
      description: 'Show `docker ps` in a pane',
    })
    // A reload (a settings change, a new version) drops the old timer but keeps the
    // pane open: pick the polling back up so it does not freeze on stale data.
    if ((await $.ui.panes()).some(p => p.id === PANE)) startPolling($)
    return next(e)
  })

  on('command.run', { command: 'docker' }, async $ => {
    await $.ui.open({ id: PANE, title: 'docker ps' })
    startPolling($)
    return { text: `docker ps pane opened (refreshes every ${refreshMs / 1000}s).` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    stopPolling()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const dk = await read($, docker)
    if (dk.unavailable) return <Text dimColor>Docker: {dk.unavailable}</Text>

    const room = Math.max(1, (e.viewport?.rows ?? 24) - 5)
    const { header, rows } = formatTable(dk.containers)

    const copyName = async (name: string, surface: typeof e.surface) => {
      const r = await $.ui.copy({ text: name, surface })
      $.ui.toast(r.isCopied ? `Copied ${name}` : `Could not copy (${r.reason})`)
    }

    return (
      <Box flexDirection="column">
        {dk.error && <Text color="red">{dk.error}</Text>}
        {dk.checkedAt === undefined && <Text dimColor>Checking…</Text>}
        {dk.checkedAt !== undefined && !dk.error && (
          <Text bold wrap="truncate-end">{header}</Text>
        )}
        {dk.checkedAt !== undefined && !dk.error && rows.length === 0 && (
          <Text dimColor>{all ? 'No containers.' : 'No containers running.'}</Text>
        )}
        {rows.slice(0, room).map((row, i) => {
          const c = dk.containers[i]!
          return (
            <Box flexDirection="row" gap={1}>
              <Text wrap="truncate-end">{row}</Text>
              <Button key={`copy:${c.id}`} dimColor onPress={press => void copyName(c.name, press.surface)}>
                copy
              </Button>
            </Box>
          )
        })}
        {rows.length > room && <Text dimColor>…and {rows.length - room} more</Text>}
        {dk.checkedAt !== undefined && (
          <Text dimColor>
            updated {new Date(dk.checkedAt).toLocaleTimeString()} · every {refreshMs / 1000}s
            {context && <Text> · {context}</Text>}
          </Text>
        )}
      </Box>
    )
  })
}
