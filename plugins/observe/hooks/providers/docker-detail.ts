// What the Docker tab's logs and metrics panes read for one container: `docker logs`,
// `docker stats`, and once per container `docker inspect` and `docker info` for the limits the
// meters are drawn against. `docker exec <id> nvidia-smi` runs only for a container that has
// GPUs assigned.
import type { Io } from '../io'
import type { Logs, Metrics } from '../../types'
import { lastLine, message, targetOf } from '../util'
import { parseNvidiaSmi } from './modal-detail'

const DOCKER_TIMEOUT_MS = 10_000
const MAX_LINES = 100

const base = (context?: string) => ['docker', ...(context ? ['--context', context] : [])]

const UNITS: Record<string, number> = {
  B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30, TiB: 2 ** 40,
}

// "2.699MiB", "1.63kB", "0B" to bytes; undefined when it does not read as a size.
export function parseSize(s: string | undefined): number | undefined {
  const m = /^([\d.]+)\s*([kKMGT]i?B|B)$/.exec(s?.trim() ?? '')
  const unit = m && UNITS[m[2]!]
  return m && unit ? Number(m[1]) * unit : undefined
}

export type DockerStats = { cores?: number; memUsed?: number; net: string; block: string }

// One `docker stats --no-stream --format '{{json .}}'` line. CPUPerc counts 100% per core.
export function parseStats(out: string): DockerStats | undefined {
  const line = out.split('\n').find(l => l.trim().startsWith('{'))
  if (!line) return undefined
  const s = JSON.parse(line) as { CPUPerc?: string; MemUsage?: string; NetIO?: string; BlockIO?: string }
  const pair = (v: string | undefined, a: string, b: string) => {
    const [x, y] = (v ?? '').split('/').map(p => p.trim())
    return x && y ? `${x} ${a} / ${y} ${b}` : '—'
  }
  const perc = parseFloat(s.CPUPerc ?? '')
  return {
    cores: Number.isFinite(perc) ? perc / 100 : undefined,
    memUsed: parseSize(s.MemUsage?.split('/')[0]),
    net: pair(s.NetIO, 'in', 'out'),
    block: pair(s.BlockIO, 'read', 'written'),
  }
}

type HostConfig = {
  NanoCpus?: number
  CpuQuota?: number
  CpuPeriod?: number
  Memory?: number
  DeviceRequests?: { Capabilities?: string[][] }[] | null
}

// `docker inspect <id>`: the container's own CPU and memory limits (absent when none is set),
// and whether a device request asks for GPUs.
export function parseInspect(out: string): { cpus?: number; memory?: number; hasGpu: boolean } {
  const [c] = JSON.parse(out) as { HostConfig?: HostConfig }[]
  const h = c?.HostConfig ?? {}
  const cpus = h.NanoCpus ? h.NanoCpus / 1e9 : h.CpuQuota && h.CpuQuota > 0 && h.CpuPeriod ? h.CpuQuota / h.CpuPeriod : undefined
  const hasGpu = (h.DeviceRequests ?? []).some(r => (r.Capabilities ?? []).flat().some(cap => cap.includes('gpu')))
  return { cpus, memory: h.Memory ? h.Memory : undefined, hasGpu }
}

// `docker info --format '{{json .}}'`: what the Docker host gives a container without limits.
export function parseInfo(out: string): { ncpu?: number; memTotal?: number } {
  const i = JSON.parse(out) as { NCPU?: number; MemTotal?: number }
  return { ncpu: i.NCPU || undefined, memTotal: i.MemTotal || undefined }
}

// RFC 3339 with nanoseconds, trailing zeros trimmed: pad the fraction so the text sorts by time.
const timeKey = (ts: string) => ts.replace(/(?:\.(\d+))?Z$/, (_, frac: string | undefined) => `.${(frac ?? '').padEnd(9, '0')}Z`)

// The container's stdout and stderr arrive on separate pipes; their timestamps put them back
// in order. Ties keep stdout first.
export function mergeLogs(stdout: string, stderr: string): string[] {
  return [...stdout.split('\n'), ...stderr.split('\n')]
    .filter(l => l.trim())
    .map((l, i) => {
      const sp = l.indexOf(' ')
      const ts = sp > 0 ? l.slice(0, sp) : ''
      const isTs = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(ts)
      return { key: isTs ? timeKey(ts) : '', text: isTs ? l.slice(sp + 1) : l, i }
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i))
    .map(l => l.text)
    .slice(-MAX_LINES)
}

export async function fetchDockerLogs(io: Io, prev: Logs): Promise<Logs> {
  const t = targetOf(prev)
  try {
    const { exitCode, stdout, stderr } = await io.run(
      [...base(t.context), 'logs', '--tail', String(MAX_LINES), '--timestamps', t.container_id],
      { timeoutMs: DOCKER_TIMEOUT_MS },
    )
    if (exitCode !== 0) return { ...t, lines: prev.lines, error: lastLine(stderr, exitCode), checkedAt: await io.now() }
    return { ...t, lines: mergeLogs(stdout, stderr), checkedAt: await io.now() }
  } catch (err) {
    return { ...t, lines: prev.lines, error: message(err), checkedAt: await io.now() }
  }
}

export async function fetchDockerMetrics(io: Io, prev: Metrics): Promise<Metrics> {
  const t = targetOf(prev)
  const run = (args: string[]) => io.run([...base(t.context), ...args], { timeoutMs: DOCKER_TIMEOUT_MS })
  const next: Metrics = { ...t, limits: prev.limits }
  try {
    if (!next.limits) {
      const [inspect, info] = await Promise.all([run(['inspect', t.container_id]), run(['info', '--format', '{{json .}}'])])
      if (inspect.exitCode !== 0) throw new Error(lastLine(inspect.stderr, inspect.exitCode))
      const own = parseInspect(inspect.stdout)
      const host = info.exitCode === 0 ? parseInfo(info.stdout) : {}
      next.limits = { cpus: own.cpus ?? host.ncpu, cpusHost: own.cpus === undefined, memTotal: host.memTotal, hasGpu: own.hasGpu }
      next.memLimit = own.memory
    } else next.memLimit = prev.memLimit
    const [stats, gpu] = await Promise.all([
      run(['stats', '--no-stream', '--format', '{{json .}}', t.container_id]),
      next.limits.hasGpu ? run(['exec', t.container_id, 'nvidia-smi']) : undefined,
    ])
    if (stats.exitCode !== 0) throw new Error(lastLine(stats.stderr, stats.exitCode))
    const s = parseStats(stats.stdout)
    if (s) Object.assign(next, { cores: s.cores, memUsed: s.memUsed, io: { net: s.net, block: s.block } })
    else next.cpuMemNote = 'docker stats printed nothing'
    if (gpu) {
      next.gpus = gpu.exitCode === 0 ? parseNvidiaSmi(gpu.stdout) : undefined
      if (!next.gpus) next.gpuNote = gpu.exitCode === 0 ? gpu.stdout.trim().split('\n')[0] : lastLine(gpu.stderr, gpu.exitCode)
    }
  } catch (err) {
    next.error = message(err)
  }
  next.checkedAt = await io.now()
  return next
}
