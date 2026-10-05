import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const DESTRUCTIVE = 'git branch -D old'

// Beneath the plugin: tools that report they ran, no room for the pane and a dismissed
// question dialog, so a hold shows up as a deny; `opened` counts the holds offered.
function machine(on: On) {
  const now = { opened: 0 }
  mock.env(on, { HOME: '/home/u' })
  on('session.cwd', async () => ({ value: '/home/u/proj' }))
  on('fs.stat', async () => ({ deny: 'ENOENT' }))
  on('tool.call', async (_$, e) => {
    if (e.tool === 'AskUserQuestion') throw new Error('dismissed')
    return { result: 'ran' as never }
  })
  on('tool.check', async () => ({ decision: 'allow' as const }))
  on('ui.open', async () => {
    now.opened += 1
    return { value: { isPlaced: false as const, reason: 'narrow' } }
  })
  on('ui.close', async () => ({ value: undefined }))
  return now
}

test('both rule sets are on by default', async ($, on) => {
  const now = machine(on)
  expect((await $.tool.call({ tool: 'Read', file_path: '.env' })).deny).toMatch(/protected pattern/)
  expect((await $.tool.call({ tool: 'Bash', command: DESTRUCTIVE })).deny).toMatch(/force branch delete/)
  expect(now.opened).toBe(1)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls -la' })).deny).toBeUndefined()
})

test('a destructive command that reads a secret is denied before a hold is offered', async ($, on) => {
  const now = machine(on)
  expect((await $.tool.call({ tool: 'Bash', command: 'rm -rf ~/.ssh' })).deny).toMatch(/protected pattern/)
  expect(now.opened).toBe(0)
})

test('destructive_bash: false holds nothing and still blocks secret reads', { options: { destructive_bash: false } }, async ($, on) => {
  const now = machine(on)
  expect((await $.tool.call({ tool: 'Bash', command: DESTRUCTIVE })).deny).toBeUndefined()
  expect(now.opened).toBe(0)
  expect((await $.tool.call({ tool: 'Bash', command: 'cat .env' })).deny).toMatch(/protected pattern/)
  expect((await $.tool.check({ tool: 'Read', input: { file_path: '.env' } })).decision).toBe('deny')
})

test('secret_reads: false allows secret reads and still holds destructive commands', { options: { secret_reads: false } }, async ($, on) => {
  const now = machine(on)
  expect((await $.tool.call({ tool: 'Read', file_path: '.env' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'cat .env' })).deny).toBeUndefined()
  expect((await $.tool.check({ tool: 'Read', input: { file_path: '.env' } })).decision).toBe('allow')
  expect((await $.tool.call({ tool: 'Bash', command: DESTRUCTIVE })).deny).toMatch(/nobody could be asked/)
  expect(now.opened).toBe(1)
})

test('both switches off leave every call alone', { options: { destructive_bash: false, secret_reads: false } }, async ($, on) => {
  const now = machine(on)
  expect((await $.tool.call({ tool: 'Bash', command: 'rm -rf ~/.ssh' })).deny).toBeUndefined()
  expect(now.opened).toBe(0)
})
