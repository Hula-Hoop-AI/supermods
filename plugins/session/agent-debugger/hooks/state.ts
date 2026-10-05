// The debugger's events and holds, and what the pane has open. Module state: a hold is a live
// hook waiting on its `decision`, so none of it outlives a reload. Breakpoints and the filter do,
// in the `settings` atom of register.tsx.
import type { DebugEvent, DebugSettings, Details, EventOf, Hold, Kind } from '../types'

const MAX_EVENTS = 300
export const LIST_STEP = 40

export const KINDS: Kind[] = ['prompt', 'request', 'response', 'tool', 'result', 'turn-end']
export const KIND_LABEL: Record<Kind, string> = {
  prompt: 'prompt',
  request: 'model request',
  response: 'model response',
  tool: 'tool call',
  result: 'tool result',
  'turn-end': 'turn end',
}
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const CONTROLS = ['play', 'pause', 'step', 'stop'] as const
export type Control = (typeof CONTROLS)[number] | 'skip'
export type Tab = 'events' | 'breakpoints'

type Message = {
  role: 'user' | 'assistant'
  text: string
  tools: { tool: string; input: unknown }[]
  results: { text: string; isError?: boolean }[]
}

export const dbg = {
  // "play" runs to the next breakpoint; "step" pauses at every pause point.
  mode: 'play' as 'play' | 'step',
  events: [] as DebugEvent[],
  seq: 0,
  // Holds in the order they began; the pane acts on the first.
  holds: [] as Hold[],
  turnId: null as string | null,
  messages: [] as Message[],
  // $.session.messages() is the whole transcript, compactions included; the model reads only
  // what follows the last one, from this row.
  liveStart: 0,
  note: '',
  tab: 'events' as Tab,
  listShown: LIST_STEP,
  expandedId: null as number | null,
  ctxOpen: false,
  toolsOpen: false,
}

/** Text an element may hold: tab and newline are the only control characters allowed. */
export function clean(text: unknown) {
  return String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

export function clip(text: unknown, max: number) {
  const flat = clean(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`

export const flip = <T>(list: T[], item: T) => (list.includes(item) ? list.filter(x => x !== item) : [...list, item])

export function record<K extends Kind>(kind: K, label: string, detail: Details[K], agentId?: string): EventOf<K> {
  dbg.seq += 1
  const ev: EventOf<K> = {
    id: dbg.seq,
    kind,
    label: clean(label),
    detail,
    agentId,
    status: '',
    ctx: agentId === undefined ? dbg.messages.length : null,
  }
  dbg.events = [...dbg.events, ev as DebugEvent].slice(-MAX_EVENTS)
  return ev
}

export const isStopped = (h: Hold) => h.decision === 'stop' || h.decision === 'aborted'

export function pauses(s: DebugSettings, kind: Kind, agentId?: string, tool?: string) {
  if (agentId !== undefined && !s.includeAgents) return false
  if (dbg.mode === 'step') return true
  if (!s.breaks.includes(kind)) return false
  if (tool === undefined) return true
  return s.tools.includes(tool) ? !s.toolsOff.includes(tool) : s.otherTools
}
