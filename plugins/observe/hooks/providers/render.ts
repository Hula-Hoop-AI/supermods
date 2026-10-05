import type { PluginOptions } from 'claude-code'

import type { Io } from '../io'
import type { Deploy, DeployState, Service, Snapshot } from '../../types'
import { getJson } from '../http'
import type { Api } from '../http'
import { firstLine, list, message, num } from '../util'
import { detectWorkspace } from '../workspace'
import type { DeployConfig } from './deploys'
import { branchContext, deployConfig, deployInterval, deployRows, deployView, newest } from './deploys'
import type { ProviderOf } from './index'

export const RENDER_API = 'https://api.render.com/v1'
export const API: Api = {
  name: 'Render',
  secret: 'key',
  envVar: 'RENDER_API_KEY',
  rateLimitHint: 'set render_services or raise the refresh intervals',
}

const STATES: Record<string, DeployState> = {
  created: 'building',
  queued: 'building',
  build_in_progress: 'building',
  update_in_progress: 'building',
  pre_deploy_in_progress: 'building',
  live: 'ready',
  deactivated: 'ready', // a successful deploy a newer one replaced
  build_failed: 'error',
  update_failed: 'error',
  pre_deploy_failed: 'error',
  canceled: 'canceled',
}

export const normalizeState = (s: string | undefined): DeployState => STATES[s ?? ''] ?? 'error'

type RenderService = {
  id: string
  name: string
  branch?: string
  dashboardUrl?: string
  serviceDetails?: { parentServer?: unknown }
}
type RenderDeploy = {
  id: string
  status?: string
  trigger?: string
  commit?: { id?: string; message?: string }
  createdAt?: string
}

export const servicesUrl = () => `${RENDER_API}/services?limit=100`
export const deploysUrl = (serviceId: string, limit: number) =>
  `${RENDER_API}/services/${encodeURIComponent(serviceId)}/deploys?limit=${Math.min(limit, 100)}`

export function pickServices(
  body: { service?: RenderService }[],
  names: string[],
  max: number,
): { services: Service[]; skipped: number } {
  const all = body.flatMap(r => (r.service ? [r.service] : []))
  const wanted = names.length ? all.filter(s => names.includes(s.name)) : all
  return {
    services: wanted.slice(0, max).map(s => ({
      id: s.id,
      name: s.name,
      branch: s.branch || undefined,
      dashboardUrl: s.dashboardUrl || undefined,
      preview: Boolean(s.serviceDetails?.parentServer),
    })),
    skipped: Math.max(0, wanted.length - max),
  }
}

export function parseDeploys(service: Service, body: { deploy?: RenderDeploy }[]): Deploy[] {
  return body.flatMap(r => {
    const d = r.deploy
    if (!d) return []
    const created = Date.parse(d.createdAt ?? '')
    return [{
      id: d.id,
      name: service.name,
      group: service.id,
      env: service.preview ? 'preview' : 'prod',
      state: normalizeState(d.status),
      branch: service.branch,
      sha: d.commit?.id || undefined,
      message: firstLine(d.commit?.message),
      who: d.trigger ? d.trigger.replaceAll('_', ' ') : undefined,
      createdAt: Number.isNaN(created) ? 0 : created,
      url: service.dashboardUrl ? `${service.dashboardUrl}/deploys/${d.id}` : undefined,
    }]
  })
}

// Services with a deploy still building: the only ones a fast poll re-fetches.
export const buildingServiceIds = (deploys: Deploy[]) =>
  [...new Set(deploys.filter(d => d.state === 'building').flatMap(d => (d.group ? [d.group] : [])))]

type Fetched = { deploys: Deploy[]; services: Service[]; error?: string; notes?: string[]; fullAt?: number }

export type RenderConfig = DeployConfig & { names: string[]; maxServices: number }

// One request per service; a failing service keeps its previous rows (in `failed`) and names the error.
async function fetchDeploys(io: Io, cfg: RenderConfig, services: Service[], token: string) {
  const results = await Promise.allSettled(
    services.map(async s => {
      const body = await getJson(io, API, deploysUrl(s.id, cfg.maxRows), token)
      return parseDeploys(s, Array.isArray(body) ? body : [])
    }),
  )
  const failed = new Set(services.filter((_, i) => results[i]!.status === 'rejected').map(s => s.id))
  const rejected = results.find(r => r.status === 'rejected')
  return {
    deploys: results.flatMap(r => (r.status === 'fulfilled' ? r.value : [])),
    failed,
    error: rejected ? message(rejected.reason) : undefined,
  }
}

// The service list and every service's deploys.
async function fullFetch(io: Io, cfg: RenderConfig, token: string, now: number): Promise<Fetched> {
  try {
    const body = await getJson(io, API, servicesUrl(), token)
    const { services, skipped } = pickServices(Array.isArray(body) ? body : [], cfg.names, cfg.maxServices)
    const { deploys, error } = await fetchDeploys(io, cfg, services, token)
    const notes = [
      skipped ? `${skipped} more services not shown: set render_services or render_max_services` : '',
      cfg.names.length && !services.length ? `no service named ${cfg.names.join(', ')}` : '',
    ].filter(Boolean)
    return { deploys, services, error, notes, fullAt: now }
  } catch (err) {
    return { deploys: [], services: [], error: message(err) }
  }
}

// Only the services with a deploy building; every other deploy is kept from the last refresh.
async function buildingFetch(io: Io, cfg: RenderConfig, token: string, prev: Snapshot): Promise<Fetched> {
  const before = prev.carry?.deploys ?? []
  const services = prev.carry?.services ?? []
  const ids = new Set(buildingServiceIds(before))
  const { deploys, failed, error } = await fetchDeploys(io, cfg, services.filter(s => ids.has(s.id)), token)
  const kept = before.filter(d => !d.group || !ids.has(d.group) || failed.has(d.group))
  return { deploys: [...kept, ...deploys], services, error, notes: prev.notes, fullAt: prev.carry?.fullAt }
}

export async function fetchRender(io: Io, cfg: RenderConfig, prev: Snapshot, force: boolean): Promise<Snapshot> {
  const { branch } = await detectWorkspace(io, false)
  const base = { branch, context: branchContext(branch) }
  const now = await io.now()
  const token = await io.env[API.envVar]()
  if (!token) return { ...base, rows: [], error: `${API.envVar} is not set` }
  const { services, fullAt } = prev.carry ?? {}
  const isFull = force || !services?.length || fullAt === undefined || now - fullAt >= cfg.slowMs
  const got = isFull ? await fullFetch(io, cfg, token, now) : await buildingFetch(io, cfg, token, prev)
  const deploys = newest(got.deploys, cfg.maxRows)
  return {
    ...base,
    rows: deployRows(deploys, branch, now),
    error: got.error,
    notes: got.notes,
    carry: { services: got.services, deploys, fullAt: got.fullAt },
  }
}

export function render(options: PluginOptions): ProviderOf<'render'> {
  const config: RenderConfig = {
    ...deployConfig(options),
    names: list(options.render_services),
    maxServices: Math.floor(num(options.render_max_services, 10, 1)),
  }
  return {
    id: 'render',
    title: 'Render',
    config,
    intervalMs: snap => deployInterval(snap, config),
    view: deployView,
  }
}
