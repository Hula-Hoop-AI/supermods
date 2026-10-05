import { expect, test } from 'claude-code/testing';

import { fit, hintText } from '../hooks/register';

const SURFACES = ['terminal', 'desktop'] as const;
const ENGINE_HINT = '? for shortcuts';
const ROOT = '/work/supermods';

// Stands for the engine: git answers for a checkout at ROOT on `branch` ('' is detached), lsof lists `ports`
// (listened on from inside ROOT), and status calls are collected. Its prompt hint draws `hint` and, as the
// terminal does, a `tail` after it; `other` stands for a mod beneath that drew its own segment on the desktop.
function engine(on: any) {
  const now = { inRepo: true, branch: 'modal-logs-metrics', ports: [] as number[], other: '', statuses: [] as unknown[] };
  const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } });
  on('process.run', ($: any, e: any) => {
    const argv = e.argv.join(' ');
    if (argv === 'git rev-parse --show-toplevel') return now.inRepo ? ran(`${ROOT}\n`) : ran('', 128);
    if (argv === 'git branch --show-current') return ran(`${now.branch}\n`);
    if (argv === 'git worktree list --porcelain') return ran(`worktree ${ROOT}\nHEAD abc\nbranch refs/heads/${now.branch}\n`);
    if (argv.startsWith('lsof -nP')) return ran(now.ports.length === 0 ? '' : `p42\n${now.ports.map(port => `n*:${port}`).join('\n')}\n`);
    if (argv.startsWith('lsof -a')) return ran(`p42\nn${ROOT}/app\n`);
    return ran('');
  });
  on('ui.status', ($: any, e: any) => {
    now.statuses.push(e.text);
    return { value: undefined };
  });
  on('ui.render', ($: any, e: any) => {
    const line = { type: 'Text', props: {}, children: [e.props.tail ? `${e.props.hint} · ${e.props.tail}` : e.props.hint] };
    if (now.other === '' || e.surface !== 'desktop') return line;
    return { type: 'Box', props: { flexDirection: 'row' }, children: [line, { type: 'Text', props: {}, children: [` · ${now.other}`] }] };
  });
  on('session.start', () => ({ cwd: ROOT }));
  on('turn.complete', () => ({ text: '' }));
  on('command.register', () => ({ value: undefined }));
  return now;
}

const hintProps = (props: object = {}) => ({ isDraft: false, isWorking: false, hint: ENGINE_HINT, ...props });

// The prompt hint as drawn on `surface`: every Text in it, in order.
async function hintLine($: any, surface: 'terminal' | 'desktop', props: object = {}, columns = 200) {
  const ui = await $.ui.mount({ plugin: 'worktrees', surface, component: 'PromptHint', props: hintProps(props), viewport: { columns, rows: 40 } });
  const line = (await ui.findAll({ type: 'Text' })).map((text: any) => text.text).join('');
  await ui.unmount();
  return line;
}

// The refresh at start and after a turn is not awaited by the mod, so a test lets it land first.
declare const setTimeout: (fn: () => void, ms: number) => unknown;
const settled = () => new Promise<void>(resolve => setTimeout(resolve, 20));
const start = async ($: any) => {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT });
  await settled();
};
const turn = async ($: any) => {
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer' });
  await settled();
};

test('the hint text and fitting it', () => {
  expect(hintText(ROOT, 'main', [])).toBe('supermods@main');
  expect(hintText(ROOT, 'main', [3000, 5173])).toBe('supermods@main · :3000 :5173');
  expect(hintText(ROOT, '', [])).toBe('supermods@detached');
  expect(fit('supermods@main', 100)).toBe('supermods@main');
  expect(fit('supermods@main', 6)).toBe('super…');
  expect(fit('supermods@main', 3)).toBe('');
});

test("the prompt hint shows repo@branch after the engine's hint on each surface, with no status line", async ($: any, on: any) => {
  const now = engine(on);
  await start($);
  for (const surface of SURFACES) expect(await hintLine($, surface)).toBe(`${ENGINE_HINT} · supermods@modal-logs-metrics`);
  now.ports = [5173, 3000];
  await turn($);
  for (const surface of SURFACES) expect(await hintLine($, surface)).toBe(`${ENGINE_HINT} · supermods@modal-logs-metrics · :3000 :5173`);
  now.branch = '';
  now.ports = [];
  await turn($);
  for (const surface of SURFACES) expect(await hintLine($, surface)).toBe(`${ENGINE_HINT} · supermods@detached`);
  expect(now.statuses).toEqual([]);
});

test("outside a repository the hint is the engine's alone", async ($: any, on: any) => {
  const now = engine(on);
  now.inRepo = false;
  await start($);
  for (const surface of SURFACES) expect(await hintLine($, surface)).toBe(ENGINE_HINT);
  expect(now.statuses).toEqual([]);
});

test("it composes with another mod's segment and gives way on a narrow line", async ($: any, on: any) => {
  const now = engine(on);
  await start($);
  // Another mod above already added its segment to the terminal's tail.
  expect(await hintLine($, 'terminal', { tail: 'CI ● passing · build' })).toBe(`${ENGINE_HINT} · CI ● passing · build · supermods@modal-logs-metrics`);
  // A mod beneath drew its segment on the desktop: both stay, after the engine's hint.
  now.other = 'CI ● passing · build';
  expect(await hintLine($, 'desktop')).toBe(`${ENGINE_HINT} · CI ● passing · build · supermods@modal-logs-metrics`);
  now.other = '';
  // The terminal cuts `tail` itself; on the desktop the segment is cut here, never the engine's hint.
  expect(await hintLine($, 'desktop', {}, ENGINE_HINT.length + 3 + 10)).toBe(`${ENGINE_HINT} · supermods…`);
  expect(await hintLine($, 'desktop', {}, ENGINE_HINT.length + 2)).toBe(ENGINE_HINT);
});
