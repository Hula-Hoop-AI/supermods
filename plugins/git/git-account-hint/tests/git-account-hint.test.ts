import { expect, test } from 'claude-code/testing'

const GH_STATUS = `github.com
  ✓ Logged in to github.com account alice (keyring)
  - Active account: true
  ✓ Logged in to github.com account bob (keyring)
  - Active account: false
`

// Stands for the engine: Bash answers `output`, and gh lists `status` (null: gh is not installed).
function engine(on: any) {
  const now: { output: string; status: string | null } = { output: '', status: GH_STATUS }
  on('tool.call', () => ({ result: { stdout: now.output }, text: now.output }))
  on('process.run', () => {
    if (now.status === null) throw new Error('gh: command not found')
    return { value: { exitCode: 0, stdout: now.status, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return now
}

const REFUSED = [
  ['git push origin main', 'ERROR: Permission to o/r.git denied to alice.\nfatal: Could not read from remote repository.'],
  ['cd repo && git fetch', "fatal: could not read Username for 'https://github.com': Device not configured"],
  ['git clone https://github.com/o/private.git', 'remote: Repository not found.\nfatal: repository not found'],
  ['git pull', 'fatal: unable to access: The requested URL returned error: 403'],
] as const

test('a refused git command tells Claude the other signed-in accounts', async ($: any, on: any) => {
  const now = engine(on)
  for (const [command, output] of REFUSED) {
    now.output = output
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect(ran.text).toBe(output)
    expect(ran.context).toHaveLength(1)
    expect(ran.context[0]).toContain('bob')
    expect(ran.context[0]).toContain('gh auth token --user <account>')
  }
})

test('the refused account is not offered back', async ($: any, on: any) => {
  engine(on).output = REFUSED[0][1]
  const [hint] = (await $.tool.call({ tool: 'Bash', command: REFUSED[0][0] })).context
  expect(hint).toContain('the account alice')
  expect(hint).not.toContain('alice (active')
})

test('with no other account, or no gh, it says so', async ($: any, on: any) => {
  const now = engine(on)
  now.output = REFUSED[0][1]
  now.status = 'github.com\n  ✓ Logged in to github.com account alice (keyring)\n'
  expect((await $.tool.call({ tool: 'Bash', command: 'git push' })).context[0]).toContain('no other account')
  now.status = null
  expect((await $.tool.call({ tool: 'Bash', command: 'git push' })).context[0]).toContain('no other account')
})

test('everything else passes untouched', async ($: any, on: any) => {
  const now = engine(on)
  now.output = 'Everything up-to-date'
  expect((await $.tool.call({ tool: 'Bash', command: 'git push' })).context).toBeUndefined()
  // The words of a refusal in a command that is not git.
  now.output = 'Repository not found'
  expect((await $.tool.call({ tool: 'Bash', command: 'cat notes.txt' })).context).toBeUndefined()
})
