export type GuardHold = {
  id: string;
  command: string;
  rule: string;
  impact: string[];
};

declare module 'claude-code' {
  interface PluginState {
    guard: { holds: GuardHold[]; allowed: string[]; note: string };
  }
}
