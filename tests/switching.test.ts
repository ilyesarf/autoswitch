import { expect, mock, test } from 'claude-code/testing'

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
function stubSession(on, { model, tokens, score, store = new Map(), compactSkip = null }) {
  const calls = { compact: 0, sent: [], filled: [] }
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
    if (compactSkip) return { skip: compactSkip }
    return { messages: [{ role: 'user', text: 'summary of the conversation', toolUses: [] }] }
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: String(score) } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    calls.sent.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    calls.filled.push(e.text)
    return { isFilled: true }
  })
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
test('a downgrade with a big context compacts first, then re-sends the prompt to the cheaper model', async ($, on) => {
  const clock = mock.clock(on)
  const s = stubSession(on, { model: 'claude-opus-5-5', tokens: 200000, score: 1 })
  const first = await $.prompt.submit(prompt('thanks'))
  // Dropped: the host refuses compaction while the prompt is held.
  expect(first.drop).toMatch(/compacting before switching to haiku-5-5/)
  expect(s.calls.compact).toBe(0)
  await clock.advance(0)
  expect(s.calls.compact).toBe(1)
  expect(s.calls.filled).toEqual([''])
  // The user's prompt went through once (the drop) and was re-sent once, unchanged.
  expect(s.calls.sent).toEqual(['thanks'])
  expect(await s.spinner($)).toBe('… · haiku-5-5')
})

test('if compaction fails, the prompt is re-sent to the current model', async ($, on) => {
  const clock = mock.clock(on)
  const s = stubSession(on, { model: 'claude-opus-5-5', tokens: 200000, score: 1, compactSkip: 'vetoed' })
  await $.prompt.submit(prompt('thanks'))
  await clock.advance(0)
  expect(s.calls.sent).toEqual(['thanks'])
  expect(await s.spinner($)).toBe('… · opus-5-5')
})

test('a downgrade with a small context switches right away', async ($, on) => {
  const s = stubSession(on, { model: 'claude-opus-5-5', tokens: 5000, score: 1 })
  await $.prompt.submit(prompt('thanks'))
  expect(await s.spinner($)).toBe('… · haiku-5-5')
  expect(s.calls.compact).toBe(0)
})

test('an upgrade switches right away and never compacts', async ($, on) => {
  const s = stubSession(on, { model: 'claude-haiku-5-5', tokens: 200000, score: 10 })
  await $.prompt.submit(prompt('redesign the storage layer'))
  expect(await s.spinner($)).toBe('… · opus-5-5')
  expect(s.calls.compact).toBe(0)
})

test('reset forgets learned credit failures and rebuilds the ladder', async ($, on) => {
  const store = new Map([['needsCredits', ['claude-sonnet-5']]])
  stubSession(on, { model: 'claude-opus-5-5', tokens: 0, score: 5, store })
  on('command.register', () => ({ value: undefined }))
  await $.command.run({ command: 'autoswitch', args: 'reset', origin: { kind: 'composer' } })
  expect(store.get('needsCredits')).toEqual([])
})
