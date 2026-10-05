import type { PluginOptions } from 'claude-code'

import type { Io } from '../io'
import type { ObserveRow, ProviderId, Snapshot } from '../../types'
import { list } from '../util'
import { docker, fetchDocker } from './docker'
import type { DockerConfig } from './docker'
import { fetchModal, modal } from './modal'
import type { ModalConfig } from './modal'
import { fetchRender, render } from './render'
import type { RenderConfig } from './render'
import { fetchVercel, vercel } from './vercel'
import type { VercelConfig } from './vercel'

export type Toggle = { key: string; on: string; off: string }

export type View = { rows: ObserveRow[]; summary: string; empty: string }

type Configs = { docker: DockerConfig; modal: ModalConfig; render: RenderConfig; vercel: VercelConfig }

// A provider shapes data; the pane, the polling and the toasts are shared.
export type ProviderOf<I extends ProviderId> = {
  id: I
  title: string
  config: Configs[I]
  intervalMs: (snap: Snapshot) => number
  view: (snap: Snapshot, isOn: (toggle: string) => boolean) => View
  toggles?: (snap: Snapshot) => Toggle[]
  footnote?: string
}
export type Provider = { [I in ProviderId]: ProviderOf<I> }[ProviderId]

// `force` is a refresh the person asked for: skip whatever the provider would reuse.
export function fetchProvider(io: Io, p: Provider, prev: Snapshot, force: boolean): Promise<Snapshot> {
  if (p.id === 'docker') return fetchDocker(io, p.config)
  if (p.id === 'modal') return fetchModal(io, p.config, prev, force)
  if (p.id === 'render') return fetchRender(io, p.config, prev, force)
  return fetchVercel(io, p.config)
}

const FACTORIES: Record<ProviderId, (options: PluginOptions) => Provider> = { docker, modal, render, vercel }
export const PROVIDER_IDS = Object.keys(FACTORIES) as ProviderId[]

const isProviderId = (s: string): s is ProviderId => s in FACTORIES

// The tabs, in the order the `providers` setting names them; every provider when it names none.
export function buildProviders(options: PluginOptions): Provider[] {
  const wanted = [...new Set(list(options.providers).map(s => s.toLowerCase()).filter(isProviderId))]
  return (wanted.length ? wanted : PROVIDER_IDS).map(id => FACTORIES[id](options))
}
