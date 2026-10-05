import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { citable, formatCitations, normalizeUrl, observe, record, EMPTY } from '../hooks/recorders/ledger'

const SURFACES = ['terminal', 'desktop'] as const

const PANE = {
  plugin: 'trace',
  component: 'Pane',
  requestId: 'trace',
  viewport: { columns: 100, rows: 40 },
  props: {
    title: 'Trace',
    isFocused: true,
    bodyColumns: 80,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const fetchOk = (url: string, code = 200) => ({
  bytes: 1000, code, codeText: code === 200 ? 'OK' : 'Not Found', result: 'summary', durationMs: 5, url,
})
const searchOk = (query: string, hits: { title: string; url: string }[]) => ({
  query, results: [{ tool_use_id: 'srv_1', content: hits }, 'Some commentary'], durationSeconds: 1,
})

type Answer = { result: unknown; isError?: true } | { deny: string }

// Answers every call the mod makes besides the tool itself; `answer` stands for the tool.
function stubEngine(on: On, answer: (tool: string, e: Record<string, unknown>) => Answer) {
  on('tool.call', ($, e) => answer(e.tool, { ...e }) as never)
  on('session.turns', () => ({ value: 3 }))
  on('session.root', () => ({ value: '/work' }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  return { toasts, filled }
}

const webAnswer = (tool: string, e: Record<string, unknown>): Answer => {
  if (tool === 'WebSearch') {
    return {
      result: searchOk(String(e.query), [
        { title: 'Python docs', url: 'https://docs.python.org/3/?utm_source=x' },
        { title: 'Real Python', url: 'https://realpython.com/guide/' },
      ]),
    }
  }
  if (String(e.url).includes('missing')) return { result: fetchOk(String(e.url), 404) }
  if (String(e.url).includes('broken')) return { isError: true, result: 'Error: getaddrinfo ENOTFOUND' }
  if (String(e.url).includes('blocked')) return { deny: 'denied by the user' }
  return { result: fetchOk(String(e.url)) }
}

// The pane opens on Skills; these tests read the Sources tab.
async function mountSources($: Engine, surface: (typeof SURFACES)[number]) {
  const ui = await $.ui.mount({ ...PANE, surface })
  await ui.press({ key: 'tab:sources' })
  return ui
}

const fetch = ($: Engine, url: string) => $.tool.call({ tool: 'WebFetch', url, prompt: 'summarize' })
const search = ($: Engine, query: string) => $.tool.call({ tool: 'WebSearch', query, mode: 'standard' })

// ---- pure logic ----

test('normalizes URLs: fragment, tracking params and trailing slash go, the rest stays', () => {
  expect(normalizeUrl('https://Example.com/a/b/?utm_source=x&id=7&fbclid=abc#top')).toBe('https://example.com/a/b?id=7')
  expect(normalizeUrl('https://example.com/?q=a+b')).toBe('https://example.com/?q=a+b')
  expect(normalizeUrl('https://example.com/')).toBe('https://example.com/')
  expect(normalizeUrl('https://example.com/x?UTM_Campaign=1&gclid=2')).toBe('https://example.com/x')
  expect(normalizeUrl('  not a url ')).toBe('not a url')
})

test('dedupes by normalized URL and counts hits', () => {
  let l = EMPTY
  for (const url of ['https://a.com/p#x', 'https://a.com/p/?utm_medium=y', 'https://a.com/p']) {
    l = record(l, { kind: 'fetch', url, ok: true }, 1, 1, 100)
  }
  expect(l.sources.length).toBe(1)
  expect(l.sources[0]?.fetches).toBe(3)
})

test('caps the ledger, dropping the least recently seen', () => {
  let l = EMPTY
  for (let i = 0; i < 5; i++) l = record(l, { kind: 'fetch', url: `https://a.com/${i}`, ok: true }, 1, i, 3)
  expect(l.sources.map(s => s.url)).toEqual(['https://a.com/2', 'https://a.com/3', 'https://a.com/4'])
})

test('formats citations as a markdown list or numbered refs', () => {
  let l = record(EMPTY, { kind: 'fetch', url: 'https://a.com/x', ok: true, title: 'A [draft]' }, 1, 1, 100)
  l = record(l, { kind: 'fetch', url: 'https://b.org/', ok: true }, 1, 2, 100)
  l = record(l, { kind: 'fetch', url: 'https://c.net/404', ok: false }, 1, 3, 100)
  const list = citable(l, false)
  expect(formatCitations(list, 'markdown')).toBe('Sources:\n- [A \\[draft\\]](https://a.com/x)\n- [b.org](https://b.org/)\n')
  expect(formatCitations(list, 'numbered')).toBe('Sources:\n[1] A [draft]. https://a.com/x\n[2] b.org. https://b.org/\n')
})

test('reads search hits, skipping commentary strings, and a title from an extra tool', () => {
  const obs = observe('WebSearch', { query: 'q' }, { result: searchOk('q', [{ title: 'T', url: 'https://t.io' }]) }, 'url')
  expect(obs).toEqual({ kind: 'search', query: 'q', ok: true, hits: [{ url: 'https://t.io', title: 'T' }] })
  const extra = observe('mcp__f__fetch', { target: 'https://x.dev' }, { result: 'raw', text: '<html><title> X Dev </title>' }, 'target')
  expect(extra).toEqual({ kind: 'fetch', url: 'https://x.dev', ok: true, title: 'X Dev' })
  expect(observe('mcp__f__fetch', { other: 1 }, { result: 'x' }, 'target')).toBeUndefined()
})

// ---- through the hooks ----

test('returns tool results unchanged and ignores other tools', async ($, on) => {
  stubEngine(on, (tool, e) => (tool === 'Bash' ? { result: 'ls output' } : webAnswer(tool, e)))
  const out = await fetch($, 'https://docs.python.org/3/')
  expect(out.result).toEqual(fetchOk('https://docs.python.org/3/'))
  const bash = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(bash.result).toBe('ls output')
  const ui = await mountSources($, 'terminal')
  expect(await ui.find({ text: /1 page fetched/ })).toBeDefined()
})

for (const surface of SURFACES) {
  test(`groups fetched pages and search results, deduped, on ${surface}`, async ($, on) => {
    stubEngine(on, webAnswer)
    await search($, 'python docs')
    await fetch($, 'https://docs.python.org/3/#intro')
    await fetch($, 'https://docs.python.org/3?utm_campaign=z')
    const ui = await mountSources($, surface)
    expect(await ui.find({ text: /1 page fetched · 1 search result seen · 1 search/ })).toBeDefined()
    expect(await ui.find({ text: /^fetched +2× docs\.python\.org +Python docs$/ })).toBeDefined()
    expect(await ui.find({ text: /^seen +1× realpython\.com +Real Python$/ })).toBeDefined()
    expect(await ui.find({ text: /^search +“python docs” +→ 2 results$/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Link' })).toHaveLength(2) // one per page, none for the search
  })

  test(`marks failed fetches (HTTP error, tool error, denied) and never cites them on ${surface}`, async ($, on) => {
    const { filled, toasts } = stubEngine(on, webAnswer)
    await fetch($, 'https://a.com/missing')
    await fetch($, 'https://b.com/broken')
    await fetch($, 'https://c.com/blocked')
    const ui = await mountSources($, surface)
    expect(await ui.find({ text: /3 pages fetched \(3 failed\)/ })).toBeDefined()
    expect(await ui.find({ text: /^fetched 1× a\.com +\/missing failed$/ })).toBeDefined()
    await ui.press({ key: 'insert' })
    expect(filled).toEqual([])
    expect(toasts).toEqual(['trace: no pages fetched yet to cite'])
  })

  test(`Insert citations fills the prompt as a markdown list by default on ${surface}`, async ($, on) => {
    const { filled } = stubEngine(on, webAnswer)
    await search($, 'python')
    await fetch($, 'https://docs.python.org/3/')
    await fetch($, 'https://a.com/missing')
    const ui = await mountSources($, surface)
    await ui.press({ key: 'insert' })
    expect(filled).toEqual(['Sources:\n- [Python docs](https://docs.python.org/3)\n'])
  })

  test(`sources_citation_format numbered and sources_cite_search_results on ${surface}`, { options: { sources_citation_format: 'numbered', sources_cite_search_results: true } }, async ($, on) => {
    const { filled } = stubEngine(on, webAnswer)
    await search($, 'python')
    const ui = await mountSources($, surface)
    await ui.press({ key: 'insert' })
    expect(filled).toEqual([
      'Sources:\n[1] Python docs. https://docs.python.org/3\n[2] Real Python. https://realpython.com/guide\n',
    ])
  })

  test(`Clear empties the session ledger on ${surface}`, async ($, on) => {
    stubEngine(on, webAnswer)
    await fetch($, 'https://docs.python.org/3/')
    const ui = await mountSources($, surface)
    await ui.press({ key: 'clear' })
    expect(await ui.find({ text: /No web sources yet/ })).toBeDefined()
    expect(await ui.find({ key: 'view' })).toBeUndefined() // no history button unless enabled
  })

  test(`sources_extra_tools with sources_url_arg records an MCP fetch tool on ${surface}`, { options: { sources_extra_tools: 'mcp__web__get, mcp__other__x', sources_url_arg: 'target' } }, async ($, on) => {
    stubEngine(on, () => ({ result: '<title>Spec page</title> body' }))
    // A made-up MCP tool: not in the generated ToolName union, which lists this machine's tools.
    await $.tool.call({ tool: 'mcp__web__get', target: 'https://spec.example/p' } as never)
    const ui = await mountSources($, surface)
    expect(await ui.find({ text: /1×.*spec\.example.*Spec page/ })).toBeDefined()
  })

  test(`sources_project_history keeps sources in the store and the pane shows them on ${surface}`, { options: { sources_project_history: true } }, async ($, on) => {
    const saved = new Map<string, unknown>([
      ['sources:/work', { sources: [{ url: 'https://old.dev/', domain: 'old.dev', fetches: 1, failures: 0, seen: 0, queries: [], firstTurn: 1, lastTurn: 1, lastAt: 1 }], searches: [] }],
    ])
    on('store.get', ($, e) => ({ value: saved.get(e.key) }))
    on('store.set', ($, e) => {
      saved.set(e.key, e.value)
      return { value: undefined }
    })
    on('store.delete', ($, e) => {
      saved.delete(e.key)
      return { value: undefined }
    })
    stubEngine(on, webAnswer)
    await fetch($, 'https://docs.python.org/3/')
    const ui = await mountSources($, surface)
    expect(await ui.find({ text: /old\.dev/ })).toBeUndefined() // the session view by default
    await ui.press({ key: 'view' })
    expect(await ui.find({ text: /this project, all sessions/ })).toBeDefined()
    expect(await ui.find({ text: /2 pages fetched/ })).toBeDefined()
    expect(await ui.find({ text: /old\.dev/ })).toBeDefined()
    await ui.press({ key: 'clear' })
    expect(saved.has('sources:/work')).toBe(false)
  })
}

test('without sources_project_history the store is never touched', async ($, on) => {
  const { toasts } = stubEngine(on, webAnswer)
  await fetch($, 'https://docs.python.org/3/')
  expect(toasts).toEqual([]) // a store call would have failed: no stub answers it
})

test('a failure to record shows a toast and still returns the result', async ($, on) => {
  on('tool.call', () => ({ result: fetchOk('https://a.com') }) as never)
  on('session.turns', () => ({ deny: 'no session' }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const out = await fetch($, 'https://a.com')
  expect(out.result).toEqual(fetchOk('https://a.com'))
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/^trace: could not record WebFetch/)
})

test('/trace sources opens the pane on Sources and summarizes', async ($, on) => {
  stubEngine(on, webAnswer)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await fetch($, 'https://docs.python.org/3/')
  const out = await $.command.run({ command: 'trace', args: 'sources' } as never)
  expect(out.text).toBe('Trace pane opened on Sources: 1 page fetched · 0 search results seen · 0 searches.')
})

test('/trace sources says why no pane shows and answers with the list', async ($, on) => {
  stubEngine(on, webAnswer)
  on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'headless' } }))
  await search($, 'python')
  const out = await $.command.run({ command: 'trace', args: 'sources' } as never)
  expect(out.text).toBe(
    'The Trace pane is open, but this surface is not showing it: headless\n0 pages fetched · 2 search results seen · 1 search\nSources:\n- [Python docs](https://docs.python.org/3)\n- [Real Python](https://realpython.com/guide)\n',
  )
})

test('session.start registers /trace with its argument hint', async ($, on) => {
  const registered: string[] = []
  on('command.register', ($, e) => {
    registered.push(`${e.name} ${e.argumentHint}`)
    return { value: { command: e.name } }
  })
  on('session.start', () => ({ cwd: '/work' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never)
  expect(registered).toEqual(['trace [skills|sources]'])
})
