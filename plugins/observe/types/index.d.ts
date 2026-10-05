export type ProviderId = 'docker' | 'modal' | 'render' | 'vercel'

// A tab-pane Row (hooks/tab-pane.tsx; the contract cannot import it), plus what a provider's
// own filter reads: `owner` (Modal: who launched the container's app).
export type ObserveRow = {
  id: string
  state?: 'ok' | 'busy' | 'error' | 'idle'
  label?: string
  title: string
  tags?: { text: string; color?: string; dimColor?: boolean; bold?: boolean }[]
  age?: string
  sub?: string
  link?: string
  copyText?: string
  highlight?: boolean
  actions?: { key: string; label: string }[]
  heading?: boolean
  owner?: string
}

export type DeployState = 'building' | 'ready' | 'error' | 'canceled'

export type Deploy = {
  id: string
  name: string // the service or project
  group?: string // Render: the service id, what a partial refresh re-fetches; Vercel: the project, what rows group under
  env: string // prod, preview, or a custom environment
  state: DeployState
  branch?: string
  sha?: string
  message?: string
  who?: string // who or what started it
  createdAt: number // epoch ms
  url?: string
}

export type Service = {
  id: string
  name: string
  branch?: string
  dashboardUrl?: string
  preview: boolean // a pull-request preview of another service
}

// A Vercel app's production domain as last looked up: none when it has none or the lookup failed.
export type App = { domain?: string; at: number }

// What a provider keeps between its own refreshes.
export type Carry = {
  services?: Service[] // Render: as of the last full refresh
  deploys?: Deploy[]
  fullAt?: number
  costs?: Record<string, number> // Modal: dollars by app id
  costsAt?: number
  costError?: string
  apps?: Record<string, App> // Vercel: by project id (or name)
}

export type Snapshot = {
  rows: ObserveRow[]
  context?: string // drawn dim beside the summary: the docker context, the Modal environment, the branch
  branch?: string // the current git branch, named in finish toasts
  me?: string
  unavailable?: string // nothing to reach, a normal state (no CLI, no daemon): one dim line
  error?: string
  notes?: string[]
  checkedAt?: number
  carry?: Carry
}

export type Gpu = {
  index: number
  name: string
  util?: number // %
  memUsedMiB?: number
  memTotalMiB?: number
  powerW?: number
  powerCapW?: number
  tempC?: number
}

// The container a logs or metrics pane shows: a Modal container, or a Docker one.
export type Target = {
  source: 'modal' | 'docker'
  container_id: string
  name: string // Modal: the app; Docker: the container's name
  context?: string // Docker: the --context it was listed with
}

// What a logs pane last read.
export type Logs = Target & {
  lines: string[]
  error?: string
  checkedAt?: number // undefined until the first answer
}

// What a metrics pane last read.
export type Metrics = Target & {
  gpus?: Gpu[]
  gpuNote?: string // "no GPU", or what nvidia-smi printed instead of its table
  cores?: number // CPU cores in use (Modal: since the previous sample; Docker: docker stats)
  load?: number // 1-minute load average (the /proc fallback)
  memUsed?: number // bytes
  memLimit?: number // bytes; absent when unlimited
  cpuMemNote?: string // why CPU and RAM are missing
  error?: string // the exec itself failed (container gone, CLI error)
  layout?: number // which CPU_MEM_FILES entry this container answered
  // read once per container: the CPU limit in cores (cpusHost: none set, so the host's count),
  // and the machine's memory in bytes; Docker: whether it has GPUs assigned
  limits?: { cpus?: number; cpusHost?: boolean; memTotal?: number; hasGpu?: boolean }
  io?: { net: string; block: string } // Docker: as docker stats prints them
  sample?: { usageNs: number; at: number } // the previous CPU sample
  checkedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    observe: {
      tab: ProviderId | ''
      snapshots: Partial<Record<ProviderId, Snapshot>>
      toggles: Record<string, boolean> // by `<provider>.<key>`
      // ids of current-branch rows seen busy, for the finish toast
      watching: Partial<Record<ProviderId, string[]>>
      // the container in each detail pane; null until a row's button is pressed
      logs: Logs | null
      metrics: Metrics | null
    }
  }
}
