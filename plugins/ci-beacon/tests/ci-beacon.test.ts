import { expect, mock, test } from 'claude-code/testing';

import { parseRuns, stateOf, statusLine } from '../hooks/register';

const RUN = (status: string, conclusion: string) =>
  JSON.stringify([{ status, conclusion, workflowName: 'build', url: 'https://github.com/o/r/actions/runs/1' }]);

// Stands for the engine: git names `branch`, gh answers `runs` (null: gh is missing), statuses and toasts are collected.
function engine(on: any) {
  const now = { branch: 'main', runs: RUN('completed', 'success') as string | null, statuses: [] as (string | undefined)[], toasts: [] as string[], gh: [] as string[] };
  const clock = mock.clock(on);
  on('process.run', ($: any, e: any) => {
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: `${now.branch}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
    now.gh.push(e.argv.join(' '));
    if (now.runs === null) return { deny: 'gh: command not found' };
    return { value: { exitCode: 0, stdout: now.runs, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on('ui.status', ($: any, e: any) => {
    now.statuses.push(e.text);
    return { value: undefined };
  });
  on('ui.toast', ($: any, e: any) => {
    now.toasts.push(e.text);
    return { value: undefined };
  });
  on('session.start', () => ({ cwd: '/work' }));
  on('turn.complete', () => ({ text: '' }));
  on('command.register', () => ({ value: undefined }));
  return { now, clock };
}

// The refresh at start and after a turn is not awaited by the mod, so a test lets it land first.
declare const setTimeout: (fn: () => void, ms: number) => unknown;
const settled = () => new Promise<void>(resolve => setTimeout(resolve, 20));
const start = async ($: any) => {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' });
  await settled();
};
const turn = async ($: any, agentId?: string) => {
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId });
  await settled();
};

test('parsing and the status line', () => {
  const run = parseRuns(RUN('in_progress', ''));
  expect(run?.workflowName).toBe('build');
  expect(stateOf(run!)).toBe('running');
  expect(statusLine({ branch: 'main', run })).toBe('CI ◌ running · build');
  expect(statusLine({ branch: 'main', run: parseRuns(RUN('completed', 'success')) })).toBe('CI ● passing · build');
  expect(statusLine({ branch: 'main', run: parseRuns(RUN('completed', 'failure')) })).toBe('CI ✗ failing · build');
  expect(statusLine({ branch: 'main', run: parseRuns(RUN('completed', 'timed_out')) })).toBe('CI ✗ timed out · build');
  expect(statusLine({ branch: 'feat', run: parseRuns('[]') })).toBe('CI ○ no runs on feat');
  expect(parseRuns('not json')).toBe(null);
});

test('the status line is set at start, after each main turn, and on the timer', async ($: any, on: any) => {
  const { now, clock } = engine(on);
  await start($);
  expect(now.statuses).toEqual(['CI ● passing · build']);
  expect(now.gh[0]).toBe('gh run list --branch main --limit 1 --json status,conclusion,workflowName,url');
  await turn($, 'agent-1');
  await turn($);
  expect(now.statuses).toHaveLength(2);
  await clock.advance(60000);
  expect(now.statuses).toHaveLength(3);
  expect(now.toasts).toEqual([]);
});

test('a run that finishes toasts once, with its link', async ($: any, on: any) => {
  const { now, clock } = engine(on);
  now.runs = RUN('in_progress', '');
  await start($);
  await clock.advance(60000);
  now.runs = RUN('completed', 'failure');
  await clock.advance(60000);
  await clock.advance(60000);
  expect(now.toasts).toEqual(['CI: build is failing on main. https://github.com/o/r/actions/runs/1']);
  expect(now.statuses.slice(-1)).toEqual(['CI ✗ failing · build']);
});

test('refreshes that overlap share one gh call', async ($: any, on: any) => {
  const { now } = engine(on);
  await start($);
  const before = now.gh.length;
  await Promise.all([$.command.run({ command: 'ci', args: '' }), $.command.run({ command: 'ci', args: '' })]);
  expect(now.gh.length).toBe(before + 1);
});

test('without a branch or gh the status line is cleared and /ci says so', async ($: any, on: any) => {
  const { now } = engine(on);
  now.runs = null;
  await start($);
  expect(now.statuses).toEqual([undefined]);
  expect((await $.command.run({ command: 'ci', args: '' })).text).toContain('gh');
  now.branch = '';
  now.runs = RUN('completed', 'success');
  await turn($);
  expect(now.statuses.slice(-1)).toEqual([undefined]);
});

test('/ci reports the run with its link, and the options set the poll and the workflow', { options: { poll_seconds: 15, workflow: 'deploy' } }, async ($: any, on: any) => {
  const { now, clock } = engine(on);
  await start($);
  expect(now.gh[0]).toContain('--workflow deploy');
  await clock.advance(15000);
  expect(now.statuses).toHaveLength(2);
  expect((await $.command.run({ command: 'ci', args: '' })).text).toBe('CI ● passing · build https://github.com/o/r/actions/runs/1');
});
