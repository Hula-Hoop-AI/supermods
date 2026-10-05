// model: the Skill tool. user: a typed /skill. other: expanded with neither, e.g. a
// skill preloaded into a subagent.
export type InvokedBy = 'model' | 'user' | 'other'

export type TraceEntry = {
  seq: number
  skill: string
  source?: string // 'plugin:<name>', 'user', 'builtin', 'mcp'; absent when unknown
  by: InvokedBy
  turn: number // the user's prompt count when it loaded
  at: number // epoch ms
  args?: string // truncated; model invocations only
  chars?: number // size of the instructions the model read; absent when none loaded
  mode?: 'inline' | 'forked'
  failed?: string // why a Skill call loaded nothing
}

export type Trace = {
  entries: TraceEntry[] // chronological, bounded by skills_max_entries
  counts: Record<string, number> // every load this session, unbounded by skills_max_entries
  total: number
}

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

export type Tab = 'skills' | 'sources'

declare module 'claude-code' {
  interface PluginState {
    trace: { tab: Tab; skills: Trace; ledger: Ledger; view: View }
  }
}
