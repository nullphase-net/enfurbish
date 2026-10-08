import { expect, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { NO_READER } from './register'

const VOCAB = { context: 'VOCAB', terms: ['es: la red — network', 'km: ទឹក (teuk) — water'] }

const typed = { text: 'hi', wait: false, origin: { kind: 'composer' } } as const
const tick = { text: 'say tick', wait: false, origin: { kind: 'scheduled-trigger' } } as const

const BAND = {
  plugin: 'pastiche',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 }, view: {},
  },
} as const

// Beneath the mod: the engine's own answers, and a fake of the child it runs.
function engine(on: On, child: { exitCode: number; out: unknown } = { exitCode: 0, out: VOCAB }) {
  const runs: (readonly string[])[] = []
  const contexts: (readonly string[] | undefined)[] = []
  const flags: unknown[] = []
  on('classic.SessionStart', async ($, e) => {
    flags.push((e as { pastiche_deferred?: unknown }).pastiche_deferred)
    return {}
  })
  on('process.run', async ($, e) => {
    runs.push(e.argv)
    return {
      value: {
        exitCode: child.exitCode, stdout: JSON.stringify(child.out), stderr: '',
        isStdoutTruncated: false, isStderrTruncated: false,
      },
    }
  })
  on('session.id', async () => ({ value: 'sid' }))
  on('prompt.submit', async ($, e) => {
    contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine') as RenderElement
  })
  return { runs, contexts, flags }
}

test('SessionStart tells the settings hook beneath to leave the vocabulary to the mod', async ($, on) => {
  const { flags } = engine(on)
  await $.classic.SessionStart({ source: 'startup' })
  expect(flags).toEqual([true])
})

test('the first typed prompt carries the vocabulary, and only the first', async ($, on) => {
  const { runs, contexts } = engine(on)
  await $.classic.SessionStart({ source: 'startup' })
  await $.prompt.submit(typed)
  await $.prompt.submit(typed)
  expect(contexts).toEqual([['VOCAB'], undefined])
  expect(runs.length).toBe(1)
  expect(runs[0]?.at(-1)).toBe('--vocabulary')
})

test("a schedule's prompt gets no vocabulary, and once the context has it, the no-reader line", async ($, on) => {
  const { runs, contexts } = engine(on)
  await $.classic.SessionStart({ source: 'startup' })
  await $.prompt.submit(tick)
  expect(runs.length).toBe(0)
  await $.prompt.submit(typed)
  await $.prompt.submit(tick)
  expect(contexts).toEqual([undefined, ['VOCAB'], [NO_READER]])
})

test('a compaction owes the vocabulary to the next typed prompt, not to a tick', async ($, on) => {
  const { runs, contexts } = engine(on)
  await $.classic.SessionStart({ source: 'startup' })
  await $.prompt.submit(typed)
  await $.classic.SessionStart({ source: 'compact' })
  await $.prompt.submit(tick)
  await $.prompt.submit(typed)
  expect(contexts).toEqual([['VOCAB'], undefined, ['VOCAB']])
  expect(runs.length).toBe(2)
})

test('nothing to teach settles the debt', async ($, on) => {
  const { runs, contexts } = engine(on, { exitCode: 0, out: {} })
  await $.classic.SessionStart({ source: 'startup' })
  await $.prompt.submit(typed)
  await $.prompt.submit(typed)
  await $.prompt.submit(tick)
  expect(contexts).toEqual([undefined, undefined, undefined])
  expect(runs.length).toBe(1)
})

test('a failed run leaves the debt for the next typed prompt', async ($, on) => {
  const { runs, contexts } = engine(on, { exitCode: 1, out: '' })
  await $.classic.SessionStart({ source: 'startup' })
  await $.prompt.submit(typed)
  await $.prompt.submit(typed)
  expect(contexts).toEqual([undefined, undefined])
  expect(runs.length).toBe(2)
})

test('the band shows the terms the session was given, and nothing before', async ($, on) => {
  engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const before = await $.ui.mount({ ...BAND, surface })
    expect((await before.find({ type: 'Text' }))?.text).toBe('engine')
  }
  await $.classic.SessionStart({ source: 'startup' })
  await $.prompt.submit(typed)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text' }))?.text).toBe(VOCAB.terms.join('\n'))
  }
})
