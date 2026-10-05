import { expect, mock, test } from 'claude-code/testing';

import { describe as describeGarden, stageOf } from '../hooks/register';

const BAND = {
  plugin: 'garden',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const;

// Stands for the engine: tool calls succeed unless `failing`, the store starts from `saved`, toasts are collected.
function engine(on: any, saved: Record<string, unknown> = {}, beneath: unknown = { type: 'Text', props: {}, children: ['engine'] }) {
  const now = { failing: false, toasts: [] as string[] };
  mock.store(on, saved);
  on('tool.call', () => (now.failing ? { result: 'boom', isError: true, text: 'boom' } : { result: 'ok' }));
  on('turn.complete', () => ({ text: '' }));
  on('session.start', () => ({ cwd: '/work' }));
  on('command.register', () => ({ value: undefined }));
  on('ui.render', () => beneath);
  on('ui.toast', ($: any, e: any) => {
    now.toasts.push(e.text);
    return { value: undefined };
  });
  return now;
}

function turn($: any, reason = 'answer', agentId?: string) {
  return $.turn.complete({ turnId: 't', answer: 'done', durationMs: 10, isAborted: false, reason, agentId });
}

test('stages and the description', () => {
  expect(stageOf(0, 25)).toBe(0);
  expect(stageOf(24, 25)).toBe(0);
  expect(stageOf(25, 25)).toBe(1);
  expect(stageOf(999, 25)).toBe(5);
  expect(describeGarden({ points: 0, isWilted: false, turns: 0 }, 25)).toEqual({ glyph: '🫘', text: 'seed · 0 pts · 25 to sprout · 0 turns' });
  expect(describeGarden({ points: 30, isWilted: true, turns: 1 }, 25)).toEqual({ glyph: '🥀', text: 'sprout, wilted · 30 pts · 20 to seedling · 1 turn' });
  expect(describeGarden({ points: 200, isWilted: false, turns: 9 }, 25).text).toBe('tree · 200 pts · 9 turns');
});

test('tool calls and turns grow the garden, a failure wilts it, the next turn revives it', async ($: any, on: any) => {
  const now = engine(on);
  for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Read', file_path: 'a.ts' });
  await turn($);
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect(await ui.find({ type: 'Text', text: 'seed · 7 pts · 18 to sprout · 1 turn' })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: '🫘 ' })).toBeDefined();
    await ui.unmount();
  }
  now.failing = true;
  await $.tool.call({ tool: 'Bash', command: 'false' });
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'seed, wilted · 5 pts · 20 to sprout · 1 turn' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: '🥀 ' })).toBeDefined();
  now.failing = false;
  await turn($);
  expect(await ui.find({ type: 'Text', text: 'seed · 9 pts · 16 to sprout · 2 turns' })).toBeDefined();
});

test('a subagent turn or an aborted turn does not count', async ($: any, on: any) => {
  engine(on);
  await turn($, 'answer', 'agent-1');
  await turn($, 'aborted');
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /0 pts/ })).toBeDefined();
});

test('reaching a stage toasts, and stage_points comes from the options', { options: { stage_points: 5 } }, async ($: any, on: any) => {
  const now = engine(on);
  for (let i = 0; i < 4; i += 1) await $.tool.call({ tool: 'Read', file_path: 'a.ts' });
  expect(now.toasts).toEqual([]);
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' });
  expect(now.toasts).toEqual(['🌱 Your garden grew into a sprout.']);
});

test('the garden is saved after each change and loaded at session start', async ($: any, on: any) => {
  const saved: Record<string, unknown> = { garden: { points: 60, isWilted: false, turns: 4 } };
  engine(on, saved);
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' });
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'seedling · 60 pts · 15 to bush · 4 turns' })).toBeDefined();
  await turn($);
  expect(await ui.find({ type: 'Text', text: /64 pts/ })).toBeDefined();
});

test('/garden reports and toggles, as the Hide button does', async ($: any, on: any) => {
  engine(on);
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  await ui.press({ key: 'garden-hide' });
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined();
  expect((await $.command.run({ command: 'garden', args: '' })).text).toBe('🫘 seed · 0 pts · 25 to sprout · 0 turns. Garden shown.');
  expect(await ui.find({ type: 'Text', text: /seed/ })).toBeDefined();
  expect((await $.command.run({ command: 'garden', args: '' })).text).toContain('Garden hidden');
});

test('the garden stacks over another mod\'s band instead of replacing it', async ($: any, on: any) => {
  engine(on, {}, { type: 'Text', props: {}, children: ['beneath'] });
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect(await ui.find({ type: 'Text', text: /seed/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined();
    await ui.unmount();
  }
});
