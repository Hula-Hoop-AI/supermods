import type { PluginOptions } from 'claude-code'

import type { RowState } from '../tab-pane'
import type { Deploy, DeployState, ObserveRow, Snapshot } from '../../types'
import { age, num, plural } from '../util'
import type { View } from './index'

const SHA_LENGTH = 7
const ROW_STATES: Record<DeployState, RowState> = { building: 'busy', ready: 'ok', error: 'error', canceled: 'idle' }

// The settings every deploy provider shares.
export type DeployConfig = { maxRows: number; slowMs: number; fastMs: number }

export function deployConfig(options: PluginOptions): DeployConfig {
  return {
    maxRows: Math.floor(num(options.deploy_max_rows, 15, 1)),
    slowMs: num(options.deploy_refresh_seconds, 60, 15) * 1000,
    fastMs: num(options.deploy_building_refresh_seconds, 10, 5) * 1000,
  }
}

export const newest = (deploys: Deploy[], max: number) =>
  [...deploys].sort((a, b) => b.createdAt - a.createdAt).slice(0, max)

export function deployRows(deploys: Deploy[], branch: string | undefined, now: number): ObserveRow[] {
  return deploys.map(d => {
    const mine = branch !== undefined && d.branch === branch
    return {
      id: d.id,
      state: ROW_STATES[d.state],
      label: d.state,
      title: d.name,
      tags: [
        { text: d.env, dimColor: true },
        ...(d.branch ? [{ text: d.branch, color: mine ? 'cyan' : undefined, bold: mine }] : []),
        ...(d.sha ? [{ text: d.sha.slice(0, SHA_LENGTH), dimColor: true }] : []),
        ...(d.who ? [{ text: d.who, color: 'magenta' }] : []),
      ],
      age: age(now - d.createdAt),
      sub: d.message,
      link: d.url,
      highlight: mine,
    }
  })
}

const isBuilding = (snap: Snapshot) => snap.rows.some(r => r.state === 'busy')

export const deployInterval = (snap: Snapshot, cfg: DeployConfig) => (isBuilding(snap) ? cfg.fastMs : cfg.slowMs)

export function deployView(snap: Snapshot): View {
  const building = snap.rows.filter(r => r.state === 'busy').length
  return {
    rows: snap.rows,
    summary: `${plural(snap.rows.length, 'deploy')}${building ? `, ${building} building` : ''}`,
    empty: 'No deploys found.',
  }
}

export const branchContext = (branch: string | undefined) => (branch ? `on ${branch}` : undefined)
