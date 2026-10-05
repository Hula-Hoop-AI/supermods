import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ledger, Source, View } from '../types'
import {
  EMPTY, citable, formatCitations, isFailed, isFetched, isLedger, label, observe, plural, record, summary,
} from './ledger'
import type { CitationFormat, Observation } from './ledger'

const PANE = 'sources'
const BUILTIN_TOOLS = ['WebFetch', 'WebSearch']
const MAX_SESSION_SOURCES = 500
const MAX_PROJECT_SOURCES = 300 // the store is one JSON file shared by every project, capped at 4 MiB
const ledger = atom({ plugin: 'sources', key: 'ledger' } as const, EMPTY)
const view = atom({ plugin: 'sources', key: 'view' } as const, 'session' as View)

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

async function historyKey($: EngineInterface) {
  return `project:${await $.session.root()}`
}

async function loadHistory($: EngineInterface) {
  const saved = await $.store.get(await historyKey($))
  return isLedger(saved) ? saved : EMPTY
}

async function save($: EngineInterface, obs: Observation) {
  const turn = await $.session.turns()
  const at = Date.now()
  await update($, ledger, l => record(l, obs, turn, at, MAX_SESSION_SOURCES))
  if (!projectHistory) return
  const write = storeQueue.then(async () => {
    const key = await historyKey($)
    await $.store.set(key, record(await loadHistory($), obs, turn, at, MAX_PROJECT_SOURCES))
  })
  storeQueue = write.catch(() => {})
  await write
}

async function insertCitations($: EngineInterface, shown: Ledger) {
  const list = citable(shown, citeSearchResults)
  if (list.length === 0) {
    $.ui.toast(citeSearchResults ? 'sources: nothing to cite yet' : 'sources: no pages fetched yet to cite')
    return
  }
  const { isFilled } = await $.prompt.fill({ text: formatCitations(list, format), mode: 'insert' })
  if (!isFilled) $.ui.toast("sources: the prompt box didn't take the citations")
}

async function clear($: EngineInterface, current: View) {
  if (current === 'project') {
    await $.store.delete(await historyKey($))
    $.ui.invalidate('ui.render')
  } else {
    await update($, ledger, () => EMPTY)
  }
}

export const register: Register = (on, options) => {
  format = options.citation_format === 'numbered' ? 'numbered' : 'markdown'
  citeSearchResults = options.cite_search_results === true
  projectHistory = options.project_history === true
  urlArg = String(options.url_arg ?? '').trim() || 'url'
  const extraTools = String(options.extra_tools ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
  tools = [...new Set([...BUILTIN_TOOLS, ...extraTools])]
  // A RegExp matcher, since the extra tool names are only known from config.
  const toolMatcher = new RegExp(`^(?:${tools.map(escapeRegExp).join('|')})$`)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sources',
      description: 'Show the web sources Claude consulted this session, and cite them',
      immediate: true,
    })
    return next(e)
  })

  on('tool.call', { tool: toolMatcher }, async ($, e, next) => {
    const out = await next(e)
    try {
      const obs = observe(e.tool, { ...e }, out, urlArg)
      if (obs) await save($, obs)
    } catch (err) {
      $.ui.toast(`sources: could not record ${e.tool} (${message(err)})`)
    }
    return out
  })

  on('command.run', { command: 'sources' }, async $ => {
    const current = await read($, ledger)
    const opened = await $.ui.open({ id: PANE, title: 'Sources' })
    if (opened.isPlaced) return { text: `Sources pane opened: ${summary(current)}.` }
    // No pane here (a -p run, an SDK host): answer with the ledger itself.
    const all = citable(current, true)
    return { text: all.length ? `${summary(current)}\n${formatCitations(all, format)}` : 'No web sources consulted yet.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const session = await read($, ledger) // read in every view, so a new source redraws the pane
    const current: View = projectHistory ? await read($, view) : 'session'
    const shown = current === 'project' ? await loadHistory($) : session

    const byCount = (count: (s: Source) => number) => (a: Source, b: Source) =>
      count(b) - count(a) || b.lastAt - a.lastAt
    const fetched = shown.sources.filter(isFetched).sort(byCount(s => s.fetches))
    const seen = shown.sources.filter(s => !isFetched(s)).sort(byCount(s => s.seen))
    const row = (count: number, s: Source, failed: boolean) => (
      <Text>
        {`${count}×`.padStart(4)} {s.domain}
        <Text dimColor> {s.title ?? label(s).slice(s.domain.length)}</Text>
        {failed && <Text color="red"> failed</Text>}
      </Text>
    )

    const lines = [
      ...(fetched.length ? [<Text bold>Fetched</Text>, ...fetched.map(s => row(s.fetches, s, isFailed(s)))] : []),
      ...(seen.length ? [<Text bold>Search results seen</Text>, ...seen.map(s => row(s.seen, s, false))] : []),
      ...(shown.searches.length
        ? [
            <Text bold>Searches</Text>,
            ...[...shown.searches].reverse().map(q => (
              <Text>
                {'    '}“{q.query}”<Text dimColor> → {plural(q.results, 'result')}</Text>
                {!q.ok && <Text color="red"> failed</Text>}
              </Text>
            )),
          ]
        : []),
    ]
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 5)

    return (
      <Box flexDirection="column">
        <Text bold>
          {summary(shown)}
          <Text dimColor> · {current === 'project' ? 'this project, all sessions' : 'this session'}</Text>
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="insert" hotkey="i" variant="primary" onPress={() => void insertCitations($, shown)}>
            Insert citations
          </Button>
          <Button key="clear" hotkey="c" variant="secondary" onPress={() => void clear($, current)}>
            Clear
          </Button>
          {projectHistory && (
            <Button
              key="view"
              hotkey="p"
              variant="secondary"
              onPress={() => void update($, view, v => (v === 'project' ? 'session' : 'project'))}
            >
              {current === 'project' ? 'Show this session' : 'Show project history'}
            </Button>
          )}
        </Box>
        {lines.length === 0 && (
          <Text dimColor>No web sources yet. {[...tools].join(', ')} calls show up here.</Text>
        )}
        {lines.slice(0, room)}
        {lines.length > room && <Text dimColor>…and {lines.length - room} more lines</Text>}
      </Box>
    )
  })
}
