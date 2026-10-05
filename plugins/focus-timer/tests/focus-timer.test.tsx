import { expect, mock, test } from 'claude-code/testing';

import { bar, clock as mmss, describe as describeBlock, nextPhase } from '../hooks/register';

const BAND = {
  plugin: 'focus-timer',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const;
const MINUTE = 60000;
const SETTINGS = { focusMs: 50 * MINUTE, breakMs: 10 * MINUTE, longBreakMs: 25 * MINUTE };

// Stands for the engine: a clock the test moves, collected toasts, and the engine's own empty band.
function engine(on: any) {
  const toasts: string[] = [];
  const clock = mock.clock(on);
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }));
  on('session.start', () => ({ cwd: '/work' }));
  on('turn.complete', () => ({ text: '' }));
  on('command.register', () => ({ value: undefined }));
  return { clock, toasts };
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' });
const focus = ($: any, args = '') => $.command.run({ command: 'focus-timer', args });
const turn = ($: any, agentId?: string) => $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId });

test('the pure parts: clock, bar, phases and the description', () => {
  expect(mmss(0)).toBe('00:00');
  expect(mmss(61 * 1000)).toBe('01:01');
  expect(mmss(50 * MINUTE)).toBe('50:00');
  expect(bar(50 * MINUTE, 50 * MINUTE, 8)).toBe('░░░░░░░░');
  expect(bar(25 * MINUTE, 50 * MINUTE, 8)).toBe('████░░░░');
  expect(bar(0, 50 * MINUTE, 8)).toBe('████████');
  const first = { phase: 'focus', endsAt: 50 * MINUTE, lengthMs: 50 * MINUTE, pausedLeftMs: null, rounds: 0, turns: 2 } as const;
  const rest = nextPhase(first, 50 * MINUTE, SETTINGS);
  expect(rest).toMatchObject({ phase: 'break', rounds: 1, lengthMs: 10 * MINUTE, turns: 0 });
  expect(nextPhase({ ...first, rounds: 3 }, 0, SETTINGS).lengthMs).toBe(25 * MINUTE);
  expect(nextPhase(rest, 60 * MINUTE, SETTINGS)).toMatchObject({ phase: 'focus', rounds: 1, endsAt: 110 * MINUTE });
  expect(describeBlock(first, 20 * MINUTE)).toBe('focus 30:00 · round 1 · 2 turns');
  expect(describeBlock({ ...first, pausedLeftMs: 5000 }, 0)).toBe('focus, paused 00:05 · round 1 · 2 turns');
});

test('/focus-timer starts a block the band counts down on each surface, and the phases switch with a toast', async ($: any, on: any) => {
  const { clock, toasts } = engine(on);
  await start($);
  const quiet = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await quiet.find({ type: 'Text', text: 'engine' })).toBeDefined();
  await quiet.unmount();
  expect((await focus($)).text).toBe('Focus for 50 min. The band above the prompt counts it down.');
  await turn($, 'agent-1');
  await turn($);
  await clock.advance(20 * MINUTE);
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect(await ui.find({ type: 'Text', text: 'focus 30:00 · round 1 · 1 turn' })).toBeDefined();
    await ui.unmount();
  }
  await clock.advance(30 * MINUTE);
  expect(toasts).toEqual(['Focus block 1 done. Break for 10 min.']);
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'break 10:00 · round 2 · 0 turns' })).toBeDefined();
  await clock.advance(10 * MINUTE);
  expect(toasts[1]).toBe('Break over. Focus for 50 min.');
  expect(await ui.find({ type: 'Text', text: 'focus 50:00 · round 2 · 0 turns' })).toBeDefined();
});

test('pause holds the clock, skip ends the phase early, stop removes the band', async ($: any, on: any) => {
  const { clock, toasts } = engine(on);
  await start($);
  await focus($, '10');
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  await ui.press({ key: 'focus-pause' });
  await clock.advance(5 * MINUTE);
  expect(await ui.find({ type: 'Text', text: 'focus, paused 10:00 · round 1 · 0 turns' })).toBeDefined();
  expect(await ui.find({ type: 'Button', text: 'Resume' })).toBeDefined();
  await ui.press({ key: 'focus-pause' });
  await clock.advance(1 * MINUTE);
  expect(await ui.find({ type: 'Text', text: 'focus 09:00 · round 1 · 0 turns' })).toBeDefined();
  await ui.press({ key: 'focus-skip' });
  expect(toasts).toEqual(['Focus block 1 done. Break for 10 min.']);
  await ui.press({ key: 'focus-stop' });
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined();
  expect((await focus($, 'stop')).text).toBe('No focus timer is running.');
});

test('/focus-timer pause and /focus-timer stop, and a bad argument', async ($: any, on: any) => {
  const { clock } = engine(on);
  await start($);
  expect((await focus($, 'pause')).text).toContain('No focus timer');
  expect((await focus($, 'soon')).text).toBe('Usage: /focus-timer [minutes, up to 180] | pause | stop');
  expect((await focus($, 'Infinity')).text).toContain('Usage');
  expect((await focus($, '500')).text).toContain('Usage');
  await focus($, '2');
  expect((await focus($, 'pause')).text).toBe('Focus timer paused.');
  await clock.advance(5 * MINUTE);
  expect((await focus($, 'pause')).text).toBe('Focus timer resumed.');
  await clock.advance(2 * MINUTE);
  expect((await focus($, 'stop')).text).toBe('Focus timer stopped after 1 finished block.');
});

test('the lengths come from the options and the fourth break is long', { options: { focus_minutes: 1, break_minutes: 1, long_break_minutes: 3 } }, async ($: any, on: any) => {
  const { clock, toasts } = engine(on);
  await start($);
  expect((await focus($)).text).toContain('Focus for 1 min');
  await clock.advance(7 * MINUTE);
  expect(toasts).toEqual([
    'Focus block 1 done. Break for 1 min.',
    'Break over. Focus for 1 min.',
    'Focus block 2 done. Break for 1 min.',
    'Break over. Focus for 1 min.',
    'Focus block 3 done. Break for 1 min.',
    'Break over. Focus for 1 min.',
    'Focus block 4 done. Break for 3 min.',
  ]);
});
