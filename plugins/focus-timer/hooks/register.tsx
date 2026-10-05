import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { FocusBlock, FocusPhase } from '../types';

const COMMAND = 'focus';
const TICK_MS = 1000;
const BAR_CELLS = 16;
const ROUNDS_PER_LONG_BREAK = 4;
const MINUTE_MS = 60000;
const MAX_MINUTES = 180;
const COLORS: Record<FocusPhase, string> = { focus: 'magenta', break: 'cyan' };

type Settings = { focusMs: number; breakMs: number; longBreakMs: number };

const block = atom({ plugin: 'focus-timer', key: 'block' } as const, null);
// The one-second tick, alive only while a block runs unpaused.
let ticking: { cancel: () => void } | null = null;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function startBlock(phase: FocusPhase, now: number, lengthMs: number, rounds: number): FocusBlock {
  return { phase, endsAt: now + lengthMs, lengthMs, pausedLeftMs: null, rounds, turns: 0 };
}

export function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function bar(leftMs: number, lengthMs: number, cells: number): string {
  const done = Math.min(cells, Math.round(((lengthMs - leftMs) / lengthMs) * cells));
  return '█'.repeat(done) + '░'.repeat(cells - done);
}

export function leftMs(current: FocusBlock, now: number): number {
  return current.pausedLeftMs ?? Math.max(0, current.endsAt - now);
}

/** The phase that follows: a break after focus (a long one every fourth round), focus after a break. */
export function nextPhase(current: FocusBlock, now: number, settings: Settings): FocusBlock {
  if (current.phase === 'focus') {
    const rounds = current.rounds + 1;
    return startBlock('break', now, rounds % ROUNDS_PER_LONG_BREAK === 0 ? settings.longBreakMs : settings.breakMs, rounds);
  }
  return startBlock('focus', now, settings.focusMs, current.rounds);
}

export function describe(current: FocusBlock, now: number): string {
  const state = current.pausedLeftMs === null ? current.phase : `${current.phase}, paused`;
  return `${state} ${clock(leftMs(current, now))} · round ${current.rounds + 1} · ${plural(current.turns, 'turn')}`;
}

async function switchPhase($: EngineInterface, settings: Settings): Promise<void> {
  const [current, now] = await Promise.all([read($, block), $.clock.now()]);
  if (current === null) return;
  const following = nextPhase(current, now, settings);
  await update($, block, () => following);
  const minutes = Math.round(following.lengthMs / MINUTE_MS);
  $.ui.toast(following.phase === 'break' ? `Focus block ${following.rounds} done. Break for ${minutes} min.` : `Break over. Focus for ${minutes} min.`);
}

async function tick($: EngineInterface, settings: Settings): Promise<void> {
  const [current, now] = await Promise.all([read($, block), $.clock.now()]);
  if (current === null || current.pausedLeftMs !== null) {
    ticking?.cancel();
    ticking = null;
    return;
  }
  if (now >= current.endsAt) await switchPhase($, settings);
  else $.ui.invalidate('ui.render');
}

function startTicking($: EngineInterface, settings: Settings): void {
  ticking ??= $.clock.every(TICK_MS, () => void tick($, settings));
}

async function togglePause($: EngineInterface, settings: Settings): Promise<void> {
  const now = await $.clock.now();
  const toggled = await update($, block, current => {
    if (current === null) return current;
    return current.pausedLeftMs === null
      ? { ...current, pausedLeftMs: leftMs(current, now) }
      : { ...current, endsAt: now + current.pausedLeftMs, pausedLeftMs: null };
  });
  if (toggled !== null && toggled.pausedLeftMs === null) startTicking($, settings);
}

export const register: Register = (on, options) => {
  const minutes = (key: string) => Number(options[key]) * MINUTE_MS;
  const settings: Settings = { focusMs: minutes('focus_minutes'), breakMs: minutes('break_minutes'), longBreakMs: minutes('long_break_minutes') };

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Start a focus block (/focus [minutes]); /focus pause, /focus stop',
    });
    // A reload keeps the block in state but drops the old module's timer.
    const current = await read($, block);
    if (current !== null && current.pausedLeftMs === null) startTicking($, settings);

    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await update($, block, current => (current === null ? current : { ...current, turns: current.turns + 1 }));

    return next(e);
  });

  on('command.run', { command: COMMAND }, async ($, e) => {
    const word = e.args.trim();
    const current = await read($, block);
    if (word === 'stop') {
      await update($, block, () => null);
      return { text: current === null ? 'No focus timer is running.' : `Focus timer stopped after ${plural(current.rounds, 'finished block')}.` };
    }
    if (word === 'pause') {
      if (current === null) return { text: 'No focus timer is running. /focus starts one.' };
      await togglePause($, settings);
      return { text: current.pausedLeftMs === null ? 'Focus timer paused.' : 'Focus timer resumed.' };
    }
    const asked = Number(word);
    if (word !== '' && !(Number.isFinite(asked) && asked > 0 && asked <= MAX_MINUTES)) return { text: `Usage: /focus [minutes, up to ${MAX_MINUTES}] | pause | stop` };
    const lengthMs = word === '' ? settings.focusMs : asked * MINUTE_MS;
    const started = startBlock('focus', await $.clock.now(), lengthMs, current?.rounds ?? 0);
    await update($, block, () => started);
    startTicking($, settings);

    return { text: `Focus for ${Math.round(lengthMs / MINUTE_MS)} min. The band above the prompt counts it down.` };
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [current, now] = await Promise.all([read($, block), $.clock.now()]);
    if (current === null || e.props.hasSurvey) return next(e);

    const { Box, Button, Text } = $.ui.resolve(e);
    const cells = Math.max(4, Math.min(BAR_CELLS, Math.floor(e.props.bodyColumns / 5)));

    return (
      <Box>
        <Text color={COLORS[current.phase]} dimColor={current.pausedLeftMs !== null}>
          ⏱ {bar(leftMs(current, now), current.lengthMs, cells)}{' '}
        </Text>
        <Text wrap="truncate-end">{describe(current, now)} </Text>
        <Button key="pause" label={current.pausedLeftMs === null ? 'Pause' : 'Resume'} hotkey="p" plain dimColor onPress={() => togglePause($, settings)} />
        <Text> </Text>
        <Button key="skip" label="Skip" hotkey="s" plain dimColor onPress={() => switchPhase($, settings)} />
        <Text> </Text>
        <Button key="stop" label="Stop" hotkey="x" plain dimColor onPress={() => update($, block, () => null)} />
      </Box>
    );
  });
};
