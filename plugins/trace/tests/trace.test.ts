import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

const mount = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({
    plugin: 'trace', surface, component: 'Pane',
    props: { title: 'Trace', isFocused: false } as never, requestId: 'trace',
  })

function stubTools(on: On) {
  on('session.turns', () => ({ value: 1 }))
  on('tool.call', (_, e) => ({ result: e.tool === 'Skill' ? { success: true, commandName: e.skill } : { code: 200 } }) as never)
}

// One skill load and one fetched page, so each tab has something only it shows.
async function recordBoth($: Engine) {
  await $.tool.call({ tool: 'Skill', skill: 'commit' } as never)
  await $.tool.call({ tool: 'WebFetch', url: 'https://docs.python.org/3/', prompt: 'summarize' })
}

function panes(on: On, placed: { isPlaced: true } | { isPlaced: false; reason: string } = { isPlaced: true }) {
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(`${e.id}:${e.title}`)
    return { value: placed }
  })
  return opened
}

const trace = ($: Engine, args = '') => $.command.run({ command: 'trace', args } as never)

for (const surface of SURFACES) {
  test(`opens on Skills and the tab buttons switch the view on ${surface}`, async ($, on) => {
    stubTools(on)
    await recordBoth($)
    const ui = await mount($, surface)
    expect(await ui.find({ text: /^1 skill load · 1 skill$/ })).toBeDefined()
    expect(await ui.find({ text: /1 page fetched/ })).toBeUndefined()
    await ui.press({ key: 'tab:sources' })
    expect(await ui.find({ text: /^1 page fetched · 0 search results seen · 0 searches · this session$/ })).toBeDefined()
    expect(await ui.find({ text: /skill load/ })).toBeUndefined()
    await ui.press({ key: 'tab:skills' })
    expect(await ui.find({ text: /^1 skill load · 1 skill$/ })).toBeDefined()
  })

  test(`both recorders record while the other tab shows on ${surface}`, async ($, on) => {
    stubTools(on)
    await recordBoth($)
    const ui = await mount($, surface)
    await ui.press({ key: 'tab:sources' })
    await $.tool.call({ tool: 'Skill', skill: 'review' } as never)
    await ui.press({ key: 'tab:skills' })
    expect(await ui.find({ text: /^2 skill loads · 2 skills$/ })).toBeDefined()
    await $.tool.call({ tool: 'WebFetch', url: 'https://a.com/x', prompt: 'p' })
    await ui.press({ key: 'tab:sources' })
    expect(await ui.find({ text: /^2 pages fetched/ })).toBeDefined()
  })

  test(`an empty tab says so and is never left checking on ${surface}`, async $ => {
    const ui = await mount($, surface)
    expect(await ui.find({ text: 'No skills loaded yet.' })).toBeDefined()
    await ui.press({ key: 'tab:sources' })
    expect(await ui.find({ text: /^No web sources yet\. WebFetch, WebSearch calls show up here\.$/ })).toBeDefined()
    expect(await ui.find({ text: /Checking/ })).toBeUndefined()
    expect(await ui.find({ text: /^updated / })).toBeDefined()
  })

  test(`/trace sources and /trace skills pick the tab the pane shows on ${surface}`, async ($, on) => {
    stubTools(on)
    const opened = panes(on)
    await recordBoth($)
    const ui = await mount($, surface)
    expect((await trace($, 'sources')).text).toMatch(/^Trace pane opened on Sources: 1 page fetched/)
    expect(await ui.find({ text: /^1 page fetched/ })).toBeDefined()
    expect((await trace($, ' Skills ')).text).toBe('Trace pane opened on Skills: 1 skill load this session.')
    expect(await ui.find({ text: /^1 skill load · 1 skill$/ })).toBeDefined()
    expect(opened).toEqual(['trace:Trace', 'trace:Trace'])
  })

  test(`a row's copy button copies the source's URL on ${surface}`, async ($, on) => {
    stubTools(on)
    const copied: string[] = []
    on('ui.copy', (_, e) => {
      copied.push(e.text)
      return { value: { isCopied: true as const } }
    })
    const toasts: string[] = []
    on('ui.toast', (_, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    await recordBoth($)
    const ui = await mount($, surface)
    await ui.press({ key: 'tab:sources' })
    await ui.press({ key: 'copy:fetched:https://docs.python.org/3' })
    expect(copied).toEqual(['https://docs.python.org/3'])
    expect(toasts).toEqual(['Copied https://docs.python.org/3'])
  })
}

test('/trace with no argument opens on Skills first, then on the last tab shown', async ($, on) => {
  stubTools(on)
  panes(on)
  await recordBoth($)
  expect((await trace($)).text).toMatch(/^Trace pane opened on Skills: /)
  await trace($, 'sources')
  expect((await trace($)).text).toMatch(/^Trace pane opened on Sources: /)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'tab:skills' })
  expect((await trace($)).text).toMatch(/^Trace pane opened on Skills: /)
})

test('/trace with an unknown argument names the valid ones and opens nothing', async ($, on) => {
  const opened = panes(on)
  expect((await trace($, 'web')).text).toBe('/trace: no "web" tab. Use skills or sources.')
  expect(opened).toEqual([])
  expect((await trace($)).text).toMatch(/^Trace pane opened on Skills: /) // the tab did not move
})

test('/trace says why the pane is not showing, with the tab it would show', async ($, on) => {
  stubTools(on)
  panes(on, { isPlaced: false, reason: 'the terminal is 90 columns wide' })
  await recordBoth($)
  expect((await trace($, 'skills')).text).toBe(
    'The Trace pane is open, but this surface is not showing it: the terminal is 90 columns wide\n1 skill load this session.',
  )
})
