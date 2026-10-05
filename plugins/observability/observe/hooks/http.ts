
import type { EnvName, Io } from './io'
import { message } from './util'

const MAX_ERROR_DETAIL = 120

export class ApiError extends Error {}

export type Api = {
  name: string // as the person knows the service: "Render"
  secret: string // what its credential is called: "key", "token"
  envVar: EnvName
  rateLimitHint: string
}

// The API's own message when it gave one (never the request, so never the credential).
export function httpError(api: Api, status: number, text: string): ApiError {
  if (status === 401 || status === 403) {
    return new ApiError(`${api.name} rejected the ${api.secret} (HTTP ${status}): check ${api.envVar}`)
  }
  if (status === 429) return new ApiError(`${api.name} rate limit hit (HTTP 429): ${api.rateLimitHint}`)
  let detail = ''
  try {
    const body = JSON.parse(text)
    detail = String(body?.error?.message ?? body?.message ?? '')
  } catch {
    // not JSON: the status says enough
  }
  detail = detail.slice(0, MAX_ERROR_DETAIL)
  return new ApiError(`${api.name} HTTP ${status}${detail ? `: ${detail}` : ''}`)
}

export async function getJson(io: Io, api: Api, url: string, token: string) {
  let res
  try {
    res = await io.fetch(url, { Authorization: `Bearer ${token}`, Accept: 'application/json' })
  } catch (err) {
    throw new ApiError(`${api.name} unreachable: ${message(err)}`)
  }
  if (!res.ok) throw httpError(api, res.status, res.text)
  try {
    return JSON.parse(res.text)
  } catch {
    throw new ApiError(`${api.name} sent a response that is not JSON`)
  }
}
