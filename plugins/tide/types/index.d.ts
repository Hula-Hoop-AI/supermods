declare module 'claude-code' {
  interface PluginState {
    'tide': { history: number[]; isHidden: boolean };
  }
}
