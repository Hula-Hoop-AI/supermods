import type { PluginOptions } from 'claude-code'

type Option = PluginOptions[string] | undefined

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const list = (v: Option) =>
  (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map(s => String(s).trim())
    .filter(Boolean)

export const num = (v: Option, fallback: number, min: number, max = Infinity) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= min ? Math.min(max, n) : fallback
}

export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export const lastLine = (stderr: string, exitCode: number) => stderr.trim().split('\n').pop() || `exit ${exitCode}`

export function firstLine(s: string | undefined): string | undefined {
  const line = s?.split('\n')[0]?.trim()
  return line || undefined
}

export function age(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000))
  if (mins < 60) return `${mins}m`
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h`
  return `${Math.floor(mins / 1440)}d`
}
