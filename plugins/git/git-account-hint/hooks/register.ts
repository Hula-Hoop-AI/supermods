import type { EngineInterface, Register } from 'claude-code'

const GIT = /(^|[\s;&|(])git\s/
// What git prints when GitHub refuses the account it authenticated as, or finds none to use.
const REFUSALS = [
  /Permission to \S+ denied to (?<account>[\w-]+)/,
  /could not read Username for 'https:\/\/github\.com/,
  /Authentication failed for 'https:\/\/github\.com/,
  /The requested URL returned error: 403/,
  /Repository not found/,
  /Permission denied \(publickey\)/,
]
const SIGNED_IN = /Logged in to \S+ account (?<name>\S+)/
const AS_ACCOUNT = `-c credential.helper= -c credential.helper='!f() { echo username=<account>; echo "password=$(gh auth token --user <account>)"; }; f'`

type Account = { name: string; isActive: boolean }

function parseAccounts(status: string): Account[] {
  const accounts: Account[] = []
  for (const line of status.split('\n')) {
    const name = SIGNED_IN.exec(line)?.groups?.name
    if (name !== undefined) accounts.push({ name, isActive: false })
    const last = accounts[accounts.length - 1]
    if (last !== undefined && line.includes('Active account: true')) last.isActive = true
  }
  return accounts
}

async function signedInAccounts($: EngineInterface): Promise<Account[]> {
  try {
    const status = await $.process.run(['gh', 'auth', 'status'])
    return parseAccounts(`${status.stdout}\n${status.stderr}`)
  } catch {
    return []
  }
}

function hintFor(plugin: string, accounts: Account[], refused: string | undefined): string {
  const others = accounts.filter(account => account.name !== refused)
  const who = refused === undefined ? 'the account it used' : `the account ${refused}`
  if (others.length === 0) {
    return `${plugin}: GitHub refused this git command for ${who}, and no other account is signed in to gh on this machine. Tell the user; \`gh auth login\` signs another one in.`
  }
  const names = others.map(account => `${account.name}${account.isActive ? ' (active in gh)' : ''}`).join(', ')
  return (
    `${plugin}: GitHub refused this git command for ${who}. Other accounts signed in to gh on this machine: ${names}. ` +
    `To run the command as one of them without changing the active account, use the repository's https URL and put these options right after \`git\`: ${AS_ACCOUNT}. ` +
    'Tell the user which account you used.'
  )
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || !GIT.test(String(e.command ?? ''))) return ran
    const refusal = REFUSALS.map(pattern => pattern.exec(ran.text ?? '')).find(match => match !== null)
    if (refusal === undefined || refusal === null) return ran

    const hint = hintFor($.plugin.name, await signedInAccounts($), refusal.groups?.account)
    return { ...ran, context: [...(ran.context ?? []), hint] }
  })
}
