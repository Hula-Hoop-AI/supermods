import type { Ledger, Source } from '../types'

// Query parameters that only track the click, never change the page.
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'igshid',
  'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'mkt_tok', 'ref_src', 'ref_url', 'spm',
])
const MAX_QUERIES_PER_SOURCE = 5
const MAX_SEARCHES = 100
const MAX_TITLE = 200

export const EMPTY: Ledger = { sources: [], searches: [] }

export type Observation =
  | { kind: 'fetch'; url: string; ok: boolean; title?: string }
  | { kind: 'search'; query: string; ok: boolean; hits: { url: string; title?: string }[] }

export type CitationFormat = 'markdown' | 'numbered'

/** Drops the fragment, tracking params (utm_* and friends) and a trailing slash. */
export function normalizeUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return raw.trim()
  }
  u.hash = ''
  const tracking: string[] = []
  u.searchParams.forEach((_, key) => {
    const k = key.toLowerCase()
    if (k.startsWith('utm_') || TRACKING_PARAMS.has(k)) tracking.push(key)
  })
  // Deleting re-encodes the query, so touch it only when there is something to drop.
  for (const key of tracking) u.searchParams.delete(key)
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1)
  return u.toString()
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const clip = (s: string | undefined) => (s && s.length > MAX_TITLE ? s.slice(0, MAX_TITLE - 1) + '…' : s)

/** Whether a tool.call outcome succeeded: not denied, not an error, no HTTP error code. */
function succeeded(out: unknown): boolean {
  if (!isObject(out) || out.deny !== undefined || out.isError === true) return false
  const code = isObject(out.result) ? out.result.code : undefined
  return typeof code !== 'number' || code < 400
}

/** A page title from a tool's own result: a `title` field, or an HTML <title>. */
function titleFrom(out: unknown): string | undefined {
  if (!isObject(out)) return undefined
  if (isObject(out.result) && str(out.result.title)) return clip(str(out.result.title))
  const text = typeof out.text === 'string' ? out.text : typeof out.result === 'string' ? out.result : ''
  const m = /<title[^>]*>([^<]{1,500})<\/title>/i.exec(text)
  return clip(str(m?.[1]))
}

/**
 * What one tool call tells us: `args` is the call's input, `out` what `next(e)` resolved to.
 * WebFetch and WebSearch are read by their built-in shapes; any other tool is a fetch of the
 * URL in `args[urlArg]`. Undefined when the call names no URL or query.
 */
export function observe(
  tool: string,
  args: Record<string, unknown>,
  out: unknown,
  urlArg: string,
): Observation | undefined {
  const ok = succeeded(out)
  if (tool === 'WebSearch') {
    const query = str(args.query)
    if (!query) return undefined
    const hits: { url: string; title?: string }[] = []
    const results = isObject(out) && isObject(out.result) ? out.result.results : undefined
    for (const block of Array.isArray(results) ? results : []) {
      if (!isObject(block) || !Array.isArray(block.content)) continue
      for (const hit of block.content) {
        const url = isObject(hit) ? str(hit.url) : undefined
        if (url) hits.push({ url, title: clip(str(isObject(hit) ? hit.title : undefined)) })
      }
    }
    return { kind: 'search', query, ok, hits }
  }
  const url = str(args[tool === 'WebFetch' ? 'url' : urlArg])
  if (!url) return undefined
  return { kind: 'fetch', url, ok, title: tool === 'WebFetch' ? undefined : titleFrom(out) }
}

function touch(sources: Source[], url: string, turn: number, at: number): Source {
  const key = normalizeUrl(url)
  let s = sources.find(x => x.url === key)
  if (!s) {
    s = { url: key, domain: domainOf(key), fetches: 0, failures: 0, seen: 0, queries: [], firstTurn: turn, lastTurn: turn, lastAt: at }
    sources.push(s)
  }
  s.lastTurn = turn
  s.lastAt = at
  return s
}

/** The ledger with one observation added; at most `maxSources`, least recently seen dropped. */
export function record(ledger: Ledger, obs: Observation, turn: number, at: number, maxSources: number): Ledger {
  const sources = ledger.sources.map(s => ({ ...s, queries: [...s.queries] }))
  let searches = ledger.searches
  if (obs.kind === 'fetch') {
    const s = touch(sources, obs.url, turn, at)
    s.fetches++
    if (!obs.ok) s.failures++
    if (obs.title) s.title = obs.title
  } else {
    for (const hit of obs.hits) {
      const s = touch(sources, hit.url, turn, at)
      s.seen++
      if (hit.title && !s.title) s.title = hit.title
      if (!s.queries.includes(obs.query)) s.queries = [...s.queries, obs.query].slice(-MAX_QUERIES_PER_SOURCE)
    }
    searches = [...searches, { query: obs.query, results: obs.hits.length, ok: obs.ok, turn, at }].slice(-MAX_SEARCHES)
  }
  if (sources.length > maxSources) {
    const keep = new Set([...sources].sort((a, b) => b.lastAt - a.lastAt).slice(0, maxSources))
    return { sources: sources.filter(s => keep.has(s)), searches }
  }
  return { sources, searches }
}

export const isFetched = (s: Source) => s.fetches > 0
export const isFailed = (s: Source) => s.fetches > 0 && s.failures >= s.fetches

/** Sources worth citing: fetched at least once successfully, plus search hits when asked. */
export function citable(ledger: Ledger, includeSearchResults: boolean): Source[] {
  return ledger.sources.filter(s => (isFetched(s) ? !isFailed(s) : includeSearchResults))
}

export function label(s: Source): string {
  if (s.title) return s.title
  try {
    const u = new URL(s.url)
    return u.pathname === '/' ? s.domain : s.domain + u.pathname
  } catch {
    return s.url
  }
}

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

export const isLedger = (v: unknown): v is Ledger =>
  isObject(v) && Array.isArray(v.sources) && Array.isArray(v.searches)

/** One line: pages fetched (failed), search results seen, searches. */
export function summary(l: Ledger): string {
  const fetched = l.sources.filter(isFetched)
  const failed = fetched.filter(isFailed).length
  return [
    plural(fetched.length, 'page') + ' fetched' + (failed ? ` (${failed} failed)` : ''),
    plural(l.sources.length - fetched.length, 'search result') + ' seen',
    plural(l.searches.length, 'search', 'searches'),
  ].join(' · ')
}

export function formatCitations(sources: Source[], format: CitationFormat): string {
  const lines = sources.map((s, i) =>
    format === 'numbered'
      ? `[${i + 1}] ${label(s)}. ${s.url}`
      : `- [${label(s).replace(/([[\]])/g, '\\$1')}](${s.url.replace(/\)/g, '%29')})`,
  )
  return `Sources:\n${lines.join('\n')}\n`
}
