declare module 'claude-code' {
  interface PluginState {
    'ci': { seen: Record<string, string> };
  }
}
