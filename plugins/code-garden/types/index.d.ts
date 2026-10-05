export type Garden = {
  points: number;
  isWilted: boolean;
  turns: number;
};

declare module 'claude-code' {
  interface PluginState {
    'code-garden': { garden: Garden; isHidden: boolean };
  }
}
