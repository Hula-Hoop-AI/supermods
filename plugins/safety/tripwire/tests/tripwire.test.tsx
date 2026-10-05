import { expect, test } from 'claude-code/testing';

import { RULES, extraRules, rmTargets, tripped } from '../hooks/register';

const PANE = {
  plugin: 'tripwire',
  component: 'Pane',
  requestId: 'tripwire',
  props: { title: 'Tripwire', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const;

// Stands for the engine. Each `sleep` the hold polls with waits at a gate the test opens with `pump`,
// so a hold moves only when told; other commands answer from `commands`.
function engine(on: any, { isPlaced = true, asked = '' } = {}) {
  const commands: Record<string, string> = {};
  const tools: string[] = [];
  const now = { commands, tools, fail: '' };
  let open = () => {};
  let gate = new Promise<void>(resolve => (open = resolve));
  let waiters: (() => void)[] = [];
  let isWaiting = false;
  on('tool.call', ($: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      if (asked === '') throw new Error('dismissed');
      return { result: { answers: { [e.questions[0].question]: asked } } };
    }
    tools.push(e.command);
    return { result: { stdout: 'ran', stderr: '' } };
  });
  on('process.run', async ($: any, e: any) => {
    if (e.argv[0] === 'sleep') {
      isWaiting = true;
      waiters.splice(0).forEach(tell => tell());
      await gate;
      if (now.fail !== '') return { deny: now.fail };
    }
    const stdout = commands[e.argv.join(' ')] ?? '';
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on('ui.open', () => ({ value: { isPlaced } }));
  on('ui.close', () => ({ value: undefined }));
  return Object.assign(now, {
    held: () => (isWaiting ? Promise.resolve() : new Promise<void>(resolve => waiters.push(resolve))),
    pump: () => {
      isWaiting = false;
      open();
      gate = new Promise(resolve => (open = resolve));
    },
  });
}

test('the rules and the rm target parser', () => {
  const trips = (command: string) => tripped(command, RULES)?.rule.name;
  expect(trips('rm -rf node_modules')).toBe('recursive delete');
  expect(trips('rm -r -f ./build && ls')).toBe('recursive delete');
  expect(trips('cd app && rm --recursive --force dist')).toBe('recursive delete');
  expect(trips('rm -f notes.txt')).toBeUndefined();
  expect(trips('git reset --hard HEAD~1')).toBe('hard reset');
  expect(trips('git reset --soft HEAD~1')).toBeUndefined();
  expect(trips('git checkout -- .')).toBe('discard changes');
  expect(trips('git restore --worktree .')).toBe('discard changes');
  expect(trips('git restore src/a.ts')).toBeUndefined();
  expect(trips('git clean -fd')).toBe('untracked clean');
  expect(trips('git clean --force')).toBe('untracked clean');
  expect(trips('git clean -nd')).toBeUndefined();
  expect(trips('git clean -fd --dry-run')).toBeUndefined();
  expect(trips('git push --force origin main')).toBe('force push');
  expect(trips('git push -fu origin x')).toBe('force push');
  expect(trips('git push origin +main')).toBe('force push');
  expect(trips('git push --follow-tags origin main')).toBeUndefined();
  expect(trips('git branch -D old')).toBe('force branch delete');
  expect(trips('git branch --force --delete old')).toBe('force branch delete');
  expect(trips('git branch -d --force old')).toBe('force branch delete');
  expect(trips('git branch -d merged')).toBeUndefined();
  expect(trips('psql -c "DROP TABLE users"')).toBe('sql wipe');
  expect(trips('chmod -R 777 /srv')).toBe('world-writable');
  expect(trips('chmod 777 -R .')).toBe('world-writable');
  expect(trips('chmod -R 755 .')).toBeUndefined();
  expect(trips('dd if=/dev/zero of=/dev/sda')).toBe('disk overwrite');
  expect(trips('cat README.md')).toBeUndefined();
  expect(tripped('cd app && rm -rf dist', RULES)?.segment).toBe('rm -rf dist');
  expect(rmTargets('rm -rf ./build dist')).toEqual(['./build', 'dist']);
  expect(rmTargets('rm -r -f node_modules')).toEqual(['node_modules']);
  expect(rmTargets(`rm -rf "My Project/build" 'old dir' -- -dashed`)).toEqual(['My Project/build', 'old dir', '-dashed']);
  expect(extraRules({ extra_patterns: ['terraform\\s+destroy', '('] }).map(rule => rule.name)).toEqual(['extra pattern 1']);
});

test('a held command runs once the Run button is pressed, with its impact shown on each surface', async ($: any, on: any) => {
  const now = engine(on);
  now.commands['du -sh -- ./build'] = '1.2G\t./build';
  for (const surface of ['terminal', 'desktop'] as const) {
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf ./build' });
    await now.held();
    const ui = await $.ui.mount({ ...PANE, surface });
    expect(await ui.find({ type: 'Text', text: 'recursive delete' })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: '1.2G\t./build' })).toBeDefined();
    await ui.press({ key: 'run' });
    now.pump();
    const ran = await call;
    expect(ran.result).toEqual({ stdout: 'ran', stderr: '' });
    expect(await ui.find({ type: 'Text', text: 'Nothing is held.' })).toBeDefined();
    await ui.unmount();
  }
  expect(now.tools).toEqual(['rm -rf ./build', 'rm -rf ./build']);
});

test('Block denies the call and tells Claude not to retry', async ($: any, on: any) => {
  const now = engine(on);
  now.commands['git status --porcelain'] = ' M a.ts\n?? b.ts';
  const call = $.tool.call({ tool: 'Bash', command: 'git reset --hard' });
  await now.held();
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: '2 uncommitted files' })).toBeDefined();
  await ui.press({ key: 'block' });
  now.pump();
  const ran = await call;
  expect(ran.deny).toContain('the user blocked it');
  expect(ran.deny).toContain('hard reset');
  expect(now.tools).toEqual([]);
});

test('two held calls queue in the pane and are decided in order', async ($: any, on: any) => {
  const now = engine(on);
  const first = $.tool.call({ tool: 'Bash', tool_use_id: 'a', command: 'git reset --hard' });
  await now.held();
  const second = $.tool.call({ tool: 'Bash', tool_use_id: 'b', command: 'rm -rf dist' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'git reset --hard' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: '1 more held behind this one.' })).toBeDefined();
  await ui.press({ key: 'block' });
  now.pump();
  expect((await first).deny).toContain('the user blocked it');
  await now.held();
  expect(await ui.find({ type: 'Text', text: 'rm -rf dist' })).toBeDefined();
  await ui.press({ key: 'run' });
  now.pump();
  expect((await second).result).toBeDefined();
  expect(now.tools).toEqual(['rm -rf dist']);
});

test('a hold that fails blocks the command instead of letting it through', async ($: any, on: any) => {
  const now = engine(on);
  const call = $.tool.call({ tool: 'Bash', command: 'git reset --hard' });
  await now.held();
  now.fail = 'sleep: command not found';
  now.pump();
  const ran = await call;
  expect(ran.deny).toContain('the hold failed');
  expect(now.tools).toEqual([]);
});

test('Allow runs the command and lets the same rule pass for the rest of the session', async ($: any, on: any) => {
  const now = engine(on);
  const call = $.tool.call({ tool: 'Bash', command: 'git push --force' });
  await now.held();
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.press({ key: 'allow' });
  now.pump();
  expect((await call).result).toBeDefined();
  expect((await $.tool.call({ tool: 'Bash', command: 'git push -f origin main' })).result).toBeDefined();
  expect(now.tools).toEqual(['git push --force', 'git push -f origin main']);
});

test('a safe command never opens the pane', async ($: any, on: any) => {
  const now = engine(on);
  expect((await $.tool.call({ tool: 'Bash', command: 'ls -la' })).result).toEqual({ stdout: 'ran', stderr: '' });
  expect(now.tools).toEqual(['ls -la']);
});

test('with no room for the pane the question dialog decides', async ($: any, on: any) => {
  const yes = engine(on, { isPlaced: false, asked: 'Run it' });
  expect((await $.tool.call({ tool: 'Bash', command: 'git branch -D old' })).result).toBeDefined();
  expect(yes.tools).toEqual(['git branch -D old']);
});

test('dismissing the question dialog blocks the command', async ($: any, on: any) => {
  engine(on, { isPlaced: false });
  expect((await $.tool.call({ tool: 'Bash', command: 'git branch -D old' })).deny).toContain('nobody could be asked');
});

test('an extra pattern trips the wire too', { options: { extra_patterns: ['terraform\\s+destroy'] } }, async ($: any, on: any) => {
  const now = engine(on);
  const call = $.tool.call({ tool: 'Bash', command: 'terraform destroy -auto-approve' });
  await now.held();
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'extra pattern 1' })).toBeDefined();
  await ui.press({ key: 'block' });
  now.pump();
  expect((await call).deny).toContain('extra pattern 1');
});
