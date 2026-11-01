export type EnhancerNote = string | null

declare module 'claude-code' {
  interface PluginState {
    'prompt-enhancer-plus': {
      isBusy: boolean
      note: EnhancerNote
      focusKey: string | null
    }
  }
}
