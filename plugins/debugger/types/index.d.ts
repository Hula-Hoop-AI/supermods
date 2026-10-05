export type Kind = 'prompt' | 'request' | 'response' | 'tool' | 'result' | 'turn-end'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number

export type Usage = { input_tokens?: number; output_tokens?: number } | null

export type Decision = 'continue' | 'step' | 'skip' | 'stop' | 'aborted'

// What each kind of event keeps; the `edited*` and `sent*` fields are set when a hold changed it.
export type Details = {
  prompt: { text: string; editedText?: string }
  request: { model: string; effort?: Effort; messageCount: number; sentModel?: string; sentEffort?: Effort }
  response: {
    answer: string
    toolUses: readonly { name: string; input: unknown }[]
    stopReason: string | null
    usage: Usage
    editedText?: Record<string, string> // by text block index
  }
  tool: { tool: string; args: Record<string, unknown>; editedArgs?: Record<string, unknown> }
  result: { tool: string; isError: boolean; text: string; editedText?: string }
  'turn-end': { reason: string; durationMs: number; usage: Usage }
}

export type EventOf<K extends Kind> = {
  id: number
  kind: K
  label: string
  detail: Details[K]
  agentId?: string
  status: Decision | 'paused' | ''
  why?: 'stepping' | 'breakpoint'
  ctx: number | null // messages in the conversation when it happened; null once that context is gone
}

export type DebugEvent = { [K in Kind]: EventOf<K> }[Kind]

// A held event's fields as its inputs hold them; read back when the hold is answered.
export type Edit =
  | { kind: 'prompt' | 'result'; text: string }
  | { kind: 'request'; model: string; effort: string }
  | { kind: 'response'; texts: Record<string, string> }
  | { kind: 'tool'; args: Record<string, string> }
  | { kind: 'turn-end' }

export type Hold<E extends Edit = Edit> = { ev: DebugEvent; edit: E; decision: Decision | null }

export type DebugSettings = {
  breaks: Kind[] // the events Play stops on
  // Tool breakpoints: `tools` less `toolsOff`; `otherTools` speaks for the unlisted (MCP) ones.
  tools: string[]
  toolsOff: string[]
  otherTools: boolean
  includeAgents: boolean
  // The events list's filter: kinds not shown, and whether subagents' events are.
  hidden: Kind[]
  hideAgents: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'debugger': { settings: DebugSettings }
  }
}
