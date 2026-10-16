import { expect, test } from 'claude-code/testing'

const recent = new Date().toISOString()
const LADDER = {
  at: Date.now(),
  credits: false,
  models: [
    { id: 'claude-haiku-5-5', family: 'haiku', version: [5, 5], window: 1000000, created: recent },
    { id: 'claude-sonnet-5', family: 'sonnet', version: [5], window: 1000000, created: recent },
    { id: 'claude-opus-5-5', family: 'opus', version: [5, 5], window: 1000000, created: recent },
  ],
}

// A session on `model` with `tokens` of context, where the rater answers `score`.
function stubSession(on, { model, tokens, score, store = new Map() }) {
  const calls = { compact: 0 }
  store.set('ladder', LADDER)
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.authorize', () => ({ value: null }))
  on('session.model', () => ({ value: model }))
  on('session.usage', () => ({ value: { context: { tokens, window: 1000000 }, rateLimits: [] } }))
  on('session.compact', () => {
    calls.compact++
    return { messages: [{ role: 'user', text: 'summary of the conversation', toolUses: [] }] }
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: String(score) } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  let suffix
  on('ui.render', ($, e) => {
    suffix = e.props.suffix
    return { type: 'Text', props: {}, children: ['spinner'] }
  })
  return { calls, store, spinner: async ($) => {
    const ui = await $.ui.mount({
      plugin: 'autoswitch', surface: 'terminal', component: 'Spinner', requestId: 'main',
      props: { word: 'Thinking', message: null, suffix: '…', mode: 'thinking' },
    })
    await ui.unmount()
    return suffix
  } }
}

const prompt = (text) => ({ text, wait: false, origin: { kind: 'composer' } })
const turnDone = { turnId: 't1', answer: 'ok', durationMs: 1, isAborted: false, usage: null }

test('a downgrade with a big context waits for the turn to end, compacts, then switches', async ($, on) => {
  const s = stubSession(on, { model: 'claude-opus-5-5', tokens: 200000, score: 1 })
  await $.prompt.submit(prompt('thanks'))
  // This turn stays on the stronger model; nothing compacted under it.
  expect(s.calls.compact).toBe(0)
  expect(await s.spinner($)).toBe('… · opus-5-5')
  await $.turn.complete(turnDone)
  expect(s.calls.compact).toBe(1)
  expect(await s.spinner($)).toBe('… · haiku-5-5')
})

test('a downgrade with a small context switches right away', async ($, on) => {
  const s = stubSession(on, { model: 'claude-opus-5-5', tokens: 5000, score: 1 })
  await $.prompt.submit(prompt('thanks'))
  expect(await s.spinner($)).toBe('… · haiku-5-5')
  await $.turn.complete(turnDone)
  expect(s.calls.compact).toBe(0)
})

test('an upgrade switches right away and never compacts', async ($, on) => {
  const s = stubSession(on, { model: 'claude-haiku-5-5', tokens: 200000, score: 10 })
  await $.prompt.submit(prompt('redesign the storage layer'))
  expect(await s.spinner($)).toBe('… · opus-5-5')
  await $.turn.complete(turnDone)
  expect(s.calls.compact).toBe(0)
})

test('reset forgets learned credit failures and rebuilds the ladder', async ($, on) => {
  const store = new Map([['needsCredits', ['claude-sonnet-5']]])
  stubSession(on, { model: 'claude-opus-5-5', tokens: 0, score: 5, store })
  on('command.register', () => ({ value: undefined }))
  await $.command.run({ command: 'autoswitch', args: 'reset', origin: { kind: 'composer' } })
  expect(store.get('needsCredits')).toEqual([])
})
