import { atom, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

const COMMAND = 'ci';
const RUN_FIELDS = 'status,conclusion,workflowName,url';
const GH_TIMEOUT_MS = 15000;
// How each run state is drawn: its glyph and its word; another state draws ○ and its own name.
const STATES: Record<string, [string, string]> = {
  running: ['◌', 'running'],
  success: ['●', 'passing'],
  failure: ['✗', 'failing'],
  cancelled: ['⊘', 'cancelled'],
  timed_out: ['✗', 'timed out'],
  startup_failure: ['✗', 'startup failure'],
  action_required: ['!', 'action required'],
};

export type Run = { status: string; conclusion: string; workflowName: string; url: string };
export type Beacon = { branch: string; run: Run | null };

type Settings = { pollMs: number; workflow: string };

async function output($: EngineInterface, argv: string[]): Promise<string> {
  try {
    const ran = await $.process.run(argv, { timeoutMs: GH_TIMEOUT_MS });
    return ran.exitCode === 0 ? ran.stdout.trim() : '';
  } catch {
    return '';
  }
}

export function parseRuns(json: string): Run | null {
  try {
    const runs: unknown = JSON.parse(json);
    const first = Array.isArray(runs) ? runs[0] : undefined;
    if (typeof first !== 'object' || first === null) return null;
    const run = first as Partial<Run>;
    return {
      status: run.status ?? '',
      conclusion: run.conclusion ?? '',
      workflowName: run.workflowName ?? '',
      url: run.url ?? '',
    };
  } catch {
    return null;
  }
}

/** The run's one-word state: `running` until it completes, then its conclusion. */
export function stateOf(run: Run): string {
  return run.status === 'completed' ? run.conclusion || 'completed' : 'running';
}

function drawn(state: string): [string, string] {
  return STATES[state] ?? ['○', state.replace('_', ' ')];
}

export function statusLine({ branch, run }: Beacon): string {
  if (run === null) return `CI ○ no runs on ${branch}`;
  const [glyph, word] = drawn(stateOf(run));
  return `CI ${glyph} ${word} · ${run.workflowName}`;
}

async function fetchBeacon($: EngineInterface, { workflow }: Settings): Promise<Beacon | null> {
  const branch = await output($, ['git', 'branch', '--show-current']);
  if (branch === '') return null;
  const filter = workflow === '' ? [] : ['--workflow', workflow];
  const listing = await output($, ['gh', 'run', 'list', '--branch', branch, '--limit', '1', '--json', RUN_FIELDS, ...filter]);
  return listing === '' ? null : { branch, run: parseRuns(listing) };
}

// The last state seen per branch, so a finished run toasts once.
const seen = atom({ plugin: 'ci', key: 'seen' } as const, {});
// A refresh already running answers every caller that arrives meanwhile.
let inFlight: Promise<Beacon | null> | null = null;

function refresh($: EngineInterface, settings: Settings): Promise<Beacon | null> {
  inFlight ??= refreshNow($, settings).finally(() => (inFlight = null));
  return inFlight;
}

async function refreshNow($: EngineInterface, settings: Settings): Promise<Beacon | null> {
  const beacon = await fetchBeacon($, settings);
  $.ui.status(beacon === null ? undefined : statusLine(beacon));
  if (beacon?.run) {
    const state = stateOf(beacon.run);
    let before: string | undefined;
    await update($, seen, states => {
      before = states[beacon.branch];
      return { ...states, [beacon.branch]: state };
    });
    if (before !== undefined && before !== state && state !== 'running') {
      $.ui.toast(`CI: ${beacon.run.workflowName} is ${drawn(state)[1]} on ${beacon.branch}. ${beacon.run.url}`);
    }
  }
  return beacon;
}

export const register: Register = (on, options) => {
  const settings: Settings = { pollMs: Number(options['poll_seconds']) * 1000, workflow: String(options['workflow'] ?? '').trim() };

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Check the latest GitHub Actions run for this branch now' });
    $.clock.every(settings.pollMs, () => void refresh($, settings));
    void refresh($, settings);

    return next(e);
  });

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) void refresh($, settings);

    return next(e);
  });

  on('command.run', { command: COMMAND }, async $ => {
    const beacon = await refresh($, settings);
    if (beacon === null) return { text: 'No GitHub Actions runs to show: not on a branch, or `gh` is missing or signed out.' };

    return { text: beacon.run === null ? statusLine(beacon) : `${statusLine(beacon)} ${beacon.run.url}` };
  });
};
