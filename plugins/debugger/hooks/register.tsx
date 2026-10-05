// Agent Debugger: a step debugger for the agent loop.
//
// Pause points (each one a breakpoint kind, and every one of them in step mode):
//   prompt    prompt.submit   before the prompt enters; the text is editable
//   request   turn.step       before a model request; model and effort are editable
//   response  turn.step       the response, buffered, before it is shown or recorded; text is editable
//   tool      tool.call       before a tool runs; arguments are editable, or the call is skipped
//   result    tool.call       after a tool ran; the text the model will read is editable
//   turn-end  turn.complete   before the turn is reported done
// Observed only (listed and filtered, never held):
//   skill     skill.prompt    a skill's instructions entering the conversation
//   source    tool.call       a WebFetch or WebSearch, once it has run
//
// Holding: a hook has 10 s of its own time, but time inside a `$` call is free, so a hold
// waits on short `$.process.run(["sleep", ...])` calls until a control sets its decision.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, ToolCallInput, TurnStepInput } from 'claude-code'

import type { BreakKind, DebugEvent, DebugSettings, Edit, Effort, EventOf, Hold } from '../types'
import { drawBand, drawPane } from './pane'
import type { Controls } from './pane'
import { CONTROLS, EFFORTS, clip, dbg, isStopped, pauses, record, seconds, tokens } from './state'
import type { Control } from './state'

const PANE = 'debugger'
const TITLE = 'Debugger'
const POLL_SECONDS = '0.2'
const HOLD_LIMIT_MS = 30 * 60 * 1000

// tool_use_id -> the text that replaces the tool's result as the model reads it.
const resultOverrides = new Map<string, string>()

// Session state, so a hot reload keeps it.
const settings = atom({ plugin: 'debugger', key: 'settings' } as const, {
  breaks: [],
  tools: [],
  toolsOff: [],
  otherTools: true,
  includeAgents: false,
  hidden: [],
  hideAgents: false,
} as DebugSettings)

// The settings as last written. A dispatch reads `$.state` as of one moment, and a hold
// outlives it: a breakpoint changed while an event is held must count for the next one.
let live: DebugSettings | undefined

const current = async ($: EngineInterface) => (live ??= await read($, settings))

async function change($: EngineInterface, fn: (s: DebugSettings) => DebugSettings) {
  try {
    live = await update($, settings, fn)
  } catch {
    live = fn(await current($)) // the setting still holds for this load
  }
}

const shouldPause = async ($: EngineInterface, kind: BreakKind, agentId?: string, tool?: string) =>
  pauses(await current($), kind, agentId, tool)

/** Holds the calling hook until a control answers; resolves the hold with its `decision` and `edit`. */
async function hold<E extends Edit>(
  $: EngineInterface,
  next: { signal: { aborted: boolean } },
  ev: DebugEvent,
  edit: E,
): Promise<Hold<E>> {
  const h: Hold<E> = { ev, edit, decision: null }
  dbg.holds.push(h)
  ev.status = 'paused'
  ev.why = dbg.mode === 'step' && ev.kind !== 'turn-end' ? 'stepping' : 'breakpoint'
  dbg.tab = 'events'
  dbg.expandedId = ev.id
  dbg.ctxOpen = false
  try {
    await refreshMessages($)
    if (ev.agentId === undefined) ev.ctx = dbg.messages.length
    await $.ui.open({ id: PANE, title: TITLE })
    $.ui.invalidate('ui.render')
    const startedAt = await $.clock.now()
    while (h.decision === null) {
      if (next.signal.aborted) h.decision = 'aborted'
      else if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) h.decision = 'continue'
      else await $.process.run(['sleep', POLL_SECONDS], { timeoutMs: 5000 })
    }
  } catch (error) {
    // Anything unexpected lets the event go on unchanged, and says so.
    h.decision ??= 'continue'
    dbg.note = `Could not pause at #${ev.id}: ${clip(error instanceof Error ? error.message : error, 160)}`
  } finally {
    dbg.holds = dbg.holds.filter(one => one !== h)
    ev.status = h.decision ?? 'continue'
    $.ui.invalidate('ui.render')
  }
  return h
}

/** The controls: what a button, the band or `/debugger <what>` does. */
async function act($: EngineInterface, what: Control) {
  const first = dbg.holds[0]
  if (what === 'play') {
    dbg.mode = 'play'
    for (const h of dbg.holds) h.decision ??= 'continue'
  } else if (what === 'pause') {
    dbg.mode = 'step'
  } else if (what === 'step') {
    dbg.mode = 'step'
    if (first) first.decision ??= 'step'
  } else if (what === 'skip') {
    if (first?.ev.kind === 'tool') first.decision ??= 'skip'
  } else {
    for (const h of dbg.holds) h.decision ??= 'stop'
    if (dbg.turnId !== null) await $.turn.abort({ turnId: dbg.turnId }).catch(() => {}) // the turn had already ended
  }
  $.ui.invalidate('ui.render')
}

async function refreshMessages($: EngineInterface) {
  try {
    dbg.messages = (await $.session.messages()).map(m => ({
      role: m.role,
      text: m.text,
      tools: m.toolUses.map(use => ({ tool: use.tool, input: use.input })),
      results: (m.toolResults ?? []).map(one => ({ text: one.text, isError: one.isError })),
    }))
  } catch {
    // keep the last read
  }
}

/** After a compaction, earlier events' context is no longer what the model reads. */
function forgetContext($: EngineInterface, liveStart: number) {
  for (const ev of dbg.events) ev.ctx = null
  dbg.liveStart = liveStart
  dbg.ctxOpen = false
  $.ui.invalidate('ui.render')
}

/** The breakpoint list's tools: the built-in ones, and any other this session has called. */
async function loadTools($: EngineInterface) {
  try {
    const listed = (await $.tool.list()).map(one => one.name).filter(name => !name.startsWith('mcp__'))
    const called = dbg.events.flatMap(ev => (ev.kind === 'tool' ? [ev.detail.tool] : []))
    const names = [...new Set([...listed, ...called])].sort()
    await change($, s => {
      // A tool newly listed keeps the answer "other tools" gave for it.
      const fresh = s.otherTools ? [] : names.filter(name => !s.tools.includes(name))
      return { ...s, tools: names, toolsOff: [...s.toolsOff, ...fresh] }
    })
  } catch {
    // keep the last list
  }
}

// What the pane's buttons do, as plain functions: the validator follows `$` only in this file.
const bind = ($: EngineInterface, surface: RenderSurface): Controls => ({
  hasFields: surface !== 'mobile',
  act: what => void act($, what),
  set: fn => void change($, fn),
  redraw: () => $.ui.invalidate('ui.render'),
  loadTools: () => void loadTools($),
  refresh: () => refreshMessages($),
})

const isControl = (s: string): s is Control => (CONTROLS as readonly string[]).includes(s)

function withStepEdits(e: TurnStepInput, edit: { model: string; effort: string }, ev: EventOf<'request'>): TurnStepInput {
  const model = edit.model.trim() || e.model
  const effort: Effort | undefined =
    edit.effort === '' ? e.effort : (EFFORTS.find(x => x === edit.effort) ?? Number(edit.effort))
  if (model === e.model && effort === e.effort) return e
  ev.detail = { ...ev.detail, sentModel: model, sentEffort: effort }
  return { ...e, model, effort }
}

/** Arguments as the fields show them: strings as they are, everything else as JSON. */
function editable(args: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]))
}

/** The arguments whose field changed, parsed back; a field that no longer parses keeps the original. */
function parsedEdits(args: Record<string, unknown>, edited: Record<string, string>) {
  const before = editable(args)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(args)) {
    const text = edited[key]
    if (text === undefined || text === before[key]) continue
    if (typeof args[key] === 'string') {
      out[key] = text
      continue
    }
    try {
      out[key] = JSON.parse(text)
    } catch {
      dbg.note = `Kept the original "${key}": the edit was not valid JSON.`
    }
  }
  return out
}

/** A web source from a WebFetch or WebSearch call, once it has run. */
function recordSource(tool: string, args: Record<string, unknown>, ran: { deny?: string; isError?: boolean; result?: unknown }, agentId?: string) {
  const ok = ran.deny === undefined && ran.isError !== true
  if (tool === 'WebSearch') {
    const query = typeof args.query === 'string' ? args.query : ''
    if (!query) return
    const results = searchHits(ran.result)
    record('source', `search “${clip(query, 50)}” → ${results} results`, { tool, query, results, ok }, agentId)
  } else {
    const url = typeof args.url === 'string' ? args.url : ''
    if (!url) return
    record('source', `fetch ${clip(url, 70)}${ok ? '' : ' failed'}`, { tool, url, ok }, agentId)
  }
}

function searchHits(result: unknown) {
  const results = result && typeof result === 'object' ? (result as { results?: unknown }).results : undefined
  if (!Array.isArray(results)) return 0
  return results.reduce<number>((n, block) => n + (Array.isArray((block as { content?: unknown })?.content) ? (block as { content: unknown[] }).content.length : 0), 0)
}

function describeResponse(result: { answer: string; toolUses: readonly { name: string }[]; stopReason: string | null }) {
  const tools = result.toolUses.map(use => use.name).join(', ')
  return [clip(result.answer, 50), tools && `→ ${tools}`, result.stopReason && `(${result.stopReason})`].filter(Boolean).join(' ') || '(empty)'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'debugger',
      description: 'Open the agent debugger, or control it: play, pause, step, stop',
      argumentHint: `[${CONTROLS.join('|')}]`,
      immediate: true,
    })
    await loadTools($)
    return next(e)
  })

  on('command.run', { command: 'debugger' }, async ($, e) => {
    const what = e.args.trim().toLowerCase()
    if (isControl(what)) {
      await act($, what)
      return { text: `Debugger: ${what}.` }
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    await refreshMessages($)
    await loadTools($)
    return {
      text: opened.isPlaced
        ? 'Debugger pane opened.'
        : `The Debugger pane is open, but this surface is not showing it: ${opened.reason}\nUse /debugger ${CONTROLS.join('|')}.`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    // Only the person's own idle prompt is a pause point; commands and deliveries pass.
    if (e.origin?.kind !== 'composer' || e.turnId !== undefined || e.text.startsWith('/')) return next(e)
    const ev = record('prompt', clip(e.text, 80), { text: e.text })
    if (!(await shouldPause($, 'prompt'))) return next(e)
    const h = await hold($, next, ev, { kind: 'prompt', text: e.text })
    if (isStopped(h)) return { drop: 'Stopped in the debugger before the prompt was sent.' }
    if (h.edit.text === e.text) return next(e)
    ev.detail = { ...ev.detail, editedText: h.edit.text }
    return next({ ...e, text: h.edit.text })
  })

  on('turn.start', ($, e, next) => {
    dbg.turnId = e.turnId
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) await refreshMessages($)
    const { model, effort, messageCount } = e
    const ev = record('request', `${model} · ${messageCount} messages`, { model, effort, messageCount }, e.agentId)
    let input: TurnStepInput = e
    if (await shouldPause($, 'request', e.agentId)) {
      const h = await hold($, next, ev, { kind: 'request', model, effort: effort === undefined ? '' : String(effort) })
      if (isStopped(h)) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
      input = withStepEdits(e, h.edit, ev)
    }

    if (!(await shouldPause($, 'response', e.agentId))) {
      const result = yield* next(input)
      record('response', describeResponse(result), result, e.agentId)
      $.ui.invalidate('ui.render')
      return result
    }

    // Buffered: nothing is shown or recorded until the hold is answered.
    const chunks = []
    const stream = next(input)
    for await (const chunk of stream) chunks.push(chunk)
    const result = await stream.result
    const texts: Record<string, string> = {}
    for (const chunk of chunks) {
      if (chunk.kind === 'text') texts[chunk.index] = (texts[chunk.index] ?? '') + chunk.text
    }
    const rev = record('response', describeResponse(result), result, e.agentId)
    const { edit } = await hold($, next, rev, { kind: 'response', texts: { ...texts } })
    const edited = Object.keys(texts).filter(index => edit.texts[index] !== texts[index])
    if (edited.length === 0) {
      yield* chunks
      return result
    }
    rev.detail = { ...rev.detail, editedText: edit.texts }
    const sent = new Set<number>()
    for (const chunk of chunks) {
      if (chunk.kind !== 'text' || !edited.includes(String(chunk.index))) {
        yield chunk
      } else if (!sent.has(chunk.index)) {
        sent.add(chunk.index)
        // An emptied block is dropped by yielding none of its chunks.
        const text = edit.texts[chunk.index]
        if (text) yield { ...chunk, text }
      }
    }
    return { ...result, answer: Object.keys(texts).map(index => edit.texts[index]).join('') }
  })

  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id: id, agentId, ...args }: ToolCallInput & Record<string, unknown> = e
    const toolName: string = tool
    const ev = record('tool', `${tool} ${clip(JSON.stringify(args), 60)}`, { tool, args }, agentId)
    let input = e
    if (await shouldPause($, 'tool', agentId, tool)) {
      const h = await hold($, next, ev, { kind: 'tool', args: editable(args) })
      if (isStopped(h)) return { deny: 'The user stopped this turn in the debugger before the call ran. Do not retry it unless asked.' }
      if (h.decision === 'skip') return { deny: 'The user skipped this tool call in the debugger. Do not retry it unless asked.' }
      const changed = parsedEdits(args, h.edit.args)
      if (Object.keys(changed).length > 0) {
        ev.detail = { ...ev.detail, editedArgs: changed }
        input = { ...e, ...changed }
      }
    }

    const ran = await next(input)
    const text = ran.deny !== undefined ? `denied: ${ran.deny}` : (ran.text ?? '')
    const isError = ran.isError === true
    const rev = record('result', `${tool} ${isError ? 'error ' : ''}${clip(text, 60)}`, { tool, isError, text }, agentId)
    if (ran.deny === undefined && (await shouldPause($, 'result', agentId, tool))) {
      const h = await hold($, next, rev, { kind: 'result', text })
      if (h.edit.text !== text && h.decision !== 'aborted' && id !== undefined) {
        rev.detail = { ...rev.detail, editedText: h.edit.text }
        resultOverrides.set(id, h.edit.text)
      }
    }
    if (tool === 'WebFetch' || tool === 'WebSearch') recordSource(toolName, args, ran, agentId)
    $.ui.invalidate('ui.render')
    return ran
  })

  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    record('skill', `${e.skill} ${tokens(r.text.length)}`, { skill: e.skill, chars: r.text.length })
    $.ui.invalidate('ui.render')
    return r
  })

  // An edited tool result is rewritten where the row is stored, so the model reads the edit.
  on('session.append', { door: 'tool-result' }, ($, e, next) => {
    if (resultOverrides.size === 0) return next(e)
    let isChanged = false
    const content = e.message.content.map(block => {
      const id = block.type === 'tool_result' && typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
      const text = id === undefined ? undefined : resultOverrides.get(id)
      if (id === undefined || text === undefined) return block
      resultOverrides.delete(id)
      isChanged = true
      return { ...block, content: [{ type: 'text' as const, text }] }
    })
    return isChanged ? next({ ...e, message: { ...e.message, content } }) : next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const ev = record('turn-end', `${e.reason} · ${seconds(e.durationMs)}`, { reason: e.reason, durationMs: e.durationMs, usage: e.usage ?? null })
    // Stepping ends with its turn: the turn's end stops only on its own breakpoint,
    // and the next turn runs to breakpoints again.
    if (e.reason !== 'aborted' && (await current($)).breaks.includes('turn-end')) {
      await hold($, next, ev, { kind: 'turn-end' })
    }
    dbg.mode = 'play'
    dbg.turnId = null
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const rowsBefore = await $.session.messages().then(rows => rows.length, () => dbg.messages.length)
    const out = await next(e)
    if (out.skip === undefined) forgetContext($, rowsBefore)
    return out
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    drawPane($.ui.resolve(e), await read($, settings), bind($, e.surface)),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (dbg.holds.length === 0 || e.props?.hasSurvey) return next(e)
    const t = $.ui.resolve(e)
    const { Box } = t
    const below = await next(e)
    const row = drawBand(t, bind($, e.surface))
    return below ? <Box flexDirection="column">{[row, below]}</Box> : row
  })
}
