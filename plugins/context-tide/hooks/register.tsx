import { atom, read, update } from 'claude-code';
import type { Register } from 'claude-code';

const COMMAND = 'tide';
const BAR_CELLS = 16;
const TREND_TURNS = 4;
const SPARK = '▁▂▃▄▅▆▇█';
// Each phase starts at this share of the compaction threshold; highest first.
const PHASES: [number, { name: string; color: string }][] = [
  [1, { name: 'flood', color: 'red' }],
  [0.7, { name: 'high tide', color: 'yellow' }],
  [0.35, { name: 'mid tide', color: 'green' }],
  [0, { name: 'low tide', color: 'cyan' }],
];

const history = atom({ plugin: 'context-tide', key: 'history' } as const, []);
const isHidden = atom({ plugin: 'context-tide', key: 'isHidden' } as const, false);

export function phaseOf(percent: number, compactAt: number): { name: string; color: string } {
  const share = percent / compactAt;
  return PHASES.find(([from]) => share >= from)![1];
}

export function bar(percent: number, cells: number): string {
  const filled = Math.round((Math.min(percent, 100) / 100) * cells);
  return '█'.repeat(filled) + '░'.repeat(cells - filled);
}

export function sparkline(percents: number[]): string {
  return percents.map(p => SPARK[Math.min(SPARK.length - 1, Math.floor((p / 100) * SPARK.length))]).join('');
}

/** Average change per turn over the last few turns, null before the second reading. */
export function trend(percents: number[]): number | null {
  const recent = percents.slice(-(TREND_TURNS + 1));
  if (recent.length < 2) return null;
  return ((recent.at(-1) ?? 0) - (recent[0] ?? 0)) / (recent.length - 1);
}

export function turnsLeft(percent: number, perTurn: number | null, compactAt: number): number | null {
  if (perTurn === null || perTurn <= 0 || percent >= compactAt) return null;
  return Math.ceil((compactAt - percent) / perTurn);
}

export function describe(percents: number[], compactAt: number): string {
  const percent = percents.at(-1) ?? 0;
  const perTurn = trend(percents);
  const parts = [`${percent}%`, phaseOf(percent, compactAt).name];
  if (perTurn !== null) parts.push(`${perTurn >= 0 ? '+' : ''}${perTurn.toFixed(1)}/turn`);
  const left = turnsLeft(percent, perTurn, compactAt);
  if (left !== null) parts.push(`~${left} turn${left === 1 ? '' : 's'} to ${compactAt}%`);
  return parts.join(' · ');
}

export const register: Register = (on, options) => {
  const compactAt = Number(options['compact_at']);
  const historyTurns = Number(options['history_turns']);

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show or hide the context tide band' });

    return next(e);
  });

  on('session.measure', async ($, e, next) => {
    const percent = e.context.percent;
    if (percent !== undefined && e.changed.includes('context')) {
      let previous: number | undefined;
      await update($, history, list => {
        previous = list[list.length - 1];
        // A fill that fell is a new window (compaction, /clear): the old readings say nothing about it.
        return previous !== undefined && percent < previous ? [percent] : [...list, percent].slice(-historyTurns);
      });
      if (previous !== undefined && previous < compactAt && percent >= compactAt) {
        $.ui.toast(`${$.plugin.name}: flood, context at ${percent}%. Compaction is near.`);
      }
    }

    return next(e);
  });

  on('command.run', { command: COMMAND }, async $ => {
    const hidden = !(await read($, isHidden));
    await update($, isHidden, () => hidden);

    return { text: hidden ? 'Tide band hidden. /tide shows it again.' : 'Tide band shown.' };
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [percents, hidden] = await Promise.all([read($, history), read($, isHidden)]);
    if (e.props.hasSurvey || percents.length === 0 || hidden) return next(e);

    const { Box, Button, Text } = $.ui.resolve(e);
    const percent = percents.at(-1) ?? 0;
    const { color } = phaseOf(percent, compactAt);
    const cells = Math.max(4, Math.min(BAR_CELLS, Math.floor(e.props.bodyColumns / 5)));

    return (
      <Box>
        <Text color={color}>≈ {bar(percent, cells)} </Text>
        <Text dimColor>{sparkline(percents)} </Text>
        <Text wrap="truncate-end">{describe(percents, compactAt)} </Text>
        <Button key="hide" label="Hide" hotkey="h" plain dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    );
  });
};
