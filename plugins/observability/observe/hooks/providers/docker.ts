import type { PluginOptions, ProcessRunResult } from 'claude-code'

import type { Io } from '../io'
import type { RowState } from '../tab-pane'
import type { ObserveRow, Snapshot } from '../../types'
import { lastLine, num, plural } from '../util'
import type { ProviderOf } from './index'

// One `docker ps --format '{{json .}}'` line; only the fields read here.
type PsLine = { ID: string; Image: string; Status: string; Ports?: string; Names: string; State?: string }

const DEFAULT_REFRESH_S = 2
const DOCKER_TIMEOUT_MS = 5_000
const NO_DAEMON = /Cannot connect to the Docker daemon/i
const DENIED = /permission denied/i
const NOT_FOUND = /ENOENT/ // the engine says "failed to start: ENOENT: Executable not found in $PATH"
const ROW_STATES: Record<string, RowState> = { running: 'ok', restarting: 'busy', removing: 'busy', dead: 'error' }

export const dockerArgv = (context: string, all: boolean) => [
  'docker', ...(context ? ['--context', context] : []), 'ps', ...(all ? ['--all'] : []), '--format', '{{json .}}',
]

export function parsePs(stdout: string): ObserveRow[] {
  return stdout.split('\n').filter(l => l.trim()).map(l => {
    const r = JSON.parse(l) as PsLine
    return {
      id: r.ID,
      state: ROW_STATES[r.State ?? ''] ?? 'idle',
      title: r.Names,
      tags: [
        { text: r.Image },
        { text: r.Status, dimColor: true },
        ...(r.Ports ? [{ text: r.Ports, dimColor: true }] : []),
      ],
      copyText: r.Names,
    }
  })
}

// A missing CLI or a stopped daemon is a normal state on a machine that is not using Docker
// right now, so it is `unavailable` (one dim line); anything else is an `error` worth fixing.
export function readDocker(ps: PromiseSettledResult<ProcessRunResult>): Snapshot {
  if (ps.status === 'rejected') {
    const why = ps.reason instanceof Error ? ps.reason.message : String(ps.reason)
    return NOT_FOUND.test(why) ? { rows: [], unavailable: 'Docker is not installed.' } : { rows: [], error: why }
  }
  const { exitCode, stdout, stderr } = ps.value
  if (exitCode !== 0) {
    if (NO_DAEMON.test(stderr)) return { rows: [], unavailable: 'The Docker daemon is not running.' }
    if (DENIED.test(stderr)) return { rows: [], error: 'permission denied on the Docker socket' }
    return { rows: [], error: lastLine(stderr, exitCode) }
  }
  return { rows: parsePs(stdout) }
}

export type DockerConfig = { context: string; all: boolean; refreshMs: number }

export async function fetchDocker(io: Io, cfg: DockerConfig): Promise<Snapshot> {
  const [ps] = await Promise.allSettled([
    io.run(dockerArgv(cfg.context, cfg.all), { timeoutMs: DOCKER_TIMEOUT_MS }),
  ])
  return { ...readDocker(ps), context: cfg.context || undefined }
}

export function docker(options: PluginOptions): ProviderOf<'docker'> {
  const all = options.docker_all === true
  const refreshMs = num(options.docker_refresh_seconds, DEFAULT_REFRESH_S, 1, 3600) * 1000
  return {
    id: 'docker',
    title: 'Docker',
    config: { context: String(options.docker_context ?? '').trim(), all, refreshMs },
    intervalMs: () => refreshMs,
    view: snap => ({
      rows: snap.rows,
      summary: `${plural(snap.rows.length, 'container')}${all ? '' : ' running'}`,
      empty: all ? 'No containers.' : 'No containers running.',
    }),
  }
}
