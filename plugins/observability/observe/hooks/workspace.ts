import type { Io } from './io'

const MAX_DIR_DEPTH = 40

async function readText(io: Io, path: string): Promise<string | undefined> {
  try {
    return await io.readFile(path)
  } catch {
    return undefined
  }
}

const parentDir = (dir: string) => (dir === '/' ? undefined : dir.replace(/[\\/][^\\/]*$/, '') || '/')
const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)

export const branchFromHead = (head: string) => /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim()

export type Workspace = { branch?: string; linkedProject?: string; linkedOrg?: string }

// Walks up from the session's directory for .git (a directory, or in a worktree a file naming
// its gitdir) and, when asked, .vercel/project.json, reading files only: no git process.
export async function detectWorkspace(io: Io, wantVercelLink: boolean): Promise<Workspace> {
  const ws: Workspace = {}
  let gitFound = false
  let linkFound = !wantVercelLink
  let dir: string | undefined = await io.cwd()
  for (let i = 0; dir && i < MAX_DIR_DEPTH && !(gitFound && linkFound); i++, dir = parentDir(dir)) {
    if (!linkFound) {
      const link = await readText(io, `${dir}/.vercel/project.json`)
      if (link !== undefined) {
        linkFound = true
        try {
          const { projectId, orgId } = JSON.parse(link)
          ws.linkedProject = typeof projectId === 'string' ? projectId : undefined
          ws.linkedOrg = typeof orgId === 'string' ? orgId : undefined
        } catch {
          // a broken link file: fall back to the settings
        }
      }
    }
    if (!gitFound) {
      let head = await readText(io, `${dir}/.git/HEAD`)
      if (head === undefined) {
        const gitdir = /^gitdir:\s*(.+)$/m.exec((await readText(io, `${dir}/.git`)) ?? '')?.[1]?.trim()
        if (gitdir) head = await readText(io, `${isAbsolute(gitdir) ? gitdir : `${dir}/${gitdir}`}/HEAD`)
      }
      if (head !== undefined) {
        gitFound = true
        ws.branch = branchFromHead(head)
      }
    }
  }
  return ws
}
