export type DeployState = 'building' | 'ready' | 'error' | 'canceled'

export type Deploy = {
  id: string
  project: string
  env: string // prod, preview, or a custom environment
  state: DeployState
  branch?: string
  sha?: string
  message?: string
  creator?: string
  createdAt: number // epoch ms
  url?: string
}

export type Snapshot = {
  deploys: Deploy[]
  error?: string
  note?: string
  branch?: string
  checkedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    // `watching`: ids of current-branch deploys seen building, for the finish toast
    'vercel-deploys': { snapshot: Snapshot; watching: string[] }
  }
}
