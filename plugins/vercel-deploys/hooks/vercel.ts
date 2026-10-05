import type { Deploy, DeployState } from '../types'

export const VERCEL_API = 'https://api.vercel.com/v7/deployments'
const MAX_ERROR_DETAIL = 120

export type Scope = { team?: string; project?: string }

const STATES: Record<string, DeployState> = {
  QUEUED: 'building',
  INITIALIZING: 'building',
  BUILDING: 'building',
  READY: 'ready',
  ERROR: 'error',
  BLOCKED: 'error', // held by checks or a seat block: needs someone to act
  CANCELED: 'canceled',
  DELETED: 'canceled',
}

export const normalizeState = (s: string | undefined): DeployState => STATES[s ?? ''] ?? 'error'

type VercelDeployment = {
  uid: string
  name: string
  url?: string | null
  inspectorUrl?: string | null
  created: number
  state?: string
  readyState?: string
  target?: string | null
  customEnvironment?: { slug?: string }
  creator?: { username?: string; githubLogin?: string; email?: string }
  meta?: Record<string, string>
}

export function deploymentsUrl(scope: Scope, limit: number): string {
  const q = new URLSearchParams({ limit: String(limit) })
  if (scope.project) q.set('projectId', scope.project) // takes an id or a name
  if (scope.team) q.set(scope.team.startsWith('team_') ? 'teamId' : 'slug', scope.team)
  return `${VERCEL_API}?${q.toString()}`
}

// Git metadata is keyed by provider: githubCommitRef, gitlabCommitRef, bitbucketCommitRef, ...
function gitMeta(meta: Record<string, string> | undefined, suffix: string): string | undefined {
  if (!meta) return undefined
  const key = Object.keys(meta).find(k => k.endsWith(suffix))
  return key ? meta[key] || undefined : undefined
}

export function parseDeployments(body: { deployments?: VercelDeployment[] }): Deploy[] {
  return (body.deployments ?? []).map(d => ({
    id: d.uid,
    project: d.name,
    env: d.target === 'production' ? 'prod' : (d.customEnvironment?.slug ?? 'preview'),
    state: normalizeState(d.readyState ?? d.state),
    branch: gitMeta(d.meta, 'CommitRef'),
    sha: gitMeta(d.meta, 'CommitSha'),
    message: firstLine(gitMeta(d.meta, 'CommitMessage')),
    creator: d.creator?.username ?? d.creator?.githubLogin ?? d.creator?.email,
    createdAt: d.created,
    url: d.url ? `https://${d.url}` : (d.inspectorUrl ?? undefined),
  }))
}

function firstLine(s: string | undefined): string | undefined {
  const line = s?.split('\n')[0]?.trim()
  return line || undefined
}

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class ApiError extends Error {}

// The API's own message when it gave one (never the request, so never the token).
export function httpError(status: number, text: string): ApiError {
  if (status === 401 || status === 403) {
    return new ApiError(`Vercel rejected the token (HTTP ${status}): check VERCEL_TOKEN`)
  }
  if (status === 429) return new ApiError('Vercel rate limit hit (HTTP 429): raise the refresh intervals')
  let detail = ''
  try {
    const body = JSON.parse(text)
    detail = String(body?.error?.message ?? body?.message ?? '')
  } catch {
    // not JSON: the status says enough
  }
  detail = detail.slice(0, MAX_ERROR_DETAIL)
  return new ApiError(`Vercel HTTP ${status}${detail ? `: ${detail}` : ''}`)
}
