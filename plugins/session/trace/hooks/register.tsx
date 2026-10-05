import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Ledger, Tab, View } from '../types'
import { asLedger, EMPTY as NO_SOURCES } from './recorders/ledger'
import { EMPTY as NO_SKILLS, recordSkills, skillsModel, skillsReport, statusText } from './recorders/skills'
import {
  citations, historyKey, recordSources, shownView, sourcesModel, sourcesReport,
} from './recorders/sources'
import type { TabModel } from './recorders/tab'
import { tabPane } from './tab-pane'

const PANE = 'trace'
const COMMAND = 'trace'
const TITLE = 'Trace'
const TABS: { id: Tab; title: string }[] = [
  { id: 'skills', title: 'Skills' },
  { id: 'sources', title: 'Sources' },
]
const tab = atom({ plugin: 'trace', key: 'tab' } as const, 'skills' as Tab)
// The recorders' atoms, named again: the validator reads a state reference only in the file that uses it.
const trace = atom({ plugin: 'trace', key: 'skills' } as const, NO_SKILLS)
const ledger = atom({ plugin: 'trace', key: 'ledger' } as const, NO_SOURCES)
const view = atom({ plugin: 'trace', key: 'view' } as const, 'session' as View)

const tabOf = (id: string) => TABS.find(t => t.id === id)

// Every function that takes `$` lives in this file: the validator follows `$` no further.
async function copy($: EngineInterface, text: string, surface: RenderSurface) {
  const r = await $.ui.copy({ text, surface })
  $.ui.toast(r.isCopied ? `Copied ${text}` : `Could not copy (${r.reason})`)
}

async function clearSkills($: EngineInterface) {
  await update($, trace, () => NO_SKILLS)
  $.ui.status(undefined)
}

async function loadHistory($: EngineInterface) {
  return asLedger(await $.store.get(historyKey(await $.session.root())))
}

async function insertCitations($: EngineInterface, shown: Ledger) {
  const cited = citations(shown)
  if ('none' in cited) return $.ui.toast(cited.none)
  const { isFilled } = await $.prompt.fill({ text: cited.text, mode: 'insert' })
  if (!isFilled) $.ui.toast("trace: the prompt box didn't take the citations")
}

async function clearSources($: EngineInterface, current: View) {
  if (current === 'project') {
    await $.store.delete(historyKey(await $.session.root()))
    $.ui.invalidate('ui.render')
  } else {
    await update($, ledger, () => NO_SOURCES)
  }
}

async function skillsTab($: EngineInterface, since: number) {
  return skillsModel(await read($, trace), since, () => void clearSkills($))
}

async function sourcesTab($: EngineInterface, since: number) {
  const session = await read($, ledger) // read in every view, so a new source redraws the pane
  const current = shownView(await read($, view))
  const shown = current === 'project' ? await loadHistory($) : session
  return sourcesModel(shown, current, since, {
    insert: () => void insertCitations($, shown),
    clear: () => void clearSources($, current),
    toggleView: () => void update($, view, v => (v === 'project' ? 'session' : 'project')),
  })
}

async function report($: EngineInterface, active: Tab, isPlaced: boolean) {
  return active === 'skills' ? skillsReport(await read($, trace)) : sourcesReport(await read($, ledger), isPlaced)
}

export const register: Register = (on, options) => {
  recordSkills(on, options)
  recordSources(on, options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the skills that loaded and the web sources Claude consulted this session',
      argumentHint: `[${TABS.map(t => t.id).join('|')}]`,
      immediate: true,
    })
    // After a reload (a settings change), match the status line to the setting.
    $.ui.status(statusText(await read($, trace)))
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const asked = tabOf(arg)
    if (arg && !asked) return { text: `/${COMMAND}: no "${arg}" tab. Use ${TABS.map(t => t.id).join(' or ')}.` }
    const active = asked ? await update($, tab, () => asked.id) : await read($, tab)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    return {
      text: opened.isPlaced
        ? `${TITLE} pane opened on ${tabOf(active)?.title}: ${await report($, active, true)}`
        : `The ${TITLE} pane is open, but this surface is not showing it: ${opened.reason}\n${await report($, active, false)}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const active = await read($, tab)
    const since = await $.session.usage().then(u => u.startedAt, () => Date.now())
    const model: TabModel = active === 'skills' ? await skillsTab($, since) : await sourcesTab($, since)
    return tabPane($.ui.resolve(e), e.viewport, {
      ...model,
      tabs: TABS,
      activeTab: active,
      onTab: id => {
        const to = tabOf(id)
        if (to) void update($, tab, () => to.id)
      },
      onCopy: (text, surface) => void copy($, text, surface),
    })
  })
}
