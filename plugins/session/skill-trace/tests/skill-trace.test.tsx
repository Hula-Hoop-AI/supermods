import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// The model's skill listing, as /context breaks it down.
const LISTED = [
  { name: 'superpowers:brainstorming', source: 'plugin', pluginName: 'superpowers', tokens: 50 },
  { name: 'commit', source: 'userSettings', tokens: 20 },
  { name: 'alpha', source: 'userSettings', tokens: 5 },
  { name: 'beta', source: 'userSettings', tokens: 5 },
  { name: 'gamma', source: 'userSettings', tokens: 5 },
]

// Stands in for the engine: the prompt count, the skill listing, a skill's own prompt,
// and a typed command (a skill's command expands its prompt; any other prints "ran").
function engine($: Engine, on: On, turns = { n: 1 }) {
  on('session.turns', async () => ({ value: turns.n }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { breakdown: { skills: { skillFrontmatter: LISTED } } } },
  }) as never)
  on('skill.prompt', async (_, e) => ({ text: e.text }))
  on('command.run', async (_, e) => {
    if (LISTED.some(s => s.name === e.command)) await $.skill.prompt({ skill: e.command, text: 'y'.repeat(800) })
    return { text: 'ran' }
  })
  return turns
}

// The Skill tool as the engine runs it: expands the skill's prompt, then answers.
function skillTool($: Engine, on: On, opts: { forked?: boolean; deny?: string } = {}) {
  on('tool.call', async (_, e) => {
    if (opts.deny) return { deny: opts.deny }
    const skill = e.tool === 'Skill' ? e.skill : ''
    await $.skill.prompt({ skill, text: 'x'.repeat(4000) })
    return {
      result: opts.forked
        ? { success: true, commandName: skill, status: 'forked', agentId: 'a1', result: 'done' }
        : { success: true, commandName: skill },
    } as never
  })
}

const callSkill = ($: Engine, skill: string, args?: string) =>
  $.tool.call({ tool: 'Skill', skill, args } as never)

const typeSkill = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never)

const mount = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'skill-trace', surface, component: 'Pane',
    props: { title: 'Skill trace', isFocused: false } as never, requestId: 'skill-trace',
  })

// The pane's entry rows, top to bottom (each row is one Text holding the whole line).
type Ui = Awaited<ReturnType<typeof mount>>
const entryLines = async (ui: Ui) =>
  (await ui.findAll({ type: 'Text', text: /^\d\d:\d\d:\d\d t\d+ (user|model|other)/ })).map(t => t.text)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`records a model Skill call with args, source, size and turn on ${surface}`, async ($, on) => {
    engine($, on, { n: 3 })
    skillTool($, on)
    await callSkill($, 'superpowers:brainstorming', 'design a cache')
    const ui = await mount($, surface)
    expect(await ui.find({ text: /1 skill load\b/ })).toBeDefined()
    expect(await entryLines(ui)).toEqual([
      expect.stringMatching(/ t3 model superpowers:brainstorming plugin:superpowers ~1\.0k tok "design a cache"$/),
    ])
  })

  test(`records a typed /skill as the user's, on the turn it starts, on ${surface}`, async ($, on) => {
    engine($, on, { n: 2 })
    await typeSkill($, 'commit', 'fix typo')
    const ui = await mount($, surface)
    expect(await entryLines(ui)).toEqual([expect.stringMatching(/ t3 user {2}commit userSettings ~200 tok "fix typo"$/)])
  })

  test(`ignores commands that are not skills on ${surface}`, async ($, on) => {
    engine($, on)
    const r = await typeSkill($, 'compact')
    expect(JSON.stringify(r)).toMatch(/ran/)
    const ui = await mount($, surface)
    expect(await ui.find({ text: /No skills loaded yet/ })).toBeDefined()
  })

  test(`a skill prompt with no call or command behind it is "other" on ${surface}`, async ($, on) => {
    engine($, on)
    await $.skill.prompt({ skill: 'superpowers:brainstorming', text: 'abcd' })
    const ui = await mount($, surface)
    expect(await entryLines(ui)).toEqual([expect.stringMatching(/ t1 other superpowers:brainstorming plugin:superpowers ~1 tok$/)])
  })

  test(`marks forked skills on ${surface}`, async ($, on) => {
    engine($, on)
    skillTool($, on, { forked: true })
    await callSkill($, 'review')
    const ui = await mount($, surface)
    expect(await ui.find({ text: /model review.*forked/ })).toBeDefined()
  })

  test(`a denied Skill call is recorded as failed, with no source or size, on ${surface}`, async ($, on) => {
    engine($, on)
    skillTool($, on, { deny: 'not allowed here' })
    await callSkill($, 'deploy', 'prod')
    const ui = await mount($, surface)
    expect(await entryLines(ui)).toEqual([expect.stringMatching(/model deploy denied: not allowed here "prod"$/)])
  })

  test(`keeps loads in order and counts per skill on ${surface}`, async ($, on) => {
    const turns = engine($, on, { n: 0 })
    skillTool($, on)
    await typeSkill($, 'commit') // starts turn 1
    turns.n = 1
    await callSkill($, 'superpowers:brainstorming') // during turn 1
    await typeSkill($, 'commit') // starts turn 2
    const ui = await mount($, surface)
    expect(await ui.find({ text: /3 skill loads · 2 skills/ })).toBeDefined()
    expect(await ui.find({ text: /^commit ×2 {2}superpowers:brainstorming ×1$/ })).toBeDefined()
    const lines = await entryLines(ui)
    expect(lines.map(l => l.match(/t\d (user|model) +\S+/)?.[0])).toEqual([
      't1 user  commit', 't1 model superpowers:brainstorming', 't2 user  commit',
    ])
  })

  test(`the Clear button empties the trace on ${surface}`, async ($, on) => {
    engine($, on)
    await typeSkill($, 'commit')
    const ui = await mount($, surface)
    await ui.press({ key: 'clear' })
    expect(await ui.find({ text: /No skills loaded yet/ })).toBeDefined()
    expect(await ui.find({ text: /×1/ })).toBeUndefined()
    expect(await entryLines(ui)).toEqual([])
  })

  test(`maxEntries bounds the list but not the counts on ${surface}`, { options: { maxEntries: 2 } }, async ($, on) => {
    engine($, on)
    for (const s of ['alpha', 'beta', 'gamma']) await typeSkill($, s)
    const ui = await mount($, surface)
    expect(await ui.find({ text: /3 skill loads/ })).toBeDefined()
    const lines = await entryLines(ui)
    expect(lines.map(l => l.match(/user +(\w+)/)?.[1])).toEqual(['beta', 'gamma'])
    expect(await ui.find({ text: /^alpha ×1 {2}beta ×1 {2}gamma ×1$/ })).toBeDefined()
  })

  test(`showArgs off records no arguments on ${surface}`, { options: { showArgs: false } }, async ($, on) => {
    engine($, on)
    skillTool($, on)
    await callSkill($, 'commit', 'secret-ish args')
    await typeSkill($, 'commit', 'typed secret')
    const ui = await mount($, surface)
    expect(await entryLines(ui)).toHaveLength(2)
    expect(await ui.find({ text: /secret/ })).toBeUndefined()
  })
}

test('long args are truncated', async ($, on) => {
  engine($, on)
  skillTool($, on)
  await callSkill($, 'commit', 'y'.repeat(500))
  const ui = await mount($, 'terminal')
  const [line] = await entryLines(ui)
  expect(line).toMatch(/"y{79}…"$/)
})

test('/skill-trace opens the pane and reports the count, unrecorded itself', async ($, on) => {
  engine($, on)
  const opened: string[] = []
  on('ui.open', async (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  await typeSkill($, 'commit')
  const r = await typeSkill($, 'skill-trace')
  expect(opened).toEqual(['skill-trace'])
  expect(JSON.stringify(r)).toMatch(/1 skill load this session/)
})

test('the status line is off by default', async ($, on) => {
  engine($, on)
  const status: (string | undefined)[] = []
  on('ui.status', async (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  await typeSkill($, 'commit')
  expect(status.filter(s => s !== undefined)).toEqual([])
})

test('statusLine shows the count and Clear removes it', { options: { statusLine: true } }, async ($, on) => {
  engine($, on)
  const status: (string | undefined)[] = []
  on('ui.status', async (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  await typeSkill($, 'commit')
  await typeSkill($, 'commit')
  expect(status.at(-1)).toBe('skills: 2')
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'clear' })
  expect(status.at(-1)).toBeUndefined()
})

test('observes only: skill text, command output and Skill result pass through unchanged', async ($, on) => {
  engine($, on)
  skillTool($, on)
  expect((await $.skill.prompt({ skill: 'commit', text: 'exact text' })).text).toBe('exact text')
  expect(JSON.stringify(await typeSkill($, 'commit'))).toMatch(/"text":"ran"/)
  expect(JSON.stringify(await callSkill($, 'commit'))).toMatch(/"commandName":"commit"/)
})
