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
  entries: TraceEntry[] // chronological, bounded by maxEntries
  counts: Record<string, number> // every load this session, unbounded by maxEntries
  total: number
}

declare module 'claude-code' {
  interface PluginState {
    'skill-trace': { trace: Trace }
  }
}
