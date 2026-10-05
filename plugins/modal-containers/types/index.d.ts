export type Container = {
  container_id: string
  started_at: number // epoch seconds; 0 while pending
}

export type App = {
  app_id: string
  app_name: string
  created_by?: string // absent when only the plain CLI answered
  containers: Container[]
}

export type Snapshot = {
  apps: App[]
  me?: string
  env?: string
  error?: string // nothing could be listed
  degraded?: string // the helper failed; containers came from the plain CLI, without creators
  checkedAt?: number
}

export type Costs = {
  byApp: Record<string, number>
  error?: string
  checkedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'modal-containers': { snapshot: Snapshot; costs: Costs; mineOnly: boolean }
  }
}
