declare module 'claude-code' {
  interface PluginState {
    'context-tide': { history: number[]; isHidden: boolean };
  }
}
