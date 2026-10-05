export type DeployState = 'building' | 'ready' | 'error' | 'canceled'

export type Service = {
  id: string
  name: string
  branch?: string
  dashboardUrl?: string
  preview: boolean // a pull-request preview of another service
}

export type Deploy = {
  id: string
  serviceId: string
  service: string
  env: string // prod or preview
  state: DeployState
  branch?: string // the service's configured branch
  sha?: string
  message?: string
  trigger?: string // what started it: new commit, manual, api, ...
  createdAt: number // epoch ms
  url?: string
}

export type Snapshot = {
  deploys: Deploy[]
  services: Service[] // as of the last full refresh
  error?: string
  note?: string
  branch?: string
  checkedAt?: number
  fullAt?: number // when the service list was last fetched
}

declare module 'claude-code' {
  interface PluginState {
    // `watching`: ids of current-branch deploys seen building, for the finish toast
    'render-deploys': { snapshot: Snapshot; watching: string[] }
  }
}
