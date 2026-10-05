export type ProviderId = 'github' | 'linear' | 'jira' | 'monday'

export type Issue = {
  key: string // ENG-123, owner/repo#12, PROJ-7, monday item id
  title: string
  url: string
  status?: string
  priority?: string
  updatedAt?: string // ISO 8601
  context?: string // repo or board, when the key does not already say it
}

export type ProviderResult = {
  provider: ProviderId
  issues: Issue[]
  error?: string // the fetch failed; shown in red
  notConfigured?: string // credentials or CLI missing; shown dim, with how to fix it
}

export type Snapshot = {
  results: ProviderResult[]
  checkedAt?: number
  isRefreshing?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'my-issues': { snapshot: Snapshot }
  }
}
