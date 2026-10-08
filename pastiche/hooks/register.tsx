import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { PasticheVocabulary } from '../types'

// Owed: the context lacks the vocabulary, so the next prompt that is not a
// schedule's gets it. Given: the context has it. None: nothing to teach.
// Terms: the due list the last given prompt carried, for the band.
const vocabulary = atom({ plugin: 'pastiche', key: 'vocabulary' } as const, 'owed' as PasticheVocabulary)
const terms = atom({ plugin: 'pastiche', key: 'terms' } as const, [] as readonly string[])

export const NO_READER =
  'pastiche: a schedule fired this turn (a /loop or a routine), so nobody reads it as it happens. ' +
  'Weave in no vocabulary and run no pastiche writes this turn.'

export const register: Register = on => {
  // Every SessionStart (startup, resume, clear, compact) leaves a context without
  // the vocabulary. The flag tells pastiche's settings hook beneath to leave it to
  // this mod; where no mod loads, that hook injects as it always did.
  on('classic.SessionStart', async ($, e, next) => {
    await update($, vocabulary, () => 'owed')
    return next({ ...e, pastiche_deferred: true } as typeof e)
  })

  // The settings hook cannot tell a /loop tick from a typed prompt: on 2.1.293 its
  // payload carries no `source` for either. `e.origin` can.
  on('prompt.submit', async ($, e, next) => {
    const state = await read($, vocabulary)
    if (e.origin.kind === 'scheduled-trigger') {
      return state === 'given' ? next({ ...e, context: [...(e.context ?? []), NO_READER] }) : next(e)
    }
    if (state !== 'owed') return next(e)
    const run = await $.process.run(
      ['bun', 'run', `${$.plugin.root}/hooks/session-start.ts`, '--vocabulary'],
      { stdin: JSON.stringify({ session_id: await $.session.id() }), timeoutMs: 10_000 },
    )
    if (run.exitCode !== 0) return next(e) // still owed: the next prompt tries again
    const out = JSON.parse(run.stdout) as { context?: string; terms?: string[] }
    if (typeof out.context !== 'string') {
      await update($, vocabulary, () => 'none') // nothing to teach
      return next(e)
    }
    await update($, vocabulary, () => 'given')
    await update($, terms, () => out.terms ?? [])
    return next({ ...e, context: [...(e.context ?? []), out.context] })
  }).catch(($, e, next) => next(e)) // a failure costs the prompt its vocabulary, never the prompt

  // Exposure without filler: the due terms stay in view whether or not the work
  // gives the session an opening for them. Drawing is not use; nothing is stamped.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, terms)
    if (e.props.hasSurvey || !shown.length) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor wrap="truncate-end">{shown.join('\n')}</Text>
  })
}
