// A small glob matcher for absolute POSIX paths: `**` (any depth, including none),
// `*` and `?` (within one path segment), `{a,b}` (alternatives, nestable).
// Matching ignores case, so a case-insensitive file system (macOS, Windows) can't
// slip `~/.SSH/id_rsa` past `~/.ssh/**`.

const REGEX_SPECIAL = /[.+^$()|[\]\\]/

const cache = new Map<string, RegExp>()

export function globToRegExp(glob: string): RegExp {
  let re = cache.get(glob)
  if (!re) {
    re = new RegExp(`^${source(glob)}$`, 'i')
    cache.set(glob, re)
  }
  return re
}

export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path)
}

// Index of the `}` closing the `{` at `open`, or -1.
function closingBrace(glob: string, open: number): number {
  let depth = 0
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === '{') depth++
    else if (glob[i] === '}' && --depth === 0) return i
  }
  return -1
}

// Splits a brace body on its top-level commas.
function alternatives(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') depth++
    else if (body[i] === '}') depth--
    else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
  }
  parts.push(body.slice(start))
  return parts
}

function source(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*') {
      let end = i
      while (glob[end + 1] === '*') end++
      if (end === i) {
        out += '[^/]*'
        continue
      }
      const atSegmentStart = i === 0 || glob[i - 1] === '/'
      const next = glob[end + 1]
      if (atSegmentStart && next === '/') {
        out += '(?:.*/)?' // `**/` matches zero or more directories
        i = end + 1
      } else if (atSegmentStart && next === undefined && out.endsWith('/')) {
        out = `${out.slice(0, -1)}(?:/.*)?` // `dir/**` matches dir itself too
        i = end
      } else {
        out += '.*'
        i = end
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '{') {
      const close = closingBrace(glob, i)
      if (close < 0) {
        out += '\\{'
        continue
      }
      out += `(?:${alternatives(glob.slice(i + 1, close)).map(source).join('|')})`
      i = close
    } else {
      out += REGEX_SPECIAL.test(c) || c === '}' ? `\\${c}` : c
    }
  }
  return out
}
