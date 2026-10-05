import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { Worktree, WorktreeScan } from '../types';

const PANE = 'worktrees';
const FALLBACK_BASE_REFS = ['origin/main', 'origin/master'];
const MERGED_PR_LIMIT = '200';
const SEPARATOR = ' · ';
// Under this many columns a cut segment says nothing, so it is left out (the terminal's rule for `tail`).
const MIN_SEGMENT_COLUMNS = 4;

const scan = atom({ plugin: 'worktrees', key: 'scan' } as const, { baseRef: '', worktrees: [] });
const note = atom({ plugin: 'worktrees', key: 'note' } as const, '');
// What the prompt hint shows: `repo@branch` and the ports, or empty outside a repository.
const hint = atom({ plugin: 'worktrees', key: 'hint' } as const, '');

type WorktreeEntry = Pick<Worktree, 'path' | 'branch'>;

async function stdoutOf($: EngineInterface, argv: string[], cwd?: string) {
  try {
    return await $.process.run(argv, cwd === undefined ? {} : { cwd });
  } catch {
    return { exitCode: 1, stdout: '' };
  }
}

async function output($: EngineInterface, argv: string[], cwd?: string): Promise<string> {
  const ran = await stdoutOf($, argv, cwd);
  return ran.exitCode === 0 ? ran.stdout.trim() : '';
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

function lines(text: string): string[] {
  return text.split('\n').filter(Boolean);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  return porcelain
    .split('\n\n')
    .map(lines)
    .flatMap(fields => {
      const path = fields.find(field => field.startsWith('worktree '))?.slice('worktree '.length);
      const branch = fields.find(field => field.startsWith('branch '))?.slice('branch refs/heads/'.length);
      return path === undefined ? [] : [{ path, branch: branch ?? null }];
    });
}

async function defaultBaseRef($: EngineInterface): Promise<string> {
  const remoteHead = await output($, ['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead !== '') return remoteHead;
  for (const candidate of FALLBACK_BASE_REFS) {
    if ((await output($, ['git', 'rev-parse', '--verify', '--quiet', candidate])) !== '') return candidate;
  }
  return '';
}

async function mergedBranches($: EngineInterface): Promise<Set<string>> {
  const merged = await output($, [
    'gh', 'pr', 'list', '--state', 'merged', '--limit', MERGED_PR_LIMIT,
    '--json', 'headRefName', '--jq', '.[].headRefName',
  ]);
  return new Set(lines(merged));
}

function parseLsofFields(fields: string): Map<string, string[]> {
  const namesByPid = new Map<string, string[]>();
  let pid = '';
  for (const field of lines(fields)) {
    if (field.startsWith('p')) pid = field.slice(1);
    if (field.startsWith('n')) namesByPid.set(pid, [...(namesByPid.get(pid) ?? []), field.slice(1)]);
  }
  return namesByPid;
}

async function listeningPortsByDirectory($: EngineInterface): Promise<Map<string, number[]>> {
  const listening = await stdoutOf($, ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  const addressesByPid = parseLsofFields(listening.stdout);
  if (addressesByPid.size === 0) return new Map();

  const directories = await stdoutOf($, ['lsof', '-a', '-d', 'cwd', '-Fpn', '-p', [...addressesByPid.keys()].join(',')]);
  const portsByDirectory = new Map<string, number[]>();
  for (const [pid, [directory]] of parseLsofFields(directories.stdout)) {
    if (directory === undefined) continue;
    const ports = (addressesByPid.get(pid) ?? []).map(address => Number(address.split(':').pop()));
    portsByDirectory.set(directory, [...(portsByDirectory.get(directory) ?? []), ...ports]);
  }
  return portsByDirectory;
}

function owningWorktree(directory: string, paths: string[]): string | undefined {
  return paths
    .filter(path => directory === path || directory.startsWith(`${path}/`))
    .sort((a, b) => b.length - a.length)[0];
}

function portsByWorktree(portsByDirectory: Map<string, number[]>, paths: string[]): Map<string, number[]> {
  const grouped = new Map<string, Set<number>>();
  for (const [directory, ports] of portsByDirectory) {
    const owner = owningWorktree(directory, paths);
    if (owner === undefined) continue;
    grouped.set(owner, new Set([...(grouped.get(owner) ?? []), ...ports]));
  }
  return new Map([...grouped].map(([path, ports]) => [path, [...ports].sort((a, b) => a - b)]));
}

async function scanWorktrees($: EngineInterface): Promise<WorktreeScan> {
  const [listing, currentRoot, baseRef, merged, portsByDirectory] = await Promise.all([
    output($, ['git', 'worktree', 'list', '--porcelain']),
    output($, ['git', 'rev-parse', '--show-toplevel']),
    defaultBaseRef($),
    mergedBranches($),
    listeningPortsByDirectory($),
  ]);
  const entries = parseWorktreeList(listing);
  const ports = portsByWorktree(portsByDirectory, entries.map(entry => entry.path));
  const worktrees = await Promise.all(
    entries.map(async ({ path, branch }, index) => {
      const [status, ahead] = await Promise.all([
        output($, ['git', 'status', '--porcelain'], path),
        baseRef === '' ? '' : output($, ['git', 'rev-list', '--count', `${baseRef}..HEAD`], path),
      ]);
      return {
        path,
        name: baseName(path),
        branch,
        isMain: index === 0,
        isCurrent: path === currentRoot,
        uncommittedFiles: lines(status).length,
        commitsAhead: ahead === '' ? null : Number(ahead),
        isMerged: branch !== null && merged.has(branch),
        ports: ports.get(path) ?? [],
      };
    })
  );
  return { baseRef, worktrees };
}

function isRemovable(worktree: Worktree): boolean {
  return (
    !worktree.isMain &&
    !worktree.isCurrent &&
    worktree.branch !== null &&
    worktree.uncommittedFiles === 0 &&
    worktree.ports.length === 0 &&
    (worktree.isMerged || worktree.commitsAhead === 0)
  );
}

function portList(ports: number[]): string {
  return ports.map(port => `:${port}`).join(' ');
}

function describe(worktree: Worktree): string {
  const facts = [
    worktree.isMain && 'main checkout',
    worktree.isMerged && 'PR merged',
    worktree.commitsAhead !== null && worktree.commitsAhead > 0 && `${plural(worktree.commitsAhead, 'commit')} ahead`,
    worktree.uncommittedFiles > 0 && `${plural(worktree.uncommittedFiles, 'uncommitted file')}`,
    worktree.ports.length > 0 && `listening on ${portList(worktree.ports)}`,
  ].filter(Boolean);
  const marker = worktree.isCurrent ? '>' : ' ';
  return `${marker} ${worktree.name} (${worktree.branch ?? 'detached'})  ${facts.join(', ')}`;
}

async function removeFinished($: EngineInterface): Promise<string> {
  const finished = (await scanWorktrees($)).worktrees.filter(isRemovable);
  const kept: string[] = [];
  for (const { path, name } of finished) {
    const removed = await stdoutOf($, ['git', 'worktree', 'remove', path]);
    if (removed.exitCode !== 0) kept.push(name);
  }
  const keptNote = kept.length > 0 ? `; git kept ${kept.join(', ')}` : '';
  return `Removed ${plural(finished.length - kept.length, 'worktree')}, branches untouched${keptNote}.`;
}

export function hintText(root: string, branch: string, ports: number[]): string {
  return [`${baseName(root)}@${branch || 'detached'}`, portList(ports)].filter(Boolean).join(SEPARATOR);
}

/** The segment cut to `room` columns, or empty when too little of it would show. */
export function fit(segment: string, room: number): string {
  if (room < MIN_SEGMENT_COLUMNS) return '';
  return segment.length <= room ? segment : `${segment.slice(0, room - 1)}…`;
}

async function refreshHint($: EngineInterface): Promise<void> {
  const root = await output($, ['git', 'rev-parse', '--show-toplevel']);
  if (root === '') {
    await update($, hint, () => '');
    return;
  }
  const [branch, listing, portsByDirectory] = await Promise.all([
    output($, ['git', 'branch', '--show-current']),
    output($, ['git', 'worktree', 'list', '--porcelain']),
    listeningPortsByDirectory($),
  ]);
  const paths = parseWorktreeList(listing).map(entry => entry.path);
  const ports = portsByWorktree(portsByDirectory, paths).get(root) ?? [];
  const text = hintText(root, branch, ports);
  await update($, hint, () => text);
}

function notPlaced(what: string, reason: string) {
  return `${what} is open, but this surface is not showing it: ${reason}`;
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'worktrees',
      description: 'Review git worktrees and clear the finished ones',
    });
    void refreshHint($);

    return next(e);
  });

  on('turn.complete', ($, e, next) => {
    void refreshHint($);

    return next(e);
  });

  // The terminal adds `tail` to its own live line and cuts it at the row's end; the desktop
  // does not draw `tail` yet, so there the engine's line is wrapped with the segment beside it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const segment = await read($, hint);
    if (segment === '') return next(e);
    if (e.surface === 'terminal') {
      const tail = e.props.tail ? `${e.props.tail}${SEPARATOR}${segment}` : segment;
      return next({ ...e, props: { ...e.props, tail } });
    }
    const drawn = await next(e);
    const room = e.viewport === undefined ? segment.length : e.viewport.columns - e.props.hint.length - SEPARATOR.length;
    const shown = fit(segment, room);
    if (shown === '') return drawn;
    const { Box, Text } = $.ui.resolve(e);

    return (
      <Box flexDirection="row">
        {drawn}
        <Text dimColor wrap="truncate-end">{`${SEPARATOR}${shown}`}</Text>
      </Box>
    );
  });

  on('command.run', { command: 'worktrees' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Worktrees' });
    const scanned = await scanWorktrees($);
    await update($, scan, () => scanned);

    return { text: opened.isPlaced ? 'Worktrees pane opened.' : notPlaced('The Worktrees pane', opened.reason) };
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e);
    const { baseRef, worktrees } = await read($, scan);
    const message = await read($, note);
    const finishedCount = worktrees.filter(isRemovable).length;

    return (
      <Box flexDirection="column">
        {worktrees.length === 0 && <Text dimColor>No worktrees found.</Text>}
        {baseRef !== '' && <Text dimColor>Commits ahead are counted against {baseRef}.</Text>}
        {worktrees.map(worktree => (
          <Text bold={worktree.isCurrent} dimColor={isRemovable(worktree)} wrap="truncate-end">
            {describe(worktree)}
          </Text>
        ))}
        <Box>
          <Button
            key="refresh"
            label="Refresh"
            hotkey="r"
            onPress={async () => {
              const scanned = await scanWorktrees($);
              await update($, scan, () => scanned);
            }}
          />
          {finishedCount > 0 && (
            <Button
              key="remove-finished"
              label={`Remove ${finishedCount} finished`}
              hotkey="x"
              onPress={async () => {
                const outcome = await removeFinished($);
                const scanned = await scanWorktrees($);
                await update($, scan, () => scanned);
                await update($, note, () => outcome);
              }}
            />
          )}
        </Box>
        {finishedCount > 0 && (
          <Text dimColor>Finished: no uncommitted files, nothing listening, and PR merged or no commits ahead.</Text>
        )}
        {message !== '' && <Text dimColor>{message}</Text>}
      </Box>
    );
  });
};
