export type Source = {
  url: string // normalized: no fragment, no tracking params
  domain: string // host without a leading www.
  title?: string
  fetches: number // times a fetch tool asked for it
  failures: number // of those, how many failed (error, denied, HTTP >= 400)
  seen: number // times it came back as a search result
  queries: string[] // the searches that surfaced it
  firstTurn: number
  lastTurn: number
  lastAt: number // epoch ms
}

export type Search = {
  query: string
  results: number
  ok: boolean
  turn: number
  at: number
}

export type Ledger = {
  sources: Source[]
  searches: Search[]
}

export type View = 'session' | 'project'

declare module 'claude-code' {
  interface PluginState {
    sources: { ledger: Ledger; view: View }
  }
}
