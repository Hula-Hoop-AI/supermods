import type { Deploy, DeployState, Service } from '../types'

export const RENDER_API = 'https://api.render.com/v1'
const MAX_ERROR_DETAIL = 120

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
      serviceId: service.id,
      service: service.name,
      env: service.preview ? 'preview' : 'prod',
      state: normalizeState(d.status),
      branch: service.branch,
      sha: d.commit?.id || undefined,
      message: firstLine(d.commit?.message),
      trigger: d.trigger ? d.trigger.replaceAll('_', ' ') : undefined,
      createdAt: Number.isNaN(created) ? 0 : created,
      url: service.dashboardUrl ? `${service.dashboardUrl}/deploys/${d.id}` : undefined,
    }]
  })
}

// Services with a deploy still building: the only ones a fast poll re-fetches.
export const buildingServiceIds = (deploys: Deploy[]) =>
  [...new Set(deploys.filter(d => d.state === 'building').map(d => d.serviceId))]

function firstLine(s: string | undefined): string | undefined {
  const line = s?.split('\n')[0]?.trim()
  return line || undefined
}

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class ApiError extends Error {}

// The API's own message when it gave one (never the request, so never the token).
export function httpError(status: number, text: string): ApiError {
  if (status === 401 || status === 403) {
    return new ApiError(`Render rejected the key (HTTP ${status}): check RENDER_API_KEY`)
  }
  if (status === 429) return new ApiError('Render rate limit hit (HTTP 429): set render services or raise the refresh intervals')
  let detail = ''
  try {
    const body = JSON.parse(text)
    detail = String(body?.message ?? body?.error?.message ?? '')
  } catch {
    // not JSON: the status says enough
  }
  detail = detail.slice(0, MAX_ERROR_DETAIL)
  return new ApiError(`Render HTTP ${status}${detail ? `: ${detail}` : ''}`)
}
