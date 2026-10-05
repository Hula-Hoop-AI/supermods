declare module 'claude-code' {
  interface PluginState {
    'ci-beacon': { seen: Record<string, string> };
  }
}
