import type { PluginOptions } from 'claude-code'

import type { Io } from '../io'
import type { Deploy, DeployState, Snapshot } from '../../types'
import { getJson } from '../http'
import type { Api } from '../http'
import { firstLine, message } from '../util'
import { detectWorkspace } from '../workspace'
import type { DeployConfig } from './deploys'
import { branchContext, deployConfig, deployInterval, deployRows, deployView, newest } from './deploys'
import type { ProviderOf } from './index'

export const VERCEL_API = 'https://api.vercel.com/v7/deployments'
export const API: Api = {
  name: 'Vercel',
  secret: 'token',
  envVar: 'VERCEL_TOKEN',
  rateLimitHint: 'raise the refresh intervals',
}

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
    name: d.name,
    env: d.target === 'production' ? 'prod' : (d.customEnvironment?.slug ?? 'preview'),
    state: normalizeState(d.readyState ?? d.state),
    branch: gitMeta(d.meta, 'CommitRef'),
    sha: gitMeta(d.meta, 'CommitSha'),
    message: firstLine(gitMeta(d.meta, 'CommitMessage')),
    who: d.creator?.username ?? d.creator?.githubLogin ?? d.creator?.email,
    createdAt: d.created,
    url: d.url ? `https://${d.url}` : (d.inspectorUrl ?? undefined),
  }))
}

export type VercelConfig = DeployConfig & { team: string; project: string }

export async function fetchVercel(io: Io, cfg: VercelConfig): Promise<Snapshot> {
  const ws = await detectWorkspace(io, true)
  const base = { branch: ws.branch, context: branchContext(ws.branch) }
  const now = await io.now()
  const token = await io.env[API.envVar]()
  if (!token) return { ...base, rows: [], error: `${API.envVar} is not set` }
  const isLinked = !cfg.project && ws.linkedProject !== undefined
  // A personal account's orgId is a user id, which the API takes as no team at all.
  const linkedTeam = ws.linkedOrg?.startsWith('team_') ? ws.linkedOrg : undefined
  const url = deploymentsUrl({ team: cfg.team || linkedTeam, project: cfg.project || ws.linkedProject }, cfg.maxRows)
  try {
    const deploys = newest(parseDeployments(await getJson(io, API, url, token)), cfg.maxRows)
    return {
      ...base,
      rows: deployRows(deploys, ws.branch, now),
      notes: isLinked ? ['project from .vercel/project.json'] : undefined,
    }
  } catch (err) {
    return { ...base, rows: [], error: message(err) }
  }
}

export function vercel(options: PluginOptions): ProviderOf<'vercel'> {
  const config: VercelConfig = {
    ...deployConfig(options),
    team: String(options.vercel_team ?? '').trim(),
    project: String(options.vercel_project ?? '').trim(),
  }
  return {
    id: 'vercel',
    title: 'Vercel',
    config,
    intervalMs: snap => deployInterval(snap, config),
    view: deployView,
  }
}
