import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ledger, Source, View } from '../../types'
import type { Row } from '../tab-pane'
import {
  EMPTY, asLedger, citable, formatCitations, isFailed, isFetched, label, observe, plural, record, summary,
} from './ledger'
import type { CitationFormat, Observation } from './ledger'
import type { TabModel } from './tab'

const BUILTIN_TOOLS = ['WebFetch', 'WebSearch']
const MAX_SESSION_SOURCES = 500
const MAX_PROJECT_SOURCES = 300 // the store is one JSON file shared by every project, capped at 4 MiB
const ledger = atom({ plugin: 'trace', key: 'ledger' } as const, EMPTY)

// The plugin's settings; a change there reloads the module, which reads them again.
let format: CitationFormat = 'markdown'
let citeSearchResults = false
let projectHistory = false
let urlArg = 'url'
let tools = BUILTIN_TOOLS

// Parallel tool calls each read-modify-write the store; run those one at a time.
let storeQueue: Promise<void> = Promise.resolve()

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const historyKey = (root: string) => `sources:${root}`

async function save($: EngineInterface, obs: Observation) {
  const turn = await $.session.turns()
  const at = Date.now()
  await update($, ledger, l => record(l, obs, turn, at, MAX_SESSION_SOURCES))
  if (!projectHistory) return
  const write = storeQueue.then(async () => {
    const key = historyKey(await $.session.root())
    await $.store.set(key, record(asLedger(await $.store.get(key)), obs, turn, at, MAX_PROJECT_SOURCES))
  })
  storeQueue = write.catch(() => {})
  await write
}

// The text Insert citations writes, or why there is none.
export function citations(shown: Ledger): { text: string } | { none: string } {
  const list = citable(shown, citeSearchResults)
  if (list.length) return { text: formatCitations(list, format) }
  return { none: citeSearchResults ? 'trace: nothing to cite yet' : 'trace: no pages fetched yet to cite' }
}

export const recordSources: Register = (on, options) => {
  format = options.sources_citation_format === 'numbered' ? 'numbered' : 'markdown'
  citeSearchResults = options.sources_cite_search_results === true
  projectHistory = options.sources_project_history === true
  urlArg = String(options.sources_url_arg ?? '').trim() || 'url'
  const extraTools = String(options.sources_extra_tools ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
  tools = [...new Set([...BUILTIN_TOOLS, ...extraTools])]
  // A RegExp matcher, since the extra tool names are only known from config.
  const toolMatcher = new RegExp(`^(?:${tools.map(escapeRegExp).join('|')})$`)

  on('tool.call', { tool: toolMatcher }, async ($, e, next) => {
    const out = await next(e)
    try {
      const obs = observe(e.tool, { ...e }, out, urlArg)
      if (obs) await save($, obs)
    } catch (err) {
      $.ui.toast(`trace: could not record ${e.tool} (${message(err)})`)
    }
    return out
  })
}

const byCount = (count: (s: Source) => number) => (a: Source, b: Source) =>
  count(b) - count(a) || b.lastAt - a.lastAt

const sourceRow = (group: 'fetched' | 'seen', count: number, s: Source): Row => ({
  id: `${group}:${s.url}`,
  state: group === 'seen' ? 'idle' : isFailed(s) ? 'error' : 'ok',
  label: group,
  title: `${count}× ${s.domain}`,
  tags: [
    { text: s.title ?? label(s).slice(s.domain.length), dimColor: true },
    ...(isFailed(s) ? [{ text: 'failed', color: 'red' }] : []),
  ],
  link: s.url,
  copyText: s.url,
})

// Placed, the pane shows the list; where none can open (a -p run, an SDK host) the answer carries it.
export function sourcesReport(current: Ledger, isPlaced: boolean) {
  if (isPlaced) return `${summary(current)}.`
  const all = citable(current, true)
  return all.length ? `${summary(current)}\n${formatCitations(all, format)}` : 'No web sources consulted yet.'
}

export const shownView = (v: View): View => (projectHistory ? v : 'session')

type Presses = { insert: () => void; clear: () => void; toggleView: () => void }

export function sourcesModel(shown: Ledger, current: View, since: number, on: Presses): TabModel {
  const fetched = shown.sources.filter(isFetched).sort(byCount(s => s.fetches))
  const seen = shown.sources.filter(s => !isFetched(s)).sort(byCount(s => s.seen))
  return {
    summary: summary(shown),
    context: current === 'project' ? 'this project, all sessions' : 'this session',
    actions: [
      { key: 'insert', label: 'Insert citations', isActive: true, onPress: on.insert },
      { key: 'clear', label: 'Clear', onPress: on.clear },
      ...(projectHistory
        ? [{ key: 'view', label: current === 'project' ? 'Show this session' : 'Show project history', onPress: on.toggleView }]
        : []),
    ],
    checkedAt: Math.max(since, ...shown.sources.map(s => s.lastAt), ...shown.searches.map(q => q.at)),
    empty: `No web sources yet. ${tools.join(', ')} calls show up here.`,
    rows: [
      ...fetched.map(s => sourceRow('fetched', s.fetches, s)),
      ...seen.map(s => sourceRow('seen', s.seen, s)),
      ...shown.searches.toReversed().map((q, i): Row => ({
        id: `search:${i}`,
        state: q.ok ? 'idle' : 'error',
        label: 'search',
        title: `“${q.query}”`,
        tags: [
          { text: `→ ${plural(q.results, 'result')}`, dimColor: true },
          ...(q.ok ? [] : [{ text: 'failed', color: 'red' }]),
        ],
      })),
    ],
  }
}
