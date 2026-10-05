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
  mock.store(on)
  on('session.id', () => ({ value: 'session-1' }))
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
  on('session.usage', () => ({ value: { startedAt: 0, context: { percent: 5, tokens: 100, window: 2000 }, rateLimits: [] } }))
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
      await ui.press({ key: `tab-${tab}` })
      await ui.drawn()
    }
    await ui.press({ key: 'tab-breakpoints' })
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

test('re-run from here resets the conversation through the mod and sends the prompt', async ($: any, on: any) => {
  const { held, pump } = engine(on)
  const prompts: string[] = []
  let compacted: any
  // Beneath the mod: reached only when the mod's own session.compact hook did not answer.
  on('session.compact', () => ({ skip: 'the engine was reached' }))
  // The engine's /compact: a manual compaction over the live conversation.
  on('command.run', { command: 'compact' }, async () => {
    compacted = await $.session.compact({ trigger: 'manual', messages: MESSAGES })
    return {}
  })
  on('prompt.submit', (_$: any, e: any) => (prompts.push(e.text), { text: e.text }))
  on('tool.call', () => ({ result: { stdout: 'ok' }, text: 'ok' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'pause' })
  const call = $.tool.call({ tool: 'Bash', command: 'ls' })
  await held()
  await ui.press({ key: 'ctx-toggle' })
  expect(await ui.find({ type: 'Text', text: /#0 USER/ })).toBeDefined()
  // A held event offers no re-run; one picked from the list afterwards does.
  expect(await ui.find({ key: 'rerun-open' })).toBeUndefined()
  await ui.press({ key: 'step' })
  pump()
  await held()
  const first = await ui.find({ type: 'Button', text: /tool call/ })
  await ui.press({ key: first.key })
  await ui.press({ key: 'rerun-open' })
  expect(await ui.find({ type: 'Text', text: /resets the session/ })).toBeDefined()
  await ui.input({ key: 'rerun-prompt', text: 'go on', kind: 'change' })
  await ui.press({ key: 'rerun-go' })
  pump()
  // The call had already run and was held at its result; the re-run lets the hold go.
  await call
  expect(await ui.find({ type: 'Text', text: /Could not re-run/ })).toBeUndefined()
  // The kept messages are the engine's own, untouched.
  expect(compacted.messages).toEqual(MESSAGES)
  expect(prompts).toEqual(['go on'])
  // The held tool call was at the point, so it is gone from the list; the re-run is noted.
  expect(await ui.find({ type: 'Button', text: /tool call|tool result/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /re-ran from/ })).toBeDefined()
  await ui.unmount()
})

test('a tool breakpoint stops only the picked tool, turn after turn', async ($: any, on: any) => {
  const { held, pump } = engine(on)
  on('tool.call', () => ({ result: { stdout: 'ok' }, text: 'ok' }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-breakpoints' })
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
