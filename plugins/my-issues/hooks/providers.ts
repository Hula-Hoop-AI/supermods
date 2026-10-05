// Pure request building and response parsing for each provider. The calls that use `$`
// live in register.tsx, where the engine's scanner can see them.
import type { Issue, ProviderId } from '../types'

export const TIMEOUT_MS = 20_000
export const LINEAR_URL = 'https://api.linear.app/graphql'
export const MONDAY_URL = 'https://api.monday.com/v2'
export const MONDAY_API_VERSION = '2026-07'
export const MONDAY_RECENT_BOARDS = 10 // boards scanned when `monday_boards` is empty
export const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
export const PROVIDERS: ProviderId[] = ['github', 'linear', 'jira', 'monday']
const GH_SEARCH_FIELDS = 'number,title,url,repository,updatedAt,labels'
const GH_LIST_FIELDS = 'number,title,url,updatedAt,labels'
const PRIORITY_LABEL = /^(p[0-4]|priority\b.*|(critical|high|medium|low)[ -]priority)$/i

export type Json = Record<string, unknown>

export type Settings = {
  enabled: Record<ProviderId, boolean>
  limit: number
  githubScope: string
  linearKey: string
  jiraBaseUrl: string
  jiraEmail: string
  jiraToken: string
  jiraJql: string
  mondayToken: string
  mondayBoards: string
}

/** Credentials or a CLI are missing: drawn dim, with how to fix it, not as a failure. */
export class NotConfigured extends Error {}

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
export const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
export const byUpdatedDesc = (a: Issue, b: Issue) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
export const graphql = (query: string, variables?: Json) => JSON.stringify({ query, variables })

/** The most useful line of an error body: Jira's errorMessages, GraphQL's errors, or the raw text. */
export function errorText(body: string): string {
  try {
    const j = JSON.parse(body) as {
      errorMessages?: string[]
      errors?: { message?: string }[] | Record<string, string>
      error_message?: string
      message?: string
    }
    const first =
      j.errorMessages?.[0] ??
      (Array.isArray(j.errors) ? j.errors[0]?.message : j.errors && Object.values(j.errors)[0]) ??
      j.error_message ??
      j.message
    if (first) return clip(first)
  } catch {
    // not JSON: fall through to the text
  }
  const line = body.trim().split('\n')[0] ?? ''
  return line.startsWith('<') ? '' : clip(line) // an HTML error page says nothing useful in one line
}

// ---------------------------------------------------------------- GitHub (gh CLI)

export type GhRow = {
  number: number
  title: string
  url: string
  updatedAt?: string
  repository?: { nameWithOwner?: string }
  labels?: { name: string }[]
}

/** The gh commands for `github_scope`: empty searches everywhere, `repo` lists the session's repo. */
export function githubArgv(scope: string, limit: number): string[][] {
  const n = String(limit)
  if (scope.trim() === 'repo') {
    return [['gh', 'issue', 'list', '--assignee', '@me', '--state', 'open', '--limit', n, '--json', GH_LIST_FIELDS]]
  }
  const search = ['gh', 'search', 'issues', '--assignee', '@me', '--state', 'open', '--sort', 'updated', '--limit', n, '--json', GH_SEARCH_FIELDS]
  const entries = scope.split(/[\s,]+/).filter(Boolean)
  const repos = entries.filter(x => x.includes('/')).flatMap(r => ['--repo', r])
  const owners = entries.filter(x => !x.includes('/')).flatMap(o => ['--owner', o])
  // GitHub ANDs owner and repo qualifiers, so each kind gets its own search.
  const argvs = [repos, owners].filter(q => q.length).map(q => [...search, ...q])
  return argvs.length ? argvs : [search]
}

export function parseGithub(rows: GhRow[]): Issue[] {
  return rows.map(r => {
    const repo = r.repository?.nameWithOwner ?? /github\.com\/([^/]+\/[^/]+)\//.exec(r.url)?.[1] ?? ''
    return {
      key: `${repo}#${r.number}`,
      title: r.title,
      url: r.url,
      status: 'open',
      priority: r.labels?.find(l => PRIORITY_LABEL.test(l.name))?.name,
      updatedAt: r.updatedAt,
    }
  })
}

// ---------------------------------------------------------------- Linear (GraphQL)

export const LINEAR_QUERY = `query MyIssues($first: Int!) {
  viewer {
    assignedIssues(first: $first, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes { identifier title url updatedAt priorityLabel state { name } }
    }
  }
}`

type LinearNode = {
  identifier: string
  title: string
  url: string
  updatedAt?: string
  priorityLabel?: string
  state?: { name?: string }
}

export function parseLinear(body: Json): Issue[] {
  const data = body.data as { viewer?: { assignedIssues?: { nodes?: LinearNode[] } } } | undefined
  return (data?.viewer?.assignedIssues?.nodes ?? []).map(n => ({
    key: n.identifier,
    title: n.title,
    url: n.url,
    status: n.state?.name,
    priority: n.priorityLabel && n.priorityLabel !== 'No priority' ? n.priorityLabel : undefined,
    updatedAt: n.updatedAt,
  }))
}

// ---------------------------------------------------------------- Jira (REST v3)

type JiraIssue = {
  key: string
  fields?: { summary?: string; status?: { name?: string }; priority?: { name?: string }; updated?: string }
}

/** Which Jira settings are missing, by their env var names. */
export function jiraMissing(s: Settings): string[] {
  return [
    s.jiraBaseUrl ? '' : 'JIRA_BASE_URL',
    s.jiraEmail ? '' : 'JIRA_EMAIL',
    s.jiraToken ? '' : 'JIRA_API_TOKEN',
  ].filter(Boolean)
}

export function jiraUrl(base: string, jql: string, limit: number): string {
  const q = new URLSearchParams({ jql, maxResults: String(limit), fields: 'summary,status,priority,updated' })
  return `${base}/rest/api/3/search/jql?${q}`
}

// Jira writes offsets as +0300, which Date.parse does not promise to read.
const isoOffset = (t?: string) => t?.replace(/([+-]\d\d)(\d\d)$/, '$1:$2')

export function parseJira(base: string, body: Json): Issue[] {
  return ((body.issues as JiraIssue[] | undefined) ?? []).map(i => ({
    key: i.key,
    title: i.fields?.summary ?? '',
    url: `${base}/browse/${i.key}`,
    status: i.fields?.status?.name,
    priority: i.fields?.priority?.name,
    updatedAt: isoOffset(i.fields?.updated),
  }))
}

// ---------------------------------------------------------------- monday.com (GraphQL v2)

export type MondayBoard = { id: string; name: string; columns?: { id: string }[] }
type MondayItem = {
  id: string
  name: string
  url: string
  updated_at?: string
  column_values?: { text?: string | null; is_done?: boolean | null }[]
}

/** First query: the boards to scan and each one's People columns. */
export function mondayBoardsQuery(boards: string): string {
  const ids = boards.split(/[\s,]+/).filter(Boolean)
  const bad = ids.find(id => !/^\d+$/.test(id))
  if (bad) throw new Error(`monday_boards takes numeric board ids, got "${clip(bad, 40)}"`)
  const args = ids.length
    ? `ids: [${ids.map(id => JSON.stringify(id)).join(', ')}]`
    : `limit: ${MONDAY_RECENT_BOARDS}, order_by: used_at, state: active`
  return `query { boards(${args}) { id name columns(types: [people]) { id } } }`
}

/** The boards from the first query that have a People column to match on. */
export function mondayBoardsWithPeople(body: Json): MondayBoard[] {
  const boards = (body.data as { boards?: MondayBoard[] } | undefined)?.boards ?? []
  return boards.filter(b => b.columns?.length)
}

/** Second query: one aliased items_page per board, "assigned to me" in any of its People columns. */
export function mondayItemsQuery(boards: MondayBoard[], limit: number): string {
  const pages = boards.map((b, i) => {
    const rules = (b.columns ?? [])
      .map(c => `{ column_id: ${JSON.stringify(c.id)}, compare_value: ["assigned_to_me"], operator: any_of }`)
      .join(', ')
    return `b${i}: boards(ids: [${JSON.stringify(b.id)}]) { items_page(limit: ${limit}, query_params: { operator: or, rules: [${rules}] }) { items { id name url updated_at column_values(types: [status]) { text ... on StatusValue { is_done } } } } }`
  })
  return `query { ${pages.join(' ')} }`
}

/** Items of the second query, without those whose status is marked done. */
export function parseMonday(boards: MondayBoard[], body: Json): Issue[] {
  const data = (body.data ?? {}) as Record<string, { items_page?: { items?: MondayItem[] } }[] | undefined>
  return boards.flatMap((b, i) =>
    (data[`b${i}`]?.[0]?.items_page?.items ?? [])
      .filter(it => !it.column_values?.some(v => v.is_done === true))
      .map(it => ({
        key: it.id,
        title: it.name,
        url: it.url,
        status: it.column_values?.find(v => v.text)?.text ?? undefined,
        updatedAt: it.updated_at,
        context: b.name,
      })),
  )
}
