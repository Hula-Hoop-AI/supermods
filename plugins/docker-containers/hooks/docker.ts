import type { ProcessRunResult } from 'claude-code'

import type { DockerContainer, DockerSnapshot } from '../types'

// One `docker ps --format '{{json .}}'` line; only the fields read here. `Command` comes quoted
// and truncated, and `RunningFor` is the CREATED column, exactly as `docker ps` prints them.
type PsLine = {
  ID: string; Image: string; Command: string; RunningFor: string; Status: string; Ports: string; Names: string
}

const HEADERS = ['CONTAINER ID', 'IMAGE', 'COMMAND', 'CREATED', 'STATUS', 'PORTS', 'NAMES']
const COLUMN_GAP = '   ' // as `docker ps` separates its columns
const NO_DAEMON = /Cannot connect to the Docker daemon/i
const DENIED = /permission denied/i
const NOT_FOUND = /ENOENT/ // the engine says "failed to start: ENOENT: Executable not found in $PATH"

export const dockerArgv = (context: string, all: boolean) => [
  'docker', ...(context ? ['--context', context] : []), 'ps', ...(all ? ['--all'] : []), '--format', '{{json .}}',
]

export function parsePs(stdout: string): DockerContainer[] {
  return stdout.split('\n').filter(l => l.trim()).map(l => {
    const r = JSON.parse(l) as PsLine
    return {
      id: r.ID, image: r.Image, command: r.Command, created: r.RunningFor,
      status: r.Status, ports: r.Ports ?? '', name: r.Names,
    }
  })
}

// The `docker ps` table: each column padded to its widest cell, the last one not padded.
export function formatTable(containers: DockerContainer[]): { header: string; rows: string[] } {
  const cells = [
    HEADERS,
    ...containers.map(c => [c.id, c.image, c.command, c.created, c.status, c.ports, c.name]),
  ]
  const widths = HEADERS.map((_, i) => Math.max(...cells.map(r => r[i]!.length)))
  const [header, ...rows] = cells.map(r =>
    r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join(COLUMN_GAP),
  )
  return { header: header!, rows }
}

// A missing CLI or a stopped daemon is a normal state on a machine that is not using Docker
// right now, so it is `unavailable` (one dim line); anything else is an `error` worth fixing.
export function readDocker(ps: PromiseSettledResult<ProcessRunResult>): DockerSnapshot {
  if (ps.status === 'rejected') {
    const why = ps.reason instanceof Error ? ps.reason.message : String(ps.reason)
    return NOT_FOUND.test(why) ? { containers: [], unavailable: 'not installed' } : { containers: [], error: why }
  }
  const { exitCode, stdout, stderr } = ps.value
  if (exitCode !== 0) {
    if (NO_DAEMON.test(stderr)) return { containers: [], unavailable: 'daemon not running' }
    if (DENIED.test(stderr)) return { containers: [], error: 'permission denied on the Docker socket' }
    return { containers: [], error: stderr.trim().split('\n').pop() || `exit ${exitCode}` }
  }
  return { containers: parsePs(stdout) }
}
