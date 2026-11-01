export type EnhancerNote = string | null
export type EnhancerPhase = 'idle' | 'working' | 'clarifying' | 'preview'

export type EnhancerQuestion = {
  question: string
  options: string[]
  recommended: number | null
  round: number
  maxRounds: number
}

export type EnhancerPreview = {
  original: string
  enhanced: string
  mode: 'quick' | 'smart' | 'deep'
  profile: 'claude' | 'gpt' | 'reasoning' | 'gemini' | 'universal'
  task: string
  score: number
  issues: string[]
  skills: string[]
  dropped: string[]
  assumptions: string[]
  answers: string[]
  redacted: number
  compare: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-enhancer-plus': {
      phase: EnhancerPhase
      step: string
      note: EnhancerNote
      question: EnhancerQuestion | null
      preview: EnhancerPreview | null
      mode: 'quick' | 'smart' | 'deep'
      version: number
      focusKey: string | null
    }
  }
}
