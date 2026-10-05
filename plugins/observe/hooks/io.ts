import type { ProcessRunResult } from 'claude-code'

// What a provider may reach, as plain functions. register.tsx binds them to `$`: the validator
// follows `$` only inside the hooks module's own file, never across an import.
// The validator lists the variables a mod reads, so each is read by its literal name.
export type EnvName = 'MODAL_ENVIRONMENT' | 'RENDER_API_KEY' | 'VERCEL_TOKEN'

export type Io = {
  run: (argv: string[], options: { stdin?: string; timeoutMs: number }) => Promise<ProcessRunResult>
  fetch: (url: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number; text: string }>
  env: Record<EnvName, () => Promise<string | undefined>>
  now: () => Promise<number>
  readFile: (path: string) => Promise<string>
  cwd: () => Promise<string>
}
