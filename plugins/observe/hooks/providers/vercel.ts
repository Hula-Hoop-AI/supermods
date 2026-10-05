import type { PluginOptions } from 'claude-code'

import type { Io } from '../io'
import type { App, Deploy, DeployState, ObserveRow, Snapshot } from '../../types'
import { getJson } from '../http'
import type { Api } from '../http'
import { firstLine, message } from '../util'
import { detectWorkspace } from '../workspace'
import type { DeployConfig } from './deploys'
import { branchContext, deployConfig, deployInterval, deployRows, deployView, newest } from './deploys'
import type { ProviderOf } from './index'

export const VERCEL_API = 'https://api.vercel.com/v7/deployments'
export const PROJECTS_API = 'https://api.vercel.com/v9/projects'
// How long an app's production domain is trusted before it is looked up again.
const APP_TTL_MS = 60 * 60_000
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
  projectId?: string
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

function setTeam(q: URLSearchParams, team: string | undefined) {
  if (team) q.set(team.startsWith('team_') ? 'teamId' : 'slug', team)
}

export function deploymentsUrl(scope: Scope, limit: number): string {
  const q = new URLSearchParams({ limit: String(limit) })
  if (scope.project) q.set('projectId', scope.project) // takes an id or a name
  setTeam(q, scope.team)
  return `${VERCEL_API}?${q.toString()}`
}

// One project, by id or name: the deployments list carries no production domain.
export function projectUrl(idOrName: string, team: string | undefined): string {
  const q = new URLSearchParams()
  setTeam(q, team)
  const query = q.toString()
  return `${PROJECTS_API}/${encodeURIComponent(idOrName)}${query ? `?${query}` : ''}`
}

type VercelProject = { targets?: { production?: { alias?: unknown } } }

// A custom domain first, else the shortest *.vercel.app one (the team-suffixed one is longer).
export function productionDomain(p: VercelProject): string | undefined {
  const raw = p.targets?.production?.alias
  const aliases = (Array.isArray(raw) ? raw : []).filter((a): a is string => typeof a === 'string' && a !== '')
  return aliases.find(a => !a.endsWith('.vercel.app')) ?? [...aliases].sort((a, b) => a.length - b.length)[0]
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
    group: d.projectId || d.name,
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

// Looks up the apps not seen within APP_TTL_MS (all of them when forced), one request each, in
// parallel. A failed lookup keeps the last domain known, or none: the headline falls back to the
// project's name, and the app is not asked again until the TTL or a forced refresh.
export async function lookupApps(
  io: Io,
  keys: string[],
  team: string | undefined,
  token: string,
  prev: Record<string, App>,
  now: number,
  force: boolean,
): Promise<Record<string, App>> {
  const stale = keys.filter(k => force || !prev[k] || now - prev[k].at >= APP_TTL_MS)
  const found = await Promise.all(
    stale.map(async (k): Promise<[string, App]> => {
      try {
        return [k, { domain: productionDomain(await getJson(io, API, projectUrl(k, team), token)), at: now }]
      } catch {
        return [k, { domain: prev[k]?.domain, at: now }]
      }
    }),
  )
  return { ...prev, ...Object.fromEntries(found) }
}

// A headline per app (its production domain, else its name) above its deploys, newest first;
// apps ordered by their newest deploy.
export function appRows(deploys: Deploy[], apps: Record<string, App>, branch: string | undefined, now: number): ObserveRow[] {
  const byApp = new Map<string, Deploy[]>()
  for (const d of newest(deploys, deploys.length)) {
    const key = d.group ?? d.name
    byApp.set(key, [...(byApp.get(key) ?? []), d])
  }
  return [...byApp].flatMap(([key, list]) => {
    const domain = apps[key]?.domain
    const url = domain ? `https://${domain}` : undefined
    return [
      { id: `app:${key}`, heading: true, title: domain ?? list[0]!.name, link: url, copyText: url },
      // The headline carries the app's URL; each deploy's own URL would repeat it row after row.
      ...deployRows(list, branch, now).map(({ link: _link, ...row }) => row),
    ]
  })
}

export type VercelConfig = DeployConfig & { team: string; project: string }

export async function fetchVercel(io: Io, cfg: VercelConfig, prev: Snapshot, force: boolean): Promise<Snapshot> {
  const ws = await detectWorkspace(io, true)
  const base = { branch: ws.branch, context: branchContext(ws.branch) }
  const now = await io.now()
  const token = await io.env[API.envVar]()
  if (!token) return { ...base, rows: [], error: `${API.envVar} is not set` }
  const isLinked = !cfg.project && ws.linkedProject !== undefined
  // A personal account's orgId is a user id, which the API takes as no team at all.
  const linkedTeam = ws.linkedOrg?.startsWith('team_') ? ws.linkedOrg : undefined
  const team = cfg.team || linkedTeam
  const url = deploymentsUrl({ team, project: cfg.project || ws.linkedProject }, cfg.maxRows)
  try {
    const deploys = newest(parseDeployments(await getJson(io, API, url, token)), cfg.maxRows)
    const keys = [...new Set(deploys.map(d => d.group ?? d.name))]
    const apps = await lookupApps(io, keys, team, token, prev.carry?.apps ?? {}, now, force)
    return {
      ...base,
      rows: appRows(deploys, apps, ws.branch, now),
      notes: isLinked ? ['project from .vercel/project.json'] : undefined,
      carry: { apps },
    }
  } catch (err) {
    return { ...base, rows: [], error: message(err), carry: prev.carry }
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
