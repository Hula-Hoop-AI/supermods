export type Worktree = {
  path: string;
  name: string;
  branch: string | null;
  isMain: boolean;
  isCurrent: boolean;
  uncommittedFiles: number;
  commitsAhead: number | null;
  isMerged: boolean;
  ports: number[];
};

export type WorktreeScan = { baseRef: string; worktrees: Worktree[] };

declare module 'claude-code' {
  interface PluginState {
    'worktree-hud': { scan: WorktreeScan; note: string };
  }
}
