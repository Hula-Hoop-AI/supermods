// What the Modal tab's logs and metrics panes read for one container. The metrics come from bare
// `nvidia-smi` and `cat <files>` run in the container through `modal container exec --no-pty`:
// Modal's argument parser takes any dash-flag as its own, so the remote commands carry none and
// are parsed here. The exec does not pass the remote exit code back and prints remote stderr on
// stdout, so failures are recognized from the text.
import type { Io } from '../io'
import type { Gpu, Logs, Metrics } from '../../types'
import { message, targetOf } from '../util'

const LOGS_TIMEOUT_MS = 15_000
const EXEC_TIMEOUT_MS = 8_000

// cgroup v2, cgroup v1 (what Modal's gVisor sandboxes expose), then /proc as a last resort.
export const CPU_MEM_FILES = [
  ['/sys/fs/cgroup/cpu.stat', '/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max'],
  [
    '/sys/fs/cgroup/cpuacct/cpuacct.usage',
    '/sys/fs/cgroup/memory/memory.usage_in_bytes',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  ],
  ['/proc/loadavg', '/proc/meminfo'],
] as const

// Per CPU_MEM_FILES layout, the CPU quota files and the machine's memory size, read once per
// container: a meter needs a real denominator. Missing files just leave a figure out.
export const LIMIT_FILES = [
  ['/sys/fs/cgroup/cpu.max', '/proc/meminfo'],
  ['/sys/fs/cgroup/cpu/cpu.cfs_quota_us', '/sys/fs/cgroup/cpu/cpu.cfs_period_us', '/proc/meminfo'],
] as const

export type Limits = { cpus?: number; memTotal?: number }

export type CpuMem = {
  usageNs?: number // cumulative CPU time (cgroups); cores in use come from two samples
  load?: number // 1-minute load average (the /proc fallback only)
  memUsed: number // bytes
  memLimit?: number // bytes; absent when unlimited
}

// cgroup v1 writes "unlimited" as a huge page-aligned number, v2 as the word "max".
const UNLIMITED = 2 ** 62

// The error box the modal CLI prints, e.g. "│ No Container with ID 'ta-1' found │".
export function cliError(stderr: string, exitCode: number): string {
  const boxed = stderr
    .split('\n')
    .filter(l => l.startsWith('│'))
    .map(l => l.replace(/^│\s*|\s*│$/g, ''))
    .join(' ')
    .trim()
  return boxed || stderr.trim().split('\n').pop() || `exit ${exitCode}`
}

const num = (s: string | undefined) => (s === undefined ? undefined : Number(s))

// `nvidia-smi` (the default table) to one entry per GPU; undefined when there is no table.
export function parseNvidiaSmi(out: string): Gpu[] | undefined {
  const lines = out.split('\n')
  const gpus: Gpu[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes('Processes:')) break
    const head = /^\|\s+(\d+)\s+(.+?)\s+(?:On|Off)\s+\|/.exec(lines[i]!)
    const cols = lines[i + 1]?.split('|')
    if (!head || !cols || cols.length < 4) continue
    const power = /(\d+)W\s*\/\s*(\d+)W/.exec(cols[1]!)
    const mem = /(\d+)MiB\s*\/\s*(\d+)MiB/.exec(cols[2]!)
    gpus.push({
      index: Number(head[1]),
      name: head[2]!,
      util: num(/(\d+)%/.exec(cols[3]!)?.[1]),
      memUsedMiB: num(mem?.[1]),
      memTotalMiB: num(mem?.[2]),
      powerW: num(power?.[1]),
      powerCapW: num(power?.[2]),
      tempC: num(/(\d+)C\b/.exec(cols[1]!)?.[1]),
    })
  }
  return gpus.length ? gpus : undefined
}

export const hasNoNvidiaSmi = (out: string) => out.includes('error finding executable "nvidia-smi"')

// The output of `cat` over one entry of CPU_MEM_FILES; undefined when any file is missing
// (that layout is not this container's) or the output does not have the expected shape.
export function parseCpuMem(layout: number, out: string): CpuMem | undefined {
  if (/^cat: /m.test(out)) return undefined
  const lines = out.trim().split('\n').map(l => l.trim())
  const bytes = (s: string | undefined) => {
    if (s === 'max') return undefined
    const n = Number(s)
    return n >= UNLIMITED ? undefined : n
  }
  if (layout === 0) {
    const usec = lines.find(l => l.startsWith('usage_usec '))?.split(/\s+/)[1]
    const [current, max] = lines.slice(-2)
    if (usec === undefined || !/^\d+$/.test(current ?? '')) return undefined
    return { usageNs: Number(usec) * 1000, memUsed: Number(current), memLimit: bytes(max) }
  }
  if (layout === 1) {
    if (lines.length !== 3 || !lines.every(l => /^\d+$/.test(l))) return undefined
    return { usageNs: Number(lines[0]), memUsed: Number(lines[1]), memLimit: bytes(lines[2]) }
  }
  const load = /^(\d+\.\d+) \d+\.\d+ \d+\.\d+ /.exec(lines[0] ?? '')
  const kb = (key: string) => num(lines.find(l => l.startsWith(`${key}:`))?.split(/\s+/)[1])
  const total = kb('MemTotal')
  const available = kb('MemAvailable')
  if (!load || total === undefined || available === undefined) return undefined
  return { load: Number(load[1]), memUsed: (total - available) * 1024, memLimit: total * 1024 }
}

// The output of `cat` over one entry of LIMIT_FILES. cgroup v2's cpu.max reads "<quota> <period>"
// or "max <period>"; v1 has the two in separate files, -1 for no quota.
export function parseLimits(layout: number, out: string): Limits {
  const lines = out.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('cat: '))
  const memTotalKb = num(lines.find(l => l.startsWith('MemTotal:'))?.split(/\s+/)[1])
  let cpus: number | undefined
  if (layout === 0) {
    const m = /^(\d+) (\d+)$/.exec(lines.find(l => /^(max|\d+) \d+$/.test(l)) ?? '')
    if (m) cpus = Number(m[1]) / Number(m[2])
  } else {
    const [quota, period] = lines.filter(l => /^-?\d+$/.test(l)).map(Number)
    if (quota !== undefined && period && quota > 0) cpus = quota / period
  }
  return { cpus, memTotal: memTotalKb === undefined ? undefined : memTotalKb * 1024 }
}

// `modal container logs <id>` prints the container's last 100 entries and exits.
export async function fetchModalLogs(io: Io, prev: Logs): Promise<Logs> {
  const t = targetOf(prev)
  try {
    const { exitCode, stdout, stderr } = await io.run(['modal', 'container', 'logs', t.container_id], {
      timeoutMs: LOGS_TIMEOUT_MS,
    })
    const lines = exitCode === 0 ? stdout.split('\n').filter(l => l.trim()) : prev.lines
    const error = exitCode === 0 ? undefined : cliError(stderr, exitCode)
    return { ...t, lines, error, checkedAt: await io.now() }
  } catch (err) {
    return { ...t, lines: prev.lines, error: message(err), checkedAt: await io.now() }
  }
}

// GPUs from `nvidia-smi`; CPU and RAM from `cat` over the first file layout the container has.
// The exec now and then returns before the output arrives: an empty answer keeps the last
// figures and is tried again next time.
export async function fetchModalMetrics(io: Io, prev: Metrics): Promise<Metrics> {
  const t = targetOf(prev)
  const exec = (cmd: readonly string[]) =>
    io.run(['modal', 'container', 'exec', '--no-pty', t.container_id, ...cmd], { timeoutMs: EXEC_TIMEOUT_MS })
  const next: Metrics = { ...t, layout: prev.layout, sample: prev.sample, limits: prev.limits }

  // Once per container; an empty answer is tried again next time.
  const readLimits = async (layout: number, cm: CpuMem) => {
    if (next.limits) return
    if (layout >= LIMIT_FILES.length) {
      next.limits = { memTotal: cm.memLimit } // /proc: the limit read is MemTotal itself
      return
    }
    const r = await exec(['cat', ...LIMIT_FILES[layout]!])
    if (r.exitCode === 0 && r.stdout.trim()) next.limits = parseLimits(layout, r.stdout)
  }

  const readCpuMem = async () => {
    for (let layout = prev.layout ?? 0; layout < CPU_MEM_FILES.length; layout++) {
      const r = await exec(['cat', ...CPU_MEM_FILES[layout]!])
      if (r.exitCode !== 0) throw new Error(cliError(r.stderr, r.exitCode))
      if (!r.stdout.trim()) {
        const { cores, load, memUsed, memLimit } = prev
        Object.assign(next, { cores, load, memUsed, memLimit })
        if (memUsed === undefined) next.cpuMemNote = 'no answer yet'
        return
      }
      const cm = parseCpuMem(layout, r.stdout)
      if (!cm) continue
      next.layout = layout
      const at = await io.now()
      if (cm.usageNs !== undefined) {
        if (prev.sample && at > prev.sample.at) next.cores = (cm.usageNs - prev.sample.usageNs) / ((at - prev.sample.at) * 1e6)
        next.sample = { usageNs: cm.usageNs, at }
      }
      next.load = cm.load
      next.memUsed = cm.memUsed
      next.memLimit = cm.memLimit
      await readLimits(layout, cm)
      return
    }
    next.cpuMemNote = 'no cgroup or /proc files to read'
  }

  const [gpu, cpuMem] = await Promise.allSettled([exec(['nvidia-smi']), readCpuMem()])
  if (gpu.status === 'rejected') next.error = message(gpu.reason)
  else if (gpu.value.exitCode !== 0) next.error = cliError(gpu.value.stderr, gpu.value.exitCode)
  else if (hasNoNvidiaSmi(gpu.value.stdout)) next.gpuNote = 'no GPU'
  else if (!gpu.value.stdout.trim()) {
    next.gpus = prev.gpus
    next.gpuNote = prev.gpus ? undefined : (prev.gpuNote ?? 'GPU: no answer yet')
  } else {
    next.gpus = parseNvidiaSmi(gpu.value.stdout)
    if (!next.gpus) next.gpuNote = gpu.value.stdout.trim().split('\n')[0]
  }
  if (cpuMem.status === 'rejected') next.error ??= message(cpuMem.reason)
  next.checkedAt = await io.now()
  return next
}
