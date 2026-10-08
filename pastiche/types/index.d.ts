/** A due term as the band shows it: `<code>: <term>`, script, romanization and gloss. */
export type PasticheTerm = string

/** Whether the context carries the vocabulary: owed to the next prompt that is not a schedule's, given, or none to teach. */
export type PasticheVocabulary = 'owed' | 'given' | 'none'

declare module 'claude-code' {
  interface PluginState {
    pastiche: { vocabulary: PasticheVocabulary; terms: readonly PasticheTerm[] }
  }
}
