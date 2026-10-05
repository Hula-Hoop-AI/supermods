export type FocusPhase = 'focus' | 'break';

export type FocusBlock = {
  phase: FocusPhase;
  /** When the phase ends, in `$.clock.now()` milliseconds. */
  endsAt: number;
  lengthMs: number;
  /** Milliseconds left while paused; null while running. */
  pausedLeftMs: number | null;
  /** Focus blocks finished so far. */
  rounds: number;
  /** Turns finished in the current phase. */
  turns: number;
};

declare module 'claude-code' {
  interface PluginState {
    'focus-timer': { block: FocusBlock | null };
  }
}
