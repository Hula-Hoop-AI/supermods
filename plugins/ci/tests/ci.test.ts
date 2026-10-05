import { expect, mock, test } from 'claude-code/testing';

import { fit, parseRuns, stateOf, statusLine } from '../hooks/register';

const RUN = (status: string, conclusion: string) =>
  JSON.stringify([{ status, conclusion, workflowName: 'build', url: 'https://github.com/o/r/actions/runs/1' }]);
const SURFACES = ['terminal', 'desktop'] as const;
const ENGINE_HINT = '? for shortcuts';

// Stands for the engine: git names `branch`, gh answers `runs` (null: gh is missing), toasts and status calls are collected.
// Its prompt hint draws `hint` and, as the terminal does, a `tail` after it.
function engine(on: any) {
  const now = { branch: 'main', runs: RUN('completed', 'success') as string | null, statuses: [] as unknown[], toasts: [] as string[], gh: [] as string[] };
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
  on('ui.render', ($: any, e: any) => ({ type: 'Text', props: {}, children: [e.props.tail ? `${e.props.hint} · ${e.props.tail}` : e.props.hint] }));
  on('session.start', () => ({ cwd: '/work' }));
  on('turn.complete', () => ({ text: '' }));
  on('command.register', () => ({ value: undefined }));
  return { now, clock };
}

const hintProps = (props: object = {}) => ({ isDraft: false, isWorking: false, hint: ENGINE_HINT, ...props });

// The prompt hint as drawn on `surface`: every Text in it, in order.
async function hintLine($: any, surface: 'terminal' | 'desktop', props: object = {}, columns = 200) {
  const ui = await $.ui.mount({ plugin: 'ci', surface, component: 'PromptHint', props: hintProps(props), viewport: { columns, rows: 40 } });
  const line = (await ui.findAll({ type: 'Text' })).map((text: any) => text.text).join('');
  await ui.unmount();
  return line;
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

test('parsing, the status text, and fitting it', () => {
  const run = parseRuns(RUN('in_progress', ''));
  expect(run?.workflowName).toBe('build');
  expect(stateOf(run!)).toBe('running');
  expect(statusLine({ branch: 'main', run })).toBe('CI ◌ running · build');
  expect(statusLine({ branch: 'main', run: parseRuns(RUN('completed', 'success')) })).toBe('CI ● passing · build');
  expect(statusLine({ branch: 'main', run: parseRuns(RUN('completed', 'failure')) })).toBe('CI ✗ failing · build');
  expect(statusLine({ branch: 'main', run: parseRuns(RUN('completed', 'timed_out')) })).toBe('CI ✗ timed out · build');
  expect(statusLine({ branch: 'feat', run: parseRuns('[]') })).toBe('CI ○ no runs on feat');
  expect(parseRuns('not json')).toBe(null);
  expect(fit('CI ● passing · build', 100)).toBe('CI ● passing · build');
  expect(fit('CI ● passing · build', 8)).toBe('CI ● pa…');
  expect(fit('CI ● passing · build', 3)).toBe('');
});

test("the prompt hint carries the run on each surface, after the engine's hint, with no status line", async ($: any, on: any) => {
  const { now } = engine(on);
  await start($);
  for (const surface of SURFACES) expect(await hintLine($, surface)).toBe(`${ENGINE_HINT} · CI ● passing · build`);
  now.runs = '[]';
  now.branch = 'feat';
  await turn($);
  for (const surface of SURFACES) expect(await hintLine($, surface)).toBe(`${ENGINE_HINT} · CI ○ no runs on feat`);
  now.runs = RUN('in_progress', '');
  await turn($);
  for (const surface of SURFACES) expect(await hintLine($, surface)).toBe(`${ENGINE_HINT} · CI ◌ running · build`);
  expect(now.statuses).toEqual([]);
});

test('a drawn hint follows a refresh without being mounted again', async ($: any, on: any) => {
  const { now, clock } = engine(on);
  await start($);
  const ui = await $.ui.mount({ plugin: 'ci', surface: 'terminal', component: 'PromptHint', props: hintProps() });
  expect(await ui.find({ type: 'Text', text: 'CI ● passing · build' })).toBeDefined();
  now.runs = RUN('completed', 'failure');
  await clock.advance(60000);
  await settled();
  expect(await ui.find({ type: 'Text', text: 'CI ✗ failing · build' })).toBeDefined();
  await ui.unmount();
});

test("it composes with another mod's segment and gives way on a narrow line", async ($: any, on: any) => {
  engine(on);
  await start($);
  // Another mod above already added its segment to the terminal's tail.
  expect(await hintLine($, 'terminal', { tail: 'repo@main' })).toBe(`${ENGINE_HINT} · repo@main · CI ● passing · build`);
  // The terminal cuts `tail` itself; on the desktop the segment is cut here, never the engine's hint.
  expect(await hintLine($, 'desktop', {}, ENGINE_HINT.length + 3 + 8)).toBe(`${ENGINE_HINT} · CI ● pa…`);
  expect(await hintLine($, 'desktop', {}, ENGINE_HINT.length + 2)).toBe(ENGINE_HINT);
});

test('the status is refreshed after each main turn and on the timer', async ($: any, on: any) => {
  const { now, clock } = engine(on);
  await start($);
  expect(now.gh[0]).toBe('gh run list --branch main --limit 1 --json status,conclusion,workflowName,url');
  await turn($, 'agent-1');
  expect(now.gh).toHaveLength(1);
  await turn($);
  expect(now.gh).toHaveLength(2);
  await clock.advance(60000);
  expect(now.gh).toHaveLength(3);
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
  expect(await hintLine($, 'terminal')).toBe(`${ENGINE_HINT} · CI ✗ failing · build`);
});

test('refreshes that overlap share one gh call', async ($: any, on: any) => {
  const { now } = engine(on);
  await start($);
  const before = now.gh.length;
  await Promise.all([$.command.run({ command: 'ci', args: '' }), $.command.run({ command: 'ci', args: '' })]);
  expect(now.gh.length).toBe(before + 1);
});

test("without a branch or gh the hint is the engine's alone and /ci says so", async ($: any, on: any) => {
  const { now } = engine(on);
  now.runs = null;
  await start($);
  for (const surface of SURFACES) expect(await hintLine($, surface)).toBe(ENGINE_HINT);
  expect((await $.command.run({ command: 'ci', args: '' })).text).toContain('gh');
  now.branch = '';
  now.runs = RUN('completed', 'success');
  await turn($);
  for (const surface of SURFACES) expect(await hintLine($, surface)).toBe(ENGINE_HINT);
  expect(now.statuses).toEqual([]);
});

test('/ci reports the run with its link, and the options set the poll and the workflow', { options: { poll_seconds: 15, workflow: 'deploy' } }, async ($: any, on: any) => {
  const { now, clock } = engine(on);
  await start($);
  expect(now.gh[0]).toContain('--workflow deploy');
  await clock.advance(15000);
  expect(now.gh).toHaveLength(2);
  expect((await $.command.run({ command: 'ci', args: '' })).text).toBe('CI ● passing · build https://github.com/o/r/actions/runs/1');
});
