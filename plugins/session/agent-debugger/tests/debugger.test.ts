import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'agent-debugger'
const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: PLUGIN,
  props: { title: 'Debugger', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } },
} as any

const MESSAGES = [
  { role: 'user', text: 'hello', toolUses: [], handle: 'a' },
  { role: 'assistant', text: 'hi', toolUses: [], handle: 'b' },
]

// Stands for the engine beneath the mod. A hold polls `process.run`; here each
// poll waits at a gate the test opens with `pump`, so a hold moves only when told.
function engine(on: any) {
  mock.clock(on)
  let open = () => {}
  let gate = new Promise<void>(resolve => (open = resolve))
  let isWaiting = false
  let watchers: (() => void)[] = []
  on('process.run', async () => {
    isWaiting = true
    watchers.splice(0).forEach(tell => tell())
    await gate
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.messages', () => ({ value: MESSAGES.map(({ handle, ...row }) => row) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.list', () => ({ value: [{ name: 'Bash' }, { name: 'Edit' }, { name: 'mcp__x__y' }] }))
  return {
    held: () => (isWaiting ? Promise.resolve() : new Promise<void>(resolve => watchers.push(resolve))),
    pump: () => {
      isWaiting = false
      open()
      gate = new Promise(resolve => (open = resolve))
    },
  }
}

test('the pane draws every tab on each surface', async ($: any, on: any) => {
  engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const tab of ['breakpoints', 'events']) {
      await ui.press({ key: `tab:${tab}` })
      await ui.drawn()
    }
    await ui.press({ key: 'tab:breakpoints' })
    await ui.press({ key: 'bp-tool' })
    expect(await ui.find({ type: 'Button', text: /\[x\] tool call/ })).toBeDefined()
    await ui.press({ key: 'bp-tool' })
    await ui.press({ key: 'bp-tools' })
    await ui.press({ key: 'bp-tools-none' })
    expect(await ui.find({ type: 'Button', text: /\[ \] Bash/ })).toBeDefined()
    // Picking a tool with no tool event checked checks "tool call" with it.
    await ui.press({ key: 'bp-tool-Edit' })
    expect(await ui.find({ type: 'Button', text: /\[x\] tool call/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /breakpoints: tool call · Edit/ })).toBeDefined()
    await ui.press({ key: 'bp-tools-all' })
    expect(await ui.find({ type: 'Button', text: /\[x\] Bash/ })).toBeDefined()
    await ui.press({ key: 'bp-tools' })
    await ui.press({ key: 'bp-tool' })
    await ui.unmount()
  }
})

test('a held tool call runs with the edited argument, and skip refuses it', async ($: any, on: any) => {
  const { held, pump } = engine(on)
  const ran: any[] = []
  on('tool.call', (_$: any, e: any) => (ran.push(e), { result: { stdout: 'ok' }, text: 'ok' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'pause' })
  const edited = $.tool.call({ tool: 'Bash', command: 'ls' })
  await held()
  const field = await ui.find({ type: 'Input' })
  expect(field).toBeDefined()
  await ui.input({ key: field.key, text: 'ls -la', kind: 'change' })
  await ui.press({ key: 'step' })
  pump()
  // Step mode: the result is held too.
  await held()
  await ui.press({ key: 'step' })
  pump()
  await edited
  expect(ran[0].command).toBe('ls -la')

  // A value of several lines is a field per line; editing one line keeps the others.
  const lines = $.tool.call({ tool: 'Bash', command: 'echo a\necho b' })
  await held()
  const second = (await ui.findAll({ type: 'Input' }))[1]
  await ui.input({ key: second.key, text: 'echo c', kind: 'change' })
  await ui.press({ key: 'play' })
  pump()
  await lines
  expect(ran[1].command).toBe('echo a\necho c')
  await ui.press({ key: 'pause' })

  const skipped = $.tool.call({ tool: 'Bash', command: 'rm x' })
  await held()
  const skip = await ui.find({ type: 'Button', text: /Skip this call/ })
  await ui.press({ key: skip.key })
  pump()
  expect((await skipped).deny).toBeDefined()
  expect(ran).toHaveLength(2)

  await ui.press({ key: 'play' })
  await ui.unmount()
})

test('a breakpoint checked while an event is held counts for the next one', async ($: any, on: any) => {
  const { held, pump } = engine(on)
  on('tool.call', () => ({ result: { stdout: 'ok' }, text: 'ok' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab:breakpoints' })
  await ui.press({ key: 'bp-tool' })

  const call = $.tool.call({ tool: 'Bash', command: 'ls' })
  await held()
  await ui.press({ key: 'tab:breakpoints' })
  await ui.press({ key: 'bp-result' })
  await ui.press({ key: 'play' })
  pump()
  await held()
  expect(await ui.find({ type: 'Text', text: /PAUSED at tool result/ })).toBeDefined()
  await ui.press({ key: 'play' })
  pump()
  await call
  await ui.unmount()
})

test('a held tool call shows its arguments and Skip where the surface draws no fields', async ($: any, on: any) => {
  const { held, pump } = engine(on)
  on('tool.call', () => ({ result: { stdout: 'ok' }, text: 'ok' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await ui.press({ key: 'pause' })
  const call = $.tool.call({ tool: 'Bash', command: 'rm x' })
  await held()
  expect(await ui.find({ type: 'Text', text: /rm x/ })).toBeDefined()
  const skip = await ui.find({ type: 'Button', text: /Skip this call/ })
  await ui.press({ key: skip.key })
  pump()
  expect((await call).deny).toBeDefined()
  await ui.press({ key: 'play' })
  await ui.unmount()
})

test('a held response is shown as edited', async ($: any, on: any) => {
  const { held, pump } = engine(on)
  on('turn.step', async function* (_$: any, e: any) {
    yield { kind: 'text', index: 0, text: 'Hel' }
    yield { kind: 'text', index: 0, text: 'lo' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'Hello', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'pause' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'some-model', messageCount: 2 })
  const chunks: any[] = []
  const done = (async () => {
    let step = await stream.next()
    while (!step.done) {
      chunks.push(step.value)
      step = await stream.next()
    }
    return step.value
  })()
  await held()
  await ui.press({ key: 'step' })
  pump()
  await held()
  expect(chunks).toHaveLength(0)
  const field = await ui.find({ type: 'Input' })
  await ui.input({ key: field.key, text: 'Howdy', kind: 'change' })
  await ui.press({ key: 'play' })
  pump()
  const result = await done
  expect(chunks.filter(chunk => chunk.kind === 'text').map(chunk => chunk.text)).toEqual(['Howdy'])
  expect(result.answer).toBe('Howdy')
  await ui.unmount()
})

test('the filter hides kinds of events, but never the held one', async ($: any, on: any) => {
  const { held, pump } = engine(on)
  on('tool.call', () => ({ result: { stdout: 'ok' }, text: 'ok' }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await ui.drawn()
    expect(await ui.find({ type: 'Button', text: /#\d+ tool call ·/ })).toBeDefined()

    await ui.press({ key: 'filter:tool' })
    expect(await ui.find({ type: 'Button', text: /#\d+ tool call ·/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: /#\d+ tool result ·/ })).toBeDefined()
    await ui.press({ key: 'filter:result' })
    expect(await ui.find({ type: 'Text', text: /events are filtered out/ })).toBeDefined()

    await ui.press({ key: 'pause' })
    const call = $.tool.call({ tool: 'Bash', command: 'pwd' })
    await held()
    expect(await ui.find({ type: 'Button', text: /⏸ tool call ·/ })).toBeDefined()
    // The held event opens to the conversation the model had before it.
    await ui.press({ key: 'ctx-toggle' })
    expect(await ui.find({ type: 'Text', text: /#0 USER/ })).toBeDefined()
    await ui.press({ key: 'play' })
    pump()
    await call
    expect(await ui.find({ type: 'Button', text: /#\d+ tool call ·/ })).toBeUndefined()

    await ui.press({ key: 'filter:tool' })
    await ui.press({ key: 'filter:result' })
    expect(await ui.find({ type: 'Button', text: /#\d+ tool call ·/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a tool breakpoint stops only the picked tool, turn after turn', async ($: any, on: any) => {
  const { held, pump } = engine(on)
  on('tool.call', () => ({ result: { stdout: 'ok' }, text: 'ok' }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab:breakpoints' })
  await ui.press({ key: 'bp-tools' })
  await ui.press({ key: 'bp-tools-none' })
  await ui.press({ key: 'bp-tool-Edit' })

  for (const turn of ['t1', 't2']) {
    await $.turn.start({ turnId: turn, text: 'go' })
    // Bash is not picked: it runs straight through.
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    const edit = $.tool.call({ tool: 'Edit', file_path: 'a', old_string: 'b', new_string: 'c' })
    await held()
    await ui.press({ key: 'play' })
    pump()
    await edit
    await $.turn.complete({ turnId: turn, reason: 'answer', answer: '', durationMs: 5, isAborted: false })
  }

  await ui.unmount()
})
