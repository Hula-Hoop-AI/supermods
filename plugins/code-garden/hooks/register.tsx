import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { Garden } from '../types';

const COMMAND = 'garden';
const STORE_KEY = 'garden';
const TOOL_POINTS = 1;
const TURN_POINTS = 4;
const FAILURE_POINTS = -2;
const STAGES: [string, string][] = [
  ['🫘', 'seed'],
  ['🌱', 'sprout'],
  ['🌿', 'seedling'],
  ['🪴', 'bush'],
  ['🌸', 'bloom'],
  ['🌳', 'tree'],
];
const WILTED = '🥀';
const EMPTY: Garden = { points: 0, isWilted: false, turns: 0 };

const garden = atom({ plugin: 'code-garden', key: 'garden' } as const, EMPTY);
const isHidden = atom({ plugin: 'code-garden', key: 'isHidden' } as const, false);

function isGarden(value: unknown): value is Garden {
  return typeof value === 'object' && value !== null && typeof (value as Garden).points === 'number';
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function stageOf(points: number, stagePoints: number): number {
  return Math.min(STAGES.length - 1, Math.floor(points / stagePoints));
}

function stageAt(stage: number): [string, string] {
  return STAGES[stage]!;
}

export function describe({ points, isWilted, turns }: Garden, stagePoints: number): { glyph: string; text: string } {
  const stage = stageOf(points, stagePoints);
  const [glyph, name] = stageAt(stage);
  const next = STAGES[stage + 1];
  const parts = [isWilted ? `${name}, wilted` : name, plural(points, 'pt')];
  if (next !== undefined) parts.push(`${(stage + 1) * stagePoints - points} to ${next[1]}`);
  parts.push(plural(turns, 'turn'));
  return { glyph: isWilted ? WILTED : glyph, text: parts.join(' · ') };
}

async function grow($: EngineInterface, stagePoints: number, delta: number, isTurn = false): Promise<void> {
  // Computed inside the updater, so parallel tool calls each land their points.
  let before = EMPTY;
  const after = await update($, garden, current => {
    before = current;
    return {
      points: Math.max(0, current.points + delta),
      isWilted: delta < 0 ? true : isTurn ? false : current.isWilted,
      turns: current.turns + (isTurn ? 1 : 0),
    };
  });
  if (isTurn) await $.store.set(STORE_KEY, after);
  const stage = stageOf(after.points, stagePoints);
  if (stage > stageOf(before.points, stagePoints)) {
    const [glyph, name] = stageAt(stage);
    $.ui.toast(`${glyph} Your garden grew into a ${name}.`);
  }
}

export const register: Register = (on, options) => {
  const stagePoints = Number(options['stage_points']);

  on('session.start', async ($, e, next) => {
    const saved = await $.store.get(STORE_KEY);
    if (isGarden(saved)) await update($, garden, () => saved);
    await $.command.register({ name: COMMAND, description: 'Show or hide the garden, and report how it grows' });

    return next(e);
  });

  on('tool.call', async ($, e, next) => {
    const ran = await next(e);
    if (ran.deny === undefined) await grow($, stagePoints, ran.isError === true ? FAILURE_POINTS : TOOL_POINTS);

    return ran;
  });

  on('turn.complete', async ($, e, next) => {
    if (e.reason === 'answer' && e.agentId === undefined) await grow($, stagePoints, TURN_POINTS, true);

    return next(e);
  });

  on('command.run', { command: COMMAND }, async $ => {
    const hidden = !(await read($, isHidden));
    await update($, isHidden, () => hidden);
    const { glyph, text } = describe(await read($, garden), stagePoints);

    return { text: `${glyph} ${text}. ${hidden ? 'Garden hidden; /garden shows it again.' : 'Garden shown.'}` };
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [hidden, state] = await Promise.all([read($, isHidden), read($, garden)]);
    if (e.props.hasSurvey || hidden) return next(e);

    const { Box, Button, Text } = $.ui.resolve(e);
    const { glyph, text } = describe(state, stagePoints);

    return (
      <Box>
        <Text>{glyph} </Text>
        <Text color={state.isWilted ? 'yellow' : 'green'} dimColor={state.isWilted} wrap="truncate-end">
          {text}{' '}
        </Text>
        <Button key="hide" label="Hide" hotkey="h" plain dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    );
  });
};
