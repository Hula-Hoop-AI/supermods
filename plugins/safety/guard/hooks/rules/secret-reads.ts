import type { EngineInterface, Register } from 'claude-code'

import { normalizePath, parseSettings, protectedBy, reasonFor, targetsOf } from './secret-reads/policy'
import type { Mode, Settings } from './secret-reads/policy'

type Verdict = { mode: Exclude<Mode, 'off'>; reason: string }

const asArgs = (v: unknown): Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

// Where `path` really lands, following symlinks: the file's own real path, or for a
// file not there, its folder's real path plus the name.
async function realPathOf($: EngineInterface, path: string): Promise<string | undefined> {
  const own = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (own) return own.realPath
  const cut = path.lastIndexOf('/')
  if (cut <= 0) return undefined
  const dir = await $.fs.stat(path.slice(0, cut), { resolve: true }).catch(() => undefined)
  return dir?.realPath === undefined ? undefined : `${dir.realPath.replace(/\/$/, '')}${path.slice(cut)}`
}

async function verdictOf($: EngineInterface, settings: Settings, tool: string, args: Readonly<Record<string, unknown>>) {
  const mode = settings.mode
  if (mode === 'off') return undefined
  const targets = targetsOf(tool, args, settings.checkBash)
  if (targets.length === 0) return undefined
  const [cwd, home] = await Promise.all([$.session.cwd(), $.env.get('HOME')])
  for (const t of targets) {
    const path = normalizePath(t.raw, cwd, home)
    if (path === undefined) continue
    const paths = [path]
    if (t.resolvable) {
      const real = await realPathOf($, path)
      if (real !== undefined && real !== path) paths.push(real)
    }
    for (const p of paths) {
      const glob = protectedBy(settings, p, home)
      if (glob !== undefined) return { mode, reason: reasonFor(tool, mode, p, glob, home) } satisfies Verdict
    }
  }
  return undefined
}

// A guard that fails open leaks the file, so a check that throws refuses the call.
async function safeVerdict(
  $: EngineInterface, settings: Settings, tool: string, args: Readonly<Record<string, unknown>>,
): Promise<Verdict | undefined> {
  try {
    return await verdictOf($, settings, tool, args)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { mode: 'deny', reason: `${$.plugin.name} could not check this ${tool} call (${why}), so it was refused.` }
  }
}

export const secretReads: Register = (on, options) => {
  const settings = parseSettings(options)

  // No tool matcher: Glob and Grep are not in every build's tool list, so the hooks take
  // every call and targetsOf() answers nothing (no $ call) for tools it doesn't guard.

  // Deny mode: refuse before the permission path runs, whatever the permission mode.
  on('tool.call', async ($, e, next) => {
    const verdict = await safeVerdict($, settings, e.tool, asArgs(e))
    return verdict?.mode === 'deny' ? { deny: verdict.reason } : next(e)
  })

  // Ask mode: put the call to the permission prompt with the reason; deny answers too,
  // so a `$.tool.check` query reports what tool.call would do.
  on('tool.check', async ($, e, next) => {
    const verdict = await safeVerdict($, settings, e.tool, asArgs(e.input))
    return verdict ? { decision: verdict.mode, reason: verdict.reason } : next(e)
  })
}
