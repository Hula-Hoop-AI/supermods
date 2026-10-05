export type ProviderId = 'docker' | 'modal' | 'render' | 'vercel'

// A tab-pane Row (hooks/tab-pane.tsx; the contract cannot import it), plus what a provider's
// own filter and summary read: `owner` and `count` (Modal: who launched the app, how many
// containers it runs).
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
  owner?: string
  count?: number
}

export type DeployState = 'building' | 'ready' | 'error' | 'canceled'

export type Deploy = {
  id: string
  name: string // the service or project
  group?: string // what a partial refresh re-fetches together (Render: the service id)
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

// What a provider keeps between its own refreshes.
export type Carry = {
  services?: Service[] // Render: as of the last full refresh
  deploys?: Deploy[]
  fullAt?: number
  costs?: Record<string, number> // Modal: dollars by app id
  costsAt?: number
  costError?: string
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

declare module 'claude-code' {
  interface PluginState {
    observe: {
      tab: ProviderId | ''
      snapshots: Partial<Record<ProviderId, Snapshot>>
      toggles: Record<string, boolean> // by `<provider>.<key>`
      // ids of current-branch rows seen busy, for the finish toast
      watching: Partial<Record<ProviderId, string[]>>
    }
  }
}
