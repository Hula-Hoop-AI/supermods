import { atom, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { InvokedBy, Trace, TraceEntry } from '../../types'
import { plural } from './ledger'
import type { TabModel } from './tab'

const ARGS_MAX = 80
const DEFAULT_MAX_ENTRIES = 200
const MAX_ENTRIES_CAP = 5000
const COUNTS_SHOWN = 8
export const EMPTY: Trace = { entries: [], counts: {}, total: 0 }
const BY_COLOR: Record<InvokedBy, string> = { model: 'cyan', user: 'yellow', other: 'gray' }

const trace = atom({ plugin: 'trace', key: 'skills' } as const, EMPTY)

// A skill load in flight: a Skill tool call or a typed /skill, already recorded as `seq`.
// The engine expands the skill's prompt (`skill.prompt`) inside it, which adds the size.
type Pending = { skill: string; seq: number; sized: boolean }
const pending: Pending[] = []

let maxEntries = DEFAULT_MAX_ENTRIES
let showArgs = true
let statusLine = false

const bareName = (s: string) => s.replace(/^\//, '').trim()

// `superpowers:brainstorming` and `brainstorming` name the same skill.
const sameSkill = (a: string, b: string) => {
  const x = bareName(a)
  const y = bareName(b)
  return x === y || x.endsWith(`:${y}`) || y.endsWith(`:${x}`)
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function append(t: Trace, entry: TraceEntry, max: number): Trace {
  return {
    entries: [...t.entries, entry].slice(-max),
    counts: { ...t.counts, [entry.skill]: (t.counts[entry.skill] ?? 0) + 1 },
    total: t.total + 1,
  }
}

function topCounts(counts: Record<string, number>, n: number): [string, number][] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
}

const clock = (ms: number) => {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(v => String(v).padStart(2, '0')).join(':')
}

const size = (chars: number) => {
  const tok = chars / 4 // rough chars-per-token estimate
  return tok >= 1000 ? `~${(tok / 1000).toFixed(1)}k tok` : `~${Math.round(tok)} tok`
}

const fieldOf = (v: unknown, k: string): unknown =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined

// The skill as the model's skill listing has it: `plugin:<name>` or its source
// (`userSettings`, `built-in`, ...); undefined when the listing has no such skill.
async function listedSource($: EngineInterface, skill: string): Promise<string | undefined> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' }) // local estimate, no request
    const s = usage.context.breakdown?.skills?.skillFrontmatter.find(x => sameSkill(x.name, skill))
    return s && (s.pluginName ? `plugin:${s.pluginName}` : s.source)
  } catch {
    return undefined
  }
}

const prefixSource = (skill: string) => {
  const i = skill.indexOf(':')
  return i > 0 ? `plugin:${skill.slice(0, i)}` : undefined
}

// Records the load now and leaves it pending, so `skill.prompt` can add its size.
async function begin($: EngineInterface, skill: string, entry: Omit<TraceEntry, 'seq' | 'turn' | 'at'>) {
  const p: Pending = { skill, seq: await record($, entry), sized: false }
  pending.push(p)
  return p
}

const end = (p: Pending) => pending.splice(pending.indexOf(p), 1)

export const statusText = (t: Trace) => (statusLine && t.total ? `skills: ${t.total}` : undefined)

function showStatus($: EngineInterface, t: Trace) {
  if (statusLine) $.ui.status(statusText(t))
}

async function record($: EngineInterface, e: Omit<TraceEntry, 'seq' | 'turn' | 'at'>) {
  // The user's prompts so far; a typed /skill runs before its own prompt is counted.
  const n = (await $.session.turns().catch(() => 0)) + (e.by === 'user' ? 1 : 0)
  let seq = 0
  const next = await update($, trace, t => {
    seq = t.total + 1
    return append(t, { ...e, seq, turn: n, at: Date.now() }, maxEntries)
  })
  showStatus($, next)
  return seq
}

async function patch($: EngineInterface, seq: number, fields: Partial<TraceEntry>) {
  await update($, trace, t => ({
    ...t,
    entries: t.entries.map(x => (x.seq === seq ? { ...x, ...fields } : x)),
  }))
}

function outcome(r: ToolCallResult): { mode?: 'inline' | 'forked'; failed?: string } {
  if ('deny' in r && typeof r.deny === 'string') return { failed: `denied: ${r.deny}` }
  const res = r.result
  const status = fieldOf(res, 'status')
  const mode = status === 'forked' ? 'forked' : 'inline'
  if (r.isError || fieldOf(res, 'success') === false) {
    return { mode, failed: truncate(r.text ?? 'skill failed', ARGS_MAX) }
  }
  return { mode }
}

export const recordSkills: Register = (on, options) => {
  const max = Number(options.skills_max_entries)
  maxEntries = Number.isFinite(max) ? Math.min(MAX_ENTRIES_CAP, Math.max(1, Math.floor(max))) : DEFAULT_MAX_ENTRIES
  showArgs = options.skills_show_args !== false
  statusLine = options.skills_status_line === true

  const argsOf = (args: string | undefined) => (showArgs && args ? truncate(args, ARGS_MAX) : undefined)

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (e.tool !== 'Skill') return next(e)
    const skill = bareName(e.skill)
    const source = (await listedSource($, skill)) ?? prefixSource(skill)
    const p = await begin($, skill, { skill, source, by: 'model', args: argsOf(e.args) })
    try {
      const r = await next(e)
      await patch($, p.seq, outcome(r))
      return r
    } finally {
      end(p)
    }
  })

  // A typed /name is a skill when the model's skill listing names it; every other
  // command (built-ins, other mods' commands, /trace itself) passes by unrecorded.
  on('command.run', async ($, e, next) => {
    const source = await listedSource($, e.command)
    if (source === undefined) return next(e)
    const p = await begin($, e.command, { skill: e.command, source, by: 'user', args: argsOf(e.args) })
    try {
      return await next(e)
    } finally {
      end(p)
    }
  })

  // Adds the size of what the model reads to the pending load; a prompt with none
  // pending (a skill preloaded into a subagent) is recorded on its own.
  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    const p = pending.find(x => !x.sized && sameSkill(x.skill, e.skill))
    if (p) {
      p.sized = true
      await patch($, p.seq, { chars: r.text.length })
    } else {
      const source = (await listedSource($, e.skill)) ?? prefixSource(e.skill)
      await record($, { skill: e.skill, source, by: 'other', chars: r.text.length })
    }
    return r
  })
}

export const skillsReport = (t: Trace) => `${plural(t.total, 'skill load')} this session.`

export function skillsModel(t: Trace, since: number, onClear: () => void): TabModel {
  const kinds = Object.keys(t.counts).length
  const top = topCounts(t.counts, COUNTS_SHOWN).map(([name, n]) => `${name} ×${n}`)
  if (kinds > COUNTS_SHOWN) top.push(`+${kinds - COUNTS_SHOWN} more`)
  return {
    summary: plural(t.total, 'skill load'),
    context: plural(kinds, 'skill'),
    actions: [{ key: 'clear', label: 'Clear', onPress: onClear }],
    notes: top.length ? [top.join('  ')] : [],
    checkedAt: t.entries.at(-1)?.at ?? since,
    empty: 'No skills loaded yet.',
    // Newest first: the pane keeps the top rows when they overflow.
    rows: t.entries.toReversed().map(x => ({
      id: String(x.seq),
      state: x.failed ? 'error' : 'idle',
      label: `${clock(x.at)} t${x.turn}`,
      title: x.skill,
      tags: [
        { text: x.by, color: BY_COLOR[x.by] },
        ...(x.source ? [{ text: x.source, dimColor: true }] : []),
        ...(x.chars !== undefined ? [{ text: size(x.chars) }] : []),
        ...(x.mode === 'forked' ? [{ text: 'forked', color: 'magenta' }] : []),
        ...(x.failed ? [{ text: x.failed, color: 'red' }] : []),
        ...(showArgs && x.args ? [{ text: `"${x.args}"`, dimColor: true }] : []),
      ],
    })),
  }
}
