export type Garden = {
  points: number;
  isWilted: boolean;
  turns: number;
};

declare module 'claude-code' {
  interface PluginState {
    'garden': { garden: Garden; isHidden: boolean };
  }
}
