import { atom, read, update } from 'claude-code';
import type { EngineInterface, PluginOptions, Register } from 'claude-code';

import type { GuardHold } from '../../types';

const PANE = 'guard';
const POLL_SECONDS = 1;
const IMPACT_TIMEOUT_MS = 5000;
const IMPACT_LINES = 8;
// Where one shell command ends and the next begins.
const SEGMENT_END = /\s*(?:\|\|?|&&|;|\n)\s*/;
const WORD = /"([^"]*)"|'([^']*)'|(\S+)/g;

type Decision = 'run' | 'block' | 'allow';
type Impact = 'deleted paths' | 'uncommitted' | 'cleaned' | 'pushed';
/** A command segment trips a rule when every pattern of `all` matches it and `unless` does not. */
type Rule = { name: string; all: RegExp[]; unless?: RegExp; impact?: Impact };
type Pending = { decision: Decision | null };

const holds = atom({ plugin: 'guard', key: 'holds' } as const, []);
const allowed = atom({ plugin: 'guard', key: 'allowed' } as const, []);
const note = atom({ plugin: 'guard', key: 'note' } as const, '');

async function run($: EngineInterface, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    return await $.process.run(argv, { timeoutMs: IMPACT_TIMEOUT_MS });
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: messageOf(error) };
  }
}

function lines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean);
}

async function count($: EngineInterface, argv: string[], noun: string): Promise<string[]> {
  const ran = await run($, argv);
  if (ran.exitCode !== 0) return [];
  const n = lines(ran.stdout).length;
  return [`${n} ${noun}${n === 1 ? '' : 's'}`];
}

/** The paths an `rm` segment names: its words after the flags, quotes honoured, everything after `--` a path. */
export function rmTargets(segment: string): string[] {
  const after = segment.slice(segment.search(/\brm\s/) + 3);
  const targets: string[] = [];
  let isFlag = true;
  for (const [, double, single, bare] of after.matchAll(WORD)) {
    const word = double ?? single ?? bare ?? '';
    if (isFlag && word === '--') isFlag = false;
    else if (isFlag && bare !== undefined && word.startsWith('-')) continue;
    else targets.push(word);
  }
  return targets;
}

/** What the held command would destroy, as short lines for the pane; read-only commands only. */
async function impactOf($: EngineInterface, impact: Impact | undefined, segment: string): Promise<string[]> {
  switch (impact) {
    case 'deleted paths': {
      const targets = rmTargets(segment);
      if (targets.length === 0) return [];
      const ran = await run($, ['du', '-sh', '--', ...targets]);
      return [...lines(ran.stdout), ...lines(ran.stderr)];
    }
    case 'uncommitted':
      return count($, ['git', 'status', '--porcelain'], 'uncommitted file');
    case 'cleaned':
      return count($, ['git', 'clean', '-nd'], 'path');
    case 'pushed':
      return (
        await Promise.all([
          count($, ['git', 'rev-list', '@{u}..HEAD'], 'local commit'),
          count($, ['git', 'rev-list', 'HEAD..@{u}'], 'remote-only commit overwritten'),
        ])
      ).flat();
    default:
      return [];
  }
}

export const RULES: Rule[] = [
  { name: 'recursive delete', all: [/\brm\s/, /\s(-[a-zA-Z]*[rR]|--recursive)/], impact: 'deleted paths' },
  { name: 'hard reset', all: [/\bgit\s+reset\b/, /\s--hard\b/], impact: 'uncommitted' },
  { name: 'discard changes', all: [/\bgit\s+(checkout|restore)\b/, /\s(--\s+)?\.(\s|$)/], impact: 'uncommitted' },
  {
    name: 'untracked clean',
    all: [/\bgit\s+clean\b/, /\s(-[a-zA-Z]*[fd]|--force)/],
    unless: /\s(-[a-zA-Z]*n[a-zA-Z]*|--dry-run)\b/,
    impact: 'cleaned',
  },
  { name: 'force push', all: [/\bgit\s+push\b/, /\s(--force(-with-lease|-if-includes)?\b|-[a-zA-Z]*f|\+\w)/], impact: 'pushed' },
  {
    name: 'force branch delete',
    all: [/\bgit\s+branch\b/, /\s-[a-zA-Z]*D\b|\s(-[a-zA-Z]*d|--delete)\b.*\s(-[a-zA-Z]*f|--force)\b|\s(-[a-zA-Z]*f|--force)\b.*\s(-[a-zA-Z]*d|--delete)\b/],
  },
  { name: 'sql wipe', all: [/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i] },
  { name: 'world-writable', all: [/\bchmod\b/, /\s(-[a-zA-Z]*R|--recursive)\b/, /\s[0-7]?777\b/] },
  { name: 'disk overwrite', all: [/\b(mkfs(\.\w+)?\s|dd\s+if=)/] },
];

export function extraRules(options: PluginOptions): Rule[] {
  const patterns = options['bash_extra_patterns'];
  if (!Array.isArray(patterns)) return [];
  return patterns.flatMap((source, index) => {
    try {
      return [{ name: `extra pattern ${index + 1}`, all: [new RegExp(source)] }];
    } catch {
      return [];
    }
  });
}

/** The first rule a segment of the command trips, with that segment. */
export function tripped(command: string, rules: Rule[]): { rule: Rule; segment: string } | undefined {
  for (const segment of command.split(SEGMENT_END)) {
    const rule = rules.find(one => one.all.every(pattern => pattern.test(segment)) && !one.unless?.test(segment));
    if (rule !== undefined) return { rule, segment };
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Waits for a button; time inside a `$` call is free, so the wait is a chain of short sleeps on the host. */
async function awaitDecision($: EngineInterface, signal: AbortSignal, pending: Pending, holdMs: number): Promise<Decision | 'timeout'> {
  for (let waitedMs = 0; pending.decision === null; waitedMs += POLL_SECONDS * 1000) {
    if (signal.aborted) return 'block';
    if (waitedMs > holdMs) return 'timeout';
    await $.process.run(['sleep', String(POLL_SECONDS)], { timeoutMs: 5000 });
  }
  return pending.decision;
}

async function askInDialog($: EngineInterface, held: GuardHold): Promise<Decision | 'unseen'> {
  try {
    const answer = await $.ui.ask(`Guard: run this ${held.rule}? ${held.command}`, ['Run it', 'Block it']);
    return answer === 'Run it' ? 'run' : 'block';
  } catch {
    return 'unseen';
  }
}

export const destructiveBash: Register = (on, options) => {
  const rules = [...RULES, ...extraRules(options)];
  const holdMs = Number(options['bash_hold_seconds']) * 1000;
  // One slot per held call, by the hold's id; the pane decides the oldest.
  const pending = new Map<string, Pending>();
  let nextId = 0;

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const trip = tripped(e.command, rules);
    if (trip === undefined || (await read($, allowed)).includes(trip.rule.name)) return next(e);

    const id = e.tool_use_id ?? `hold-${(nextId += 1)}`;
    const slot: Pending = { decision: null };
    let decision: Decision | 'timeout' | 'unseen' | 'failed' = 'failed';
    let failure = '';
    try {
      const impact = (await impactOf($, trip.rule.impact, trip.segment)).slice(0, IMPACT_LINES);
      const held: GuardHold = { id, command: e.command, rule: trip.rule.name, impact };
      pending.set(id, slot);
      await update($, holds, list => [...list, held]);
      const opened = await $.ui.open({ id: PANE, title: 'Guard', focus: true, rows: 12 });
      decision = opened.isPlaced ? await awaitDecision($, next.signal, slot, holdMs) : await askInDialog($, held);
    } catch (error) {
      failure = messageOf(error);
    } finally {
      pending.delete(id);
      const left = await update($, holds, list => list.filter(one => one.id !== id));
      if (left.length === 0) await $.ui.close({ id: PANE }).catch(() => undefined);
    }

    if (decision === 'allow') await update($, allowed, list => [...list, trip.rule.name]);
    if (decision === 'run' || decision === 'allow') {
      await update($, note, () => `Ran: ${e.command}`);
      return next(e);
    }
    await update($, note, () => `Blocked: ${e.command}`);
    const why = {
      block: 'the user blocked it',
      timeout: 'nobody answered in time',
      unseen: 'nobody could be asked',
      failed: `the hold failed (${failure})`,
    }[decision];
    return { deny: `${$.plugin.name} held this command (${trip.rule.name}) and ${why}. Do not retry it; ask the user before doing anything destructive.` };
  });

  on('ui.close', { id: PANE }, ($, e, next) => {
    if (e.origin.kind === 'person') for (const slot of pending.values()) slot.decision = 'block';

    return next(e);
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e);
    const [[held, ...waiting], last] = await Promise.all([read($, holds), read($, note)]);

    if (held === undefined) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Nothing is held.</Text>
          {last !== '' && <Text dimColor>{last}</Text>}
        </Box>
      );
    }

    const decide = (decision: Decision) => () => {
      const slot = pending.get(held.id);
      if (slot !== undefined) slot.decision = decision;
    };

    return (
      <Box flexDirection="column">
        <Text color="red" bold>
          ⚠ {held.rule}
        </Text>
        <Text wrap="wrap">{held.command}</Text>
        {held.impact.map(line => (
          <Text color="yellow" wrap="truncate-end">
            {line}
          </Text>
        ))}
        <Box>
          <Button key="run" label="Run once" hotkey="y" variant="primary" onPress={decide('run')} />
          <Button key="block" label="Block" hotkey="n" onPress={decide('block')} />
          <Button key="allow" label="Allow this rule for the session" hotkey="a" onPress={decide('allow')} />
        </Box>
        {waiting.length > 0 && <Text dimColor>{waiting.length} more held behind this one.</Text>}
      </Box>
    );
  });
};
