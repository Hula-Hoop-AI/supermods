export type TripwireHold = {
  id: string;
  command: string;
  rule: string;
  impact: string[];
};

declare module 'claude-code' {
  interface PluginState {
    tripwire: { holds: TripwireHold[]; allowed: string[]; note: string };
  }
}
