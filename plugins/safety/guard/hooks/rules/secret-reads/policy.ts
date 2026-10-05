// Pure logic: which paths a tool call touches, how they resolve, and whether a
// protected glob covers them. No `$` here, so all of it is unit-testable.

import type { PluginOptions } from 'claude-code'

import { matchGlob } from './glob'

export const DEFAULT_PROTECTED: readonly string[] = [
  '~/.ssh/**',
  '~/.aws/credentials',
  '~/.config/gcloud/**',
  '~/.netrc',
  '~/.docker/config.json',
  '~/.kube/config',
  '~/.config/gh/hosts.yml',
  '**/.git-credentials',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/*.p12',
  '**/*.pfx',
  '**/credentials.json',
  '**/.npmrc',
  '**/.pypirc',
]

export const DEFAULT_ALLOWED: readonly string[] = [
  '**/.env.example',
  '**/.env.sample',
  '**/.env.template',
  '**/*.pub',
]

export type Mode = 'deny' | 'ask' | 'off'

export type Settings = {
  protected: readonly string[]
  allowed: readonly string[]
  checkBash: boolean
  mode: Mode
}

const MODES: readonly Mode[] = ['deny', 'ask', 'off']


// Words of these programs are text, not paths: `echo .env >> .gitignore` is fine.
const TEXT_PROGRAMS = new Set(['echo', 'printf'])
const MAX_BASH_WORDS = 500

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
    .filter((s): s is string => typeof s === 'string')
    .map(s => s.trim())
    .filter(Boolean)
const mode = (v: unknown): Mode => (MODES.find(m => m === v) ?? 'deny')

export function parseSettings(options: PluginOptions): Settings {
  return {
    protected: [...DEFAULT_PROTECTED, ...list(options.secrets_protected)],
    allowed: [...DEFAULT_ALLOWED, ...list(options.secrets_allowed)],
    checkBash: options.secrets_check_bash !== false,
    mode: mode(options.secrets_mode),
  }
}

// A glob made absolute: `~/x` under home; `/x` as is; anything else at any depth.
export function anchorGlob(glob: string, home: string | undefined): string | undefined {
  if (glob === '~' || glob.startsWith('~/')) return home === undefined ? undefined : home + glob.slice(1)
  if (glob.startsWith('/') || glob.startsWith('**/')) return glob
  return `**/${glob}`
}

// An absolute, `.`/`..`-free path, or undefined when it can't be placed
// (`~user/...`, `~` with no HOME, empty).
export function normalizePath(raw: string, cwd: string, home: string | undefined): string | undefined {
  let p = raw.trim()
  if (p === '') return undefined
  if (p === '~' || p.startsWith('~/')) {
    if (home === undefined) return undefined
    p = home + p.slice(1)
  } else if (p.startsWith('~')) {
    return undefined
  }
  if (!p.startsWith('/')) p = `${cwd}/${p}`
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}

// `dir` joined with a relative glob (Glob's `pattern`, Grep's `glob`).
export function joinPattern(dir: string | undefined, pattern: string): string {
  if (pattern.startsWith('/') || pattern.startsWith('~')) return pattern
  return `${dir ?? '.'}/${pattern}`
}

/** The protected glob (as configured) covering `path`, unless an allowed glob covers it. */
export function protectedBy(settings: Settings, path: string, home: string | undefined): string | undefined {
  const covers = (glob: string) => {
    const anchored = anchorGlob(glob, home)
    return anchored !== undefined && matchGlob(anchored, path)
  }
  if (settings.allowed.some(covers)) return undefined
  return settings.protected.find(covers)
}

export type Target = { raw: string; resolvable: boolean }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/**
 * The paths a call reads, raw: `resolvable` ones may also be checked through symlinks.
 * Writes (Edit, Write, NotebookEdit, Bash `>` targets) are never guarded.
 */
export function targetsOf(tool: string, args: Readonly<Record<string, unknown>>, checkBash: boolean): Target[] {
  const path = str(args.path)
  switch (tool) {
    case 'Read': {
      const p = str(args.file_path)
      return p ? [{ raw: p, resolvable: true }] : []
    }
    case 'Glob':
    case 'Grep': {
      const out: Target[] = []
      if (path) out.push({ raw: path, resolvable: true })
      const pattern = str(tool === 'Glob' ? args.pattern : args.glob)
      if (pattern) out.push({ raw: joinPattern(path, pattern), resolvable: false })
      return out
    }
    case 'Bash': {
      const command = str(args.command)
      if (!checkBash || !command) return []
      return bashWords(command).map(raw => ({ raw, resolvable: false }))
    }
    default:
      return []
  }
}

const SEPARATORS = new Set(['|', ';', '&', '(', ')', '`', '\n'])
const SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/g

/**
 * The words of a shell command that could name a file it reads, quotes removed, `$HOME`
 * spelled `~`: every argument and `<` target, `--flag=value`'s value too, but not a
 * `>`/`>>` target, which is a write.
 * A heuristic, not a shell: no variables beyond HOME, no globbing, no aliases.
 */
export function bashWords(command: string): string[] {
  type Word = { text: string; redirect: '' | '<' | '>' }
  const segments: Word[][] = [[]]
  let word = ''
  let inWord = false
  let quote: '"' | "'" | undefined
  let redirectNext: '' | '<' | '>' = ''

  const end = () => {
    if (inWord) segments[segments.length - 1]?.push({ text: word, redirect: redirectNext })
    if (inWord) redirectNext = ''
    word = ''
    inWord = false
  }

  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      inWord = true
    } else if (c === ' ' || c === '\t') {
      end()
    } else if (SEPARATORS.has(c)) {
      end()
      redirectNext = ''
      segments.push([])
    } else if (c === '<' || c === '>') {
      end()
      redirectNext = c
    } else {
      word += c
      inWord = true
    }
  }
  end()

  // A substitution inside double quotes ("$(cat .env)") stays one word above; scan it too.
  const out: string[] = []
  for (const m of command.matchAll(SUBSTITUTION)) out.push(...bashWords(m[1] ?? m[2] ?? ''))
  for (const seg of segments) {
    const program = seg.find(w => !w.redirect && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text))
    const isText = program !== undefined && TEXT_PROGRAMS.has(program.text)
    for (const w of seg) {
      if (w.redirect === '>' || (isText && !w.redirect)) continue
      for (const candidate of [w.text, ...(w.text.includes('=') ? [w.text.slice(w.text.indexOf('=') + 1)] : [])]) {
        const t = candidate.replace(/^\$(?:HOME\b|\{HOME\})/, '~')
        if (t === '' || t.startsWith('-') || t.includes('://') || /^\d+$/.test(t)) continue
        out.push(t)
        if (out.length >= MAX_BASH_WORDS) return out
      }
    }
  }
  return out
}

/** `path` with home shown as `~`, for messages. */
export function display(path: string, home: string | undefined): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`
  return path
}

export function reasonFor(
  tool: string, mode: Exclude<Mode, 'off'>, path: string, glob: string, home: string | undefined,
): string {
  const what = `${display(path, home)} matches the protected pattern "${glob}"`
  if (mode === 'ask') return `guard: this ${tool} call touches a protected path: ${what}.`
  const how = tool === 'Bash' ? ', or turns off its secrets_check_bash option' : ''
  return (
    `guard blocked this ${tool} call: ${what}. ` +
    `Do not try to reach this file another way; tell the user. To allow it, the user adds a glob covering it ` +
    `to the guard plugin's "secrets_allowed" option${how}.`
  )
}
