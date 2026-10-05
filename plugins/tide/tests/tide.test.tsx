import { expect, test } from 'claude-code/testing';

import { bar, describe as describeTide, phaseOf, sparkline, trend, turnsLeft } from '../hooks/register';

const BAND = {
  plugin: 'tide',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const;

// Stands for the engine: measurements pass through, toasts are collected, the band draws nothing of its own.
function engine(on: any) {
  const toasts: string[] = [];
  on('session.measure', ($: any, e: any) => ({ changed: e.changed }));
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }));
  on('command.register', () => ({ value: undefined }));
  on('session.start', () => ({ cwd: '/work' }));
  return toasts;
}

function measure($: any, percent: number) {
  return $.session.measure({ context: { tokens: percent * 2000, window: 200000, percent }, rateLimits: [], changed: ['context'] });
}

test('the pure parts: phases, bar, sparkline, trend and turns left', () => {
  expect(phaseOf(10, 80)).toEqual({ name: 'low tide', color: 'cyan' });
  expect(phaseOf(40, 80).name).toBe('mid tide');
  expect(phaseOf(60, 80).name).toBe('high tide');
  expect(phaseOf(85, 80)).toEqual({ name: 'flood', color: 'red' });
  expect(bar(50, 8)).toBe('████░░░░');
  expect(bar(100, 4)).toBe('████');
  expect(sparkline([0, 50, 99])).toBe('▁▅█');
  expect(trend([10])).toBe(null);
  expect(trend([10, 20, 30])).toBe(10);
  expect(turnsLeft(30, 10, 80)).toBe(5);
  expect(turnsLeft(30, 0, 80)).toBe(null);
  expect(turnsLeft(90, 10, 80)).toBe(null);
  expect(describeTide([20, 30], 80)).toBe('30% · mid tide · +10.0/turn · ~5 turns to 80%');
  expect(describeTide([85], 80)).toBe('85% · flood');
});

test('the band stays quiet until the first measurement, then draws the tide on each surface', async ($: any, on: any) => {
  engine(on);
  const quiet = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await quiet.find({ type: 'Text', text: 'engine' })).toBeDefined();
  await quiet.unmount();
  await measure($, 25);
  await measure($, 31);
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect(await ui.find({ type: 'Text', text: /31% · mid tide · \+6\.0\/turn · ~9 turns to 80%/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /░/ })).toBeDefined();
    await ui.unmount();
  }
});

test('a measurement without a context change or a percent is ignored', async ($: any, on: any) => {
  engine(on);
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['cost'] });
  await $.session.measure({ context: { window: 200000, percent: 50 }, rateLimits: [], changed: ['cost'] });
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined();
});

test('crossing the threshold toasts once, and the threshold comes from the options', { options: { compact_at: 60 } }, async ($: any, on: any) => {
  const toasts = engine(on);
  await measure($, 55);
  await measure($, 62);
  await measure($, 70);
  expect(toasts).toEqual(['tide: flood, context at 62%. Compaction is near.']);
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /70% · flood/ })).toBeDefined();
});

test('a fill that fell starts the history over', async ($: any, on: any) => {
  engine(on);
  for (const percent of [60, 70, 78, 20]) await measure($, percent);
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: '20% · low tide ' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: `${sparkline([20])} ` })).toBeDefined();
});

test('the sparkline keeps only history_turns readings', { options: { history_turns: 4 } }, async ($: any, on: any) => {
  engine(on);
  for (const percent of [10, 20, 30, 40, 50, 60]) await measure($, percent);
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: sparkline([30, 40, 50, 60]) })).toBeDefined();
});

test('/tide and the Hide button toggle the band', async ($: any, on: any) => {
  engine(on);
  await measure($, 40);
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  await ui.press({ key: 'tide-hide' });
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined();
  expect((await $.command.run({ command: 'tide', args: '' })).text).toBe('Tide band shown.');
  expect(await ui.find({ type: 'Text', text: /40% · mid tide/ })).toBeDefined();
  expect((await $.command.run({ command: 'tide', args: '' })).text).toContain('hidden');
});
