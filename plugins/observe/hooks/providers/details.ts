// The logs and metrics panes' reads, by the tab the container came from.
import type { Io } from '../io'
import type { Logs, Metrics, Target } from '../../types'
import type { Detail } from '../util'
import { fetchDockerLogs, fetchDockerMetrics } from './docker-detail'
import { shortId } from './modal'
import { fetchModalLogs, fetchModalMetrics } from './modal-detail'

export const fetchDetailLogs = (io: Io, prev: Logs) =>
  prev.source === 'docker' ? fetchDockerLogs(io, prev) : fetchModalLogs(io, prev)

export const fetchDetailMetrics = (io: Io, prev: Metrics) =>
  prev.source === 'docker' ? fetchDockerMetrics(io, prev) : fetchModalMetrics(io, prev)

// e.g. "Modal logs · train-llm …AAA111", "Docker metrics · webapp-web-1" (a Docker name is unique).
export function detailTitle(kind: Detail, t: Target) {
  const what = `${t.source === 'docker' ? 'Docker' : 'Modal'} ${kind}`
  return `${what} · ${t.name}${t.source === 'modal' ? ` ${shortId(t.container_id)}` : ''}`
}
