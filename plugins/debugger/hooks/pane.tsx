// The pane is one list of events, newest first. An event opens in place to its fields
// (inputs while it is held) and to the conversation the model had before it.
import type { ElementTable } from 'claude-code'

import type { DebugEvent, DebugSettings, Hold, Kind, Usage } from '../types'
import { BREAK_KINDS, EFFORTS, KINDS, KIND_LABEL, LIST_STEP, clean, clip, dbg, flip, seconds, tokens } from './state'
import type { Control, Tab } from './state'

const CONTEXT_MAX = 300
const LINE_CHARS = 400
const LONG_VALUE = 60
const MAX_LINES = 40
const VALUE_CHARS = 3000
const TABS: Tab[] = ['events', 'breakpoints']

type UI = ElementTable

// What the buttons do; register.tsx binds these to `$`.
export type Controls = {
  hasFields: boolean // false where the surface draws no Input or Select (mobile)
  act: (what: Control) => void
  set: (change: (s: DebugSettings) => DebugSettings) => void
  redraw: () => void
  loadTools: () => void
  refresh: () => Promise<void> // reads the conversation again
}
type Field = [label: string, value: string]

const shown = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))
const usageText = (usage: Usage) => (usage ? `${usage.input_tokens ?? '?'} in · ${usage.output_tokens ?? '?'} out` : 'none reported')
const check = (isOn: boolean, label: string) => `${isOn ? '[x]' : '[ ]'} ${label}`
const plural = (kind: Kind) => `${KIND_LABEL[kind]}s`
const isArmed = (s: DebugSettings) => s.breaks.includes('tool') || s.breaks.includes('result')

/** Picking tools means stopping on them: with neither tool event checked, "tool call" is checked too. */
const armTools = (s: DebugSettings): DebugSettings => (isArmed(s) ? s : { ...s, breaks: [...s.breaks, 'tool'] })

function toolSummary(s: DebugSettings) {
  const on = s.tools.filter(name => !s.toolsOff.includes(name))
  const total = s.tools.length + 1
  const count = on.length + (s.otherTools ? 1 : 0)
  if (count === total) return 'all tools'
  if (count === 0) return 'no tools'
  return on.length <= 3 && !s.otherTools ? on.join(', ') : `${count} of ${total} tools`
}

function filterSummary(s: DebugSettings, hasAgents: boolean) {
  const on = KINDS.filter(kind => !s.hidden.includes(kind))
  const kinds =
    on.length === KINDS.length ? 'all events' : on.length === 0 ? 'no events' : on.length <= 2 ? on.map(plural).join(', ') : `${on.length} of ${KINDS.length} kinds`
  return hasAgents && s.hideAgents ? `${kinds}, no subagents` : kinds
}

/** How many a row would show given the other checks, against how many there are. */
const ofTotal = (shown: number, total: number) => (shown === total ? `${total}` : `${shown} of ${total}`)

function allNoneRow(t: UI, prefix: string, onAll: () => void, onNone: () => void) {
  const { Box, Button } = t
  return (
    <Box flexDirection="row" gap={3} marginLeft={2}>
      <Button key={`${prefix}-all`} plain onPress={onAll}>Select all</Button>
      <Button key={`${prefix}-none`} plain onPress={onNone}>Deselect all</Button>
    </Box>
  )
}

function rowOf(t: UI, key: string, label: string, onPress: () => void, indent = 0) {
  const { Box, Button } = t
  return (
    <Box flexDirection="row" marginLeft={indent}>
      <Button key={key} plain onPress={onPress}>{label}</Button>
    </Box>
  )
}

function statusLine(s: DebugSettings) {
  const h = dbg.holds[0]
  if (h) {
    const queued = dbg.holds.length > 1 ? ` (+${dbg.holds.length - 1} waiting)` : ''
    const why = h.ev.why === 'stepping' ? 'stepping: every event stops until you press Continue or the turn ends' : 'breakpoint'
    return `⏸ PAUSED at ${KIND_LABEL[h.ev.kind]} (${why}) · ${clip(h.ev.label, 50)}${queued}`
  }
  const armed =
    dbg.mode === 'step'
      ? 'stepping: stops at every event until you press Play or the turn ends'
      : s.breaks.length > 0
        ? `breakpoints: ${s.breaks.map(kind => KIND_LABEL[kind]).join(', ')}${isArmed(s) ? ` · ${toolSummary(s)}` : ''}`
        : 'no breakpoints'
  return `${dbg.turnId !== null ? '● RUNNING' : '○ IDLE'} · ${armed}`
}

export function drawPane(t: UI, s: DebugSettings, io: Controls) {
  const { Box, Text, Button } = t
  const press = (what: Control) => () => io.act(what)
  const isPaused = dbg.holds.length > 0
  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Text bold color={isPaused ? 'yellow' : dbg.turnId !== null ? 'green' : undefined} wrap="truncate-end">
        {statusLine(s)}
      </Text>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="pause" hotkey="p" onPress={press('pause')}>⏸ Pause</Button>
        <Button key="step" hotkey="s" onPress={press('step')}>⏭ Step</Button>
        <Button key="stop" hotkey="x" onPress={press('stop')}>⏹ Stop</Button>
        <Button key="play" hotkey="c" variant={isPaused ? 'primary' : 'secondary'} onPress={press('play')}>
          {isPaused ? '▶ Continue' : '▶ Play'}
        </Button>
      </Box>
      <Box flexDirection="row" gap={1}>
        {TABS.map(name => (
          <Button
            key={`tab:${name}`}
            variant={name === dbg.tab ? 'primary' : 'secondary'}
            onPress={() => {
              dbg.tab = name
              if (name === 'breakpoints') io.loadTools()
              io.redraw()
            }}
          >
            {name}
          </Button>
        ))}
      </Box>
      {dbg.note !== '' && <Text color="cyan" wrap="wrap">{clean(dbg.note)}</Text>}
      {dbg.tab === 'breakpoints' ? drawBreakpoints(t, s, io) : drawEvents(t, s, io)}
    </Box>
  )
}

export function drawBand(t: UI, io: Controls) {
  const { Box, Text, Button } = t
  const press = (what: Control) => () => io.act(what)
  const ev = dbg.holds[0]!.ev
  return (
    <Box flexDirection="row" gap={1} paddingX={1}>
      <Text bold color="yellow" wrap="truncate-end">{`⏸ ${KIND_LABEL[ev.kind]} · ${clip(ev.label, 50)}`}</Text>
      <Button key="band-step" plain onPress={press('step')}>Step</Button>
      <Button key="band-stop" plain onPress={press('stop')}>Stop</Button>
      <Button key="band-play" plain onPress={press('play')}>Continue</Button>
    </Box>
  )
}

/** The events the filter lets through, newest first, so the one being held is at the top; each opens in place. */
function drawEvents(t: UI, s: DebugSettings, io: Controls) {
  const { Box, Text, Button } = t
  if (dbg.events.length === 0) {
    return <Text dimColor wrap="wrap">No events yet. Press Pause to stop at the next event, or set breakpoints, then send a prompt.</Text>
  }
  const kindShown = (ev: DebugEvent) => !s.hidden.includes(ev.kind)
  const agentShown = (ev: DebugEvent) => !(s.hideAgents && ev.agentId !== undefined)
  // Each row counts what checking it shows under the other checks, so a row whose events
  // another check hides reads "0 of n" rather than promising events that will not appear.
  const ofKind = (kind: Kind) => dbg.events.filter(ev => ev.kind === kind)
  const count = (kind: Kind) => ofTotal(ofKind(kind).filter(agentShown).length, ofKind(kind).length)
  const ofAgents = dbg.events.filter(ev => ev.agentId !== undefined)
  const agents = ofTotal(ofAgents.filter(kindShown).length, ofAgents.length)
  // A held event shows whatever the filter says: it is what the controls act on.
  const passing = dbg.events.filter(ev => ev.status === 'paused' || (kindShown(ev) && agentShown(ev)))
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        {rowOf(t, 'filter', `${dbg.filterOpen ? '▾' : '▸'} show: ${filterSummary(s, ofAgents.length > 0)}`, () => ((dbg.filterOpen = !dbg.filterOpen), io.redraw()))}
        {dbg.filterOpen && [
          allNoneRow(
            t,
            'filter',
            () => io.set(x => ({ ...x, hidden: [], hideAgents: false })),
            () => io.set(x => ({ ...x, hidden: [...KINDS], hideAgents: true })),
          ),
          ...KINDS.map(kind =>
            rowOf(t, `filter:${kind}`, check(!s.hidden.includes(kind), `${plural(kind)} ${count(kind)}`), () => io.set(x => ({ ...x, hidden: flip(x.hidden, kind) })), 2),
          ),
          ofAgents.length > 0 && rowOf(t, 'filter:agents', check(!s.hideAgents, `subagents ${agents}`), () => io.set(x => ({ ...x, hideAgents: !x.hideAgents })), 2),
        ]}
      </Box>
      {passing.length === 0 && <Text dimColor>{`All ${dbg.events.length} events are filtered out.`}</Text>}
      {passing.slice(-dbg.listShown).reverse().map(ev => drawEvent(t, ev, io))}
      {passing.length > dbg.listShown && (
        <Button key="older" plain dimColor onPress={() => ((dbg.listShown += LIST_STEP), io.redraw())}>
          {`Show ${Math.min(LIST_STEP, passing.length - dbg.listShown)} older events`}
        </Button>
      )}
    </Box>
  )
}

function wasEdited(ev: DebugEvent) {
  return Object.keys(ev.detail).some(key => key.startsWith('edited') || key === 'sentModel')
}

function drawEvent(t: UI, ev: DebugEvent, io: Controls) {
  const { Box, Button } = t
  const isOpen = ev.id === dbg.expandedId
  const mark = ev.status === 'paused' ? '⏸ ' : ev.status === 'skip' ? '⤫ ' : wasEdited(ev) ? '✎ ' : ''
  return (
    <Box flexDirection="column">
      <Button
        key={`ev-${ev.id}`}
        plain
        dimColor={!isOpen && ev.status !== 'paused'}
        onPress={() => {
          dbg.expandedId = isOpen ? null : ev.id
          dbg.ctxOpen = false
          io.redraw()
        }}
      >
        {clip(`${isOpen ? '▾' : '▸'} #${ev.id} ${mark}${KIND_LABEL[ev.kind]}${ev.agentId ? ' (agent)' : ''} · ${ev.label}`, 110)}
      </Button>
      {isOpen && drawOpenEvent(t, ev, io)}
    </Box>
  )
}

/** An open event: its fields (inputs while it is held), then the conversation the model had before it. */
function drawOpenEvent(t: UI, ev: DebugEvent, io: Controls) {
  const { Box, Text, Button } = t
  const held = dbg.holds.find(one => one.ev === ev)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={held ? 'yellow' : undefined} paddingX={1} marginLeft={2} marginBottom={1}>
      {held ? drawEditors(t, held, io) : fieldsOf(ev).map(f => field(t, f))}
      {ev.ctx === null ? (
        <Text dimColor wrap="wrap">
          {ev.agentId ? "Context is not tracked for a subagent's events." : 'The conversation was compacted after this event, so its context is gone.'}
        </Text>
      ) : (
        <Box flexDirection="row" marginTop={1}>
          <Button
            key="ctx-toggle"
            plain
            onPress={async () => {
              dbg.ctxOpen = !dbg.ctxOpen
              await io.refresh()
              io.redraw()
            }}
          >
            {`${dbg.ctxOpen ? '▾' : '▸'} context before (${Math.max(0, ev.ctx - dbg.liveStart)} messages)`}
          </Button>
        </Box>
      )}
      {ev.ctx !== null && dbg.ctxOpen && drawTranscript(t, ev.ctx)}
    </Box>
  )
}

/** The live conversation up to `end` as the model reads it, as text. */
function drawTranscript(t: UI, end: number) {
  const { Box, Text } = t
  const last = Math.min(end, dbg.messages.length)
  const first = Math.max(dbg.liveStart, last - CONTEXT_MAX)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor wrap="wrap">
        {`The ${Math.max(0, last - dbg.liveStart)} messages the model has at this point, oldest first (the system prompt and tool definitions are not shown).${first > dbg.liveStart ? ` Showing the last ${CONTEXT_MAX}.` : ''}`}
      </Text>
      {dbg.messages.slice(first, last).map((m, at) => (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={m.role === 'user' ? 'cyan' : 'magenta'}>{`#${first + at - dbg.liveStart} ${m.role.toUpperCase()}`}</Text>
          {m.text !== '' && <Text wrap="wrap">{clean(m.text).slice(0, VALUE_CHARS)}</Text>}
          {m.tools.map(use => (
            <Text dimColor wrap="wrap">{`→ calls ${use.tool} ${clip(shown(use.input), LINE_CHARS)}`}</Text>
          ))}
          {m.results.map(one => (
            <Text dimColor wrap="wrap">{`← tool ${one.isError ? 'error' : 'result'}: ${clip(one.text, LINE_CHARS)}`}</Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

function field(t: UI, [label, value]: Field) {
  const { Text } = t
  return (
    <Text wrap="wrap">
      <Text dimColor>{`${label}  `}</Text>
      {clean(value).slice(0, VALUE_CHARS) || '(empty)'}
    </Text>
  )
}

/** An event's fields as text, once it is no longer held. */
function fieldsOf(ev: DebugEvent): Field[] {
  const calls = (uses: readonly { name: string; input: unknown }[]) => uses.map((use): Field => ['calls', `${use.name} ${shown(use.input)}`])
  const when = (value: unknown, label: string, text: () => string): Field[] => (value === undefined ? [] : [[label, text()]])
  switch (ev.kind) {
    case 'prompt': {
      const d = ev.detail
      return [['prompt', d.text], ...when(d.editedText, 'sent as', () => d.editedText!)]
    }
    case 'request': {
      const d = ev.detail
      return [
        ['model', d.sentModel ?? d.model],
        ['effort', shown(d.sentEffort ?? d.effort ?? 'default')],
        ['messages', String(d.messageCount)],
        ...when(d.sentModel, 'asked for', () => `${d.model} · ${shown(d.effort ?? 'default')}`),
      ]
    }
    case 'response': {
      const d = ev.detail
      return [
        ['text', d.answer || '(no text)'],
        ...calls(d.toolUses),
        ['stop', d.stopReason ?? 'none'],
        ['tokens', usageText(d.usage)],
        ...when(d.editedText, 'shown as', () => Object.values(d.editedText!).join('')),
      ]
    }
    case 'tool': {
      const d = ev.detail
      return [
        ['tool', d.tool],
        ...Object.entries(d.args).map(([key, value]): Field => [key, shown(value)]),
        ...Object.entries(d.editedArgs ?? {}).map(([key, value]): Field => [`${key} ran as`, shown(value)]),
      ]
    }
    case 'result': {
      const d = ev.detail
      return [['tool', d.tool], [d.isError ? 'error' : 'result', d.text], ...when(d.editedText, 'model read', () => d.editedText!)]
    }
    case 'turn-end': {
      const d = ev.detail
      return [['ended', d.reason], ['took', seconds(d.durationMs)], ['tokens', usageText(d.usage)]]
    }
    case 'skill': {
      const d = ev.detail
      return [['skill', d.skill], ['size', tokens(d.chars)]]
    }
    case 'source': {
      const d = ev.detail
      return [
        ['tool', d.tool],
        ...when(d.url, 'url', () => d.url!),
        ...when(d.query, 'query', () => d.query!),
        ...when(d.results, 'results', () => String(d.results)),
        ['status', d.ok ? 'ok' : 'failed'],
      ]
    }
  }
}

/** A held event's fields as inputs; each writes into the hold's `edit`, read when it continues. */
function drawEditors(t: UI, held: Hold, io: Controls) {
  const { ev, edit } = held
  const { Box, Text, Button } = t
  const skip = (
    <Box flexDirection="row">
      <Button key={`skip-${ev.id}`} onPress={() => io.act('skip')}>Skip this call</Button>
    </Box>
  )
  if (!io.hasFields || !('Input' in t)) return [...fieldsOf(ev).map(f => field(t, f)), ...(edit.kind === 'tool' ? [skip] : [])]
  const { Input, Select } = t
  // An Input is one line on every surface. A value of several lines gets a field per line, so it
  // reads and edits as a block; one too long for that is shown whole above a single field.
  const input = (key: string, label: string, value: string, write: (v: string) => void) => {
    const one = (suffix: string, text: string, fieldLabel: string | undefined, onInput: (v: string) => void) => (
      <Input key={`edit-${ev.id}-${key}${suffix}`} label={fieldLabel} value={text} submitLabel="✓" onInput={onInput} onSubmit={onInput} />
    )
    const lines = value.split('\n')
    if (lines.length > 1 && lines.length <= MAX_LINES) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{label}</Text>
          {lines.map((line, at) => one(`-${at}`, line, undefined, v => ((lines[at] = v), write(lines.join('\n')))))}
        </Box>
      )
    }
    const box = one('', value, label, write)
    return value.length > LONG_VALUE || lines.length > 1 ? <Box flexDirection="column">{[field(t, [`${label} now`, value]), box]}</Box> : box
  }
  const fixed = (...labels: string[]) => fieldsOf(ev).filter(([label]) => labels.includes(label)).map(f => field(t, f))
  switch (edit.kind) {
    case 'prompt':
      return [input('text', 'prompt', edit.text, v => (edit.text = v))]
    case 'result':
      return [...fixed('tool'), input('text', 'result', edit.text, v => (edit.text = v))]
    case 'request':
      return [
        input('model', 'model', edit.model, v => (edit.model = v)),
        <Select
          key={`edit-${ev.id}-effort`}
          label="effort"
          value={edit.effort}
          options={[{ value: '', label: 'default' }, ...EFFORTS.map(value => ({ value }))]}
          onSelect={(v: string) => (edit.effort = v)}
        />,
        ...fixed('messages'),
      ]
    case 'response':
      return [
        ...Object.entries(edit.texts).map(([index, text]) => input(`text-${index}`, 'text', text, v => (edit.texts[index] = v))),
        ...fixed('calls', 'stop'),
      ]
    case 'tool':
      return [
        ...fixed('tool'),
        ...Object.entries(edit.args).map(([key, text]) => input(`arg-${key}`, key, text, v => (edit.args[key] = v))),
        skip,
      ]
    case 'turn-end':
      return fieldsOf(ev).map(f => field(t, f))
  }
  return fieldsOf(ev).map(f => field(t, f)) // the observed kinds are never held
}

function drawBreakpoints(t: UI, s: DebugSettings, io: Controls) {
  const { Box, Text } = t
  const row = (key: string, label: string, onPress: () => void, indent = 0) => rowOf(t, key, label, onPress, indent)
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor wrap="wrap">
        Play runs until a checked event. Pause and Step stop at every event of the current turn, checked or not; when the turn ends, only the checked events stop again.
      </Text>
      <Box flexDirection="column">
        {BREAK_KINDS.map(kind => row(`bp-${kind}`, check(s.breaks.includes(kind), KIND_LABEL[kind]), () => io.set(x => ({ ...x, breaks: flip(x.breaks, kind) }))))}
      </Box>
      <Box flexDirection="column">
        {row(
          'bp-tools',
          `${dbg.toolsOpen ? '▾' : '▸'} tool call and tool result stop on: ${toolSummary(s)}${isArmed(s) ? '' : ' (neither is checked above)'}`,
          () => ((dbg.toolsOpen = !dbg.toolsOpen), io.redraw()),
        )}
        {dbg.toolsOpen && [
          allNoneRow(
            t,
            'bp-tools',
            () => io.set(x => armTools({ ...x, toolsOff: [], otherTools: true })),
            () => io.set(x => ({ ...x, toolsOff: x.tools, otherTools: false })),
          ),
          ...s.tools.map(name =>
            row(
              `bp-tool-${name}`,
              check(!s.toolsOff.includes(name), name),
              () => io.set(x => (x.toolsOff.includes(name) ? armTools({ ...x, toolsOff: flip(x.toolsOff, name) }) : { ...x, toolsOff: [...x.toolsOff, name] })),
              2,
            ),
          ),
          row(
            'bp-tools-other',
            check(s.otherTools, 'other tools (MCP and unlisted)'),
            () => io.set(x => (x.otherTools ? { ...x, otherTools: false } : armTools({ ...x, otherTools: true }))),
            2,
          ),
        ]}
      </Box>
      {row('bp-agents', check(s.includeAgents, 'also pause inside subagents'), () => io.set(x => ({ ...x, includeAgents: !x.includeAgents })))}
    </Box>
  )
}
