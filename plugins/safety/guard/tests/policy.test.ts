import { describe, expect, test } from 'claude-code/testing'

import { matchGlob } from '../hooks/rules/secret-reads/glob'
import {
  anchorGlob, bashWords, display, normalizePath, parseSettings, protectedBy, targetsOf,
} from '../hooks/rules/secret-reads/policy'

const HOME = '/home/u'
const CWD = '/home/u/proj'

describe('glob matcher', () => {
  const cases: [string, string, boolean][] = [
    ['/a/*.pem', '/a/x.pem', true],
    ['/a/*.pem', '/a/b/x.pem', false],
    ['/a/?.key', '/a/x.key', true],
    ['/a/?.key', '/a/xy.key', false],
    ['/a/?', '/a/', false],
    ['**/.env', '/.env', true],
    ['**/.env', '/a/b/c/.env', true],
    ['**/.env', '/a/b/c/x.env', false],
    ['**/.env.*', '/a/.env.local', true],
    ['**/.env.*', '/a/.env', false],
    ['/h/.ssh/**', '/h/.ssh', true],
    ['/h/.ssh/**', '/h/.ssh/id_rsa', true],
    ['/h/.ssh/**', '/h/.ssh/a/b', true],
    ['/h/.ssh/**', '/h/.sshx', false],
    ['/a/**/z', '/a/z', true],
    ['/a/**/z', '/a/b/c/z', true],
    ['/a/x**', '/a/x/y', true],
    ['**/*.{pem,key}', '/a/b.key', true],
    ['**/*.{pem,key}', '/a/b.crt', false],
    ['**/{a,b{c,d}}.txt', '/x/bd.txt', true],
    ['**/{a,b{c,d}}.txt', '/x/be.txt', false],
    ['/a/{x', '/a/{x', true],
    ['/a/x}', '/a/x}', true],
    ['/a/(x)+[y].$', '/a/(x)+[y].$', true],
    ['**/.ssh/**', '/h/.SSH/ID_RSA', true],
  ]
  for (const [glob, path, expected] of cases) {
    test(`${glob} ${expected ? 'matches' : 'does not match'} ${path}`, () => {
      expect(matchGlob(glob, path)).toBe(expected)
    })
  }
})

describe('anchorGlob', () => {
  test('~ is home, / is absolute, anything else matches at any depth', () => {
    expect(anchorGlob('~/.netrc', HOME)).toBe('/home/u/.netrc')
    expect(anchorGlob('~', HOME)).toBe('/home/u')
    expect(anchorGlob('/etc/x', HOME)).toBe('/etc/x')
    expect(anchorGlob('**/.env', HOME)).toBe('**/.env')
    expect(anchorGlob('secrets.yml', HOME)).toBe('**/secrets.yml')
    expect(anchorGlob('config/*.yml', HOME)).toBe('**/config/*.yml')
    expect(anchorGlob('~/.netrc', undefined)).toBeUndefined()
  })
})

describe('normalizePath', () => {
  test('resolves ~, relative paths, . and ..', () => {
    expect(normalizePath('~/.ssh/id_rsa', CWD, HOME)).toBe('/home/u/.ssh/id_rsa')
    expect(normalizePath('~', CWD, HOME)).toBe('/home/u')
    expect(normalizePath('.env', CWD, HOME)).toBe('/home/u/proj/.env')
    expect(normalizePath('./a/../.env', CWD, HOME)).toBe('/home/u/proj/.env')
    expect(normalizePath('../../u/.ssh//id_rsa', CWD, HOME)).toBe('/home/u/.ssh/id_rsa')
    expect(normalizePath('/../../etc/x', CWD, HOME)).toBe('/etc/x')
  })
  test('gives up on what it cannot place', () => {
    expect(normalizePath('', CWD, HOME)).toBeUndefined()
    expect(normalizePath('~bob/.ssh/id_rsa', CWD, HOME)).toBeUndefined()
    expect(normalizePath('~/.ssh', CWD, undefined)).toBeUndefined()
  })
})

describe('defaults', () => {
  const s = parseSettings({})
  const blocked: [string, string][] = [
    ['/home/u/.ssh/id_rsa', '~/.ssh/**'],
    ['/home/u/.ssh/config', '~/.ssh/**'],
    ['/home/u/.aws/credentials', '~/.aws/credentials'],
    ['/home/u/.config/gcloud/application_default_credentials.json', '~/.config/gcloud/**'],
    ['/home/u/.netrc', '~/.netrc'],
    ['/home/u/.docker/config.json', '~/.docker/config.json'],
    ['/home/u/.kube/config', '~/.kube/config'],
    ['/home/u/.config/gh/hosts.yml', '~/.config/gh/hosts.yml'],
    ['/home/u/.git-credentials', '**/.git-credentials'],
    ['/home/u/proj/.env', '**/.env'],
    ['/home/u/proj/api/.env.production', '**/.env.*'],
    ['/srv/tls/server.pem', '**/*.pem'],
    ['/srv/tls/server.key', '**/*.key'],
    ['/backup/id_rsa', '**/id_rsa*'],
    ['/backup/id_ed25519', '**/id_ed25519*'],
    ['/certs/a.p12', '**/*.p12'],
    ['/certs/a.pfx', '**/*.pfx'],
    ['/home/u/proj/credentials.json', '**/credentials.json'],
    ['/home/u/.npmrc', '**/.npmrc'],
    ['/home/u/.pypirc', '**/.pypirc'],
  ]
  for (const [path, glob] of blocked) {
    test(`protects ${path}`, () => expect(protectedBy(s, path, HOME)).toBe(glob))
  }
  const open = [
    '/home/u/proj/.env.example', '/home/u/proj/.env.sample', '/home/u/proj/.env.template',
    '/home/u/.ssh/id_rsa.pub', '/backup/id_ed25519.pub', '/home/u/.aws/config',
    '/home/u/proj/src/env.ts', '/home/u/proj/keys.md', '/home/u/proj/.environment',
  ]
  for (const path of open) {
    test(`leaves ${path} alone`, () => expect(protectedBy(s, path, HOME)).toBeUndefined())
  }
})

describe('settings', () => {
  test('protected adds globs; a bare name matches at any depth', () => {
    const s = parseSettings({ secrets_protected: ['secrets.yml', '~/.config/gh/hosts.yml'] })
    expect(protectedBy(s, '/x/y/secrets.yml', HOME)).toBe('secrets.yml')
    expect(protectedBy(s, '/home/u/.config/gh/hosts.yml', HOME)).toBe('~/.config/gh/hosts.yml')
    expect(protectedBy(s, '/home/u/proj/.env', HOME)).toBe('**/.env')
  })
  test('allowed wins over protected, and keeps the built-in exceptions', () => {
    const s = parseSettings({ secrets_allowed: ['**/fixtures/**'] })
    expect(protectedBy(s, '/home/u/proj/fixtures/tls/test.pem', HOME)).toBeUndefined()
    expect(protectedBy(s, '/home/u/proj/.env.example', HOME)).toBeUndefined()
    expect(protectedBy(s, '/home/u/proj/.env', HOME)).toBe('**/.env')
  })
  test('mode defaults to deny', () => {
    expect(parseSettings({}).mode).toBe('deny')
    expect(parseSettings({ secrets_mode: 'ask' }).mode).toBe('ask')
    expect(parseSettings({ secrets_mode: 'off' }).mode).toBe('off')
    expect(parseSettings({ secrets_mode: 'bogus' }).mode).toBe('deny')
  })
  test('check_bash: false turns the Bash check off', () => {
    expect(targetsOf('Bash', { command: 'cat .env' }, parseSettings({ secrets_check_bash: false }).checkBash)).toEqual([])
    expect(targetsOf('Bash', { command: 'cat .env' }, parseSettings({}).checkBash).length).toBeGreaterThan(0)
  })
})

describe('targetsOf', () => {
  test('Read names its path; write tools name nothing', () => {
    expect(targetsOf('Read', { file_path: '/a' }, true)).toEqual([{ raw: '/a', resolvable: true }])
    expect(targetsOf('Edit', { file_path: '/a' }, true)).toEqual([])
    expect(targetsOf('Write', { file_path: '/a' }, true)).toEqual([])
    expect(targetsOf('NotebookEdit', { notebook_path: '/a.ipynb' }, true)).toEqual([])
  })
  test('Glob and Grep name their folder and their pattern under it', () => {
    expect(targetsOf('Glob', { pattern: '**/.env', path: '/p' }, true)).toEqual([
      { raw: '/p', resolvable: true },
      { raw: '/p/**/.env', resolvable: false },
    ])
    expect(targetsOf('Glob', { pattern: '~/.ssh/*' }, true)).toEqual([
      { raw: '~/.ssh/*', resolvable: false },
    ])
    expect(targetsOf('Grep', { pattern: 'API_KEY', glob: '.env*' }, true)).toEqual([
      { raw: './.env*', resolvable: false },
    ])
    expect(targetsOf('Grep', { pattern: 'x', path: '~/.aws' }, true)).toEqual([
      { raw: '~/.aws', resolvable: true },
    ])
  })
  test('other tools and missing fields name nothing', () => {
    expect(targetsOf('WebFetch', { url: 'https://x/.env' }, true)).toEqual([])
    expect(targetsOf('Read', {}, true)).toEqual([])
  })
})

describe('bashWords', () => {
  test('splits on operators and strips quotes and escapes', () => {
    expect(bashWords(`cat "a b" 'c'd e\\ f|wc -l; x&&y`)).toEqual(['cat', 'a b', 'cd', 'e f', 'wc', 'x', 'y'])
  })
  test('keeps < targets, substitutions and --flag=value values; drops > targets (writes)', () => {
    expect(bashWords('sort <.env >out.txt')).toEqual(['sort', '.env'])
    expect(bashWords('cat a >> .env')).toEqual(['cat', 'a'])
    expect(bashWords('x=$(cat ~/.netrc)')).toContain('~/.netrc')
    expect(bashWords('tool --config=.env')).toContain('.env')
    expect(bashWords('cat $HOME/.ssh/id_rsa ${HOME}/.netrc')).toEqual(['cat', '~/.ssh/id_rsa', '~/.netrc'])
  })
  test('skips flags, URLs, numbers and echo/printf text but not their < redirects', () => {
    expect(bashWords('curl -s https://x.io/.env 2>&1')).toEqual(['curl'])
    expect(bashWords('echo .env >> .gitignore')).toEqual([])
    expect(bashWords('printf "%s" .env > id_rsa')).toEqual([])
    expect(bashWords('printf "%s" < .env')).toEqual(['.env'])
    expect(bashWords('echo hi; cat .env')).toEqual(['cat', '.env'])
  })
})

describe('display', () => {
  test('shows home as ~', () => {
    expect(display('/home/u/.netrc', HOME)).toBe('~/.netrc')
    expect(display('/home/uu/.netrc', HOME)).toBe('/home/uu/.netrc')
  })
})
