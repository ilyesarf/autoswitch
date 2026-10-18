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

// A session on `model` with `tokens` of context and `messages` in its transcript, where the
// rater answers `score` (a number, or a function of the prompt the rater was sent).
function stubSession(on, { model, tokens, score, messages = [], store = new Map(), compactSkip = null }) {
  const calls = { compact: 0, sent: [], filled: [], rated: [] }
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
  on('session.messages', () => ({ value: messages }))
  on('model.complete', ($, e) => {
    calls.rated.push(e.prompt)
    const rated = typeof score === 'function' ? score(e.prompt) : score
    return { value: { isAnswered: true, text: String(rated) } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    calls.sent.push(e.text)
    return { text: e.text }
  })
  // The prompt box, the way the host leaves it: a dropped prompt goes back into it.
  let box = ''
  on('prompt.read', () => ({ value: { text: box, cursor: box.length } }))
  on('prompt.fill', ($, e) => {
    calls.filled.push(e.text)
    box = e.text
    return { isFilled: true }
  })
  let suffix
  on('ui.render', ($, e) => {
    suffix = e.props.suffix
    return { type: 'Text', props: {}, children: ['spinner'] }
  })
  return { calls, store, setBox: (t) => { box = t }, getBox: () => box, spinner: async ($) => {
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
  expect(first.drop).toMatch(/compacting before switching to sonnet-5/)
  expect(s.calls.compact).toBe(0)
  s.setBox('thanks') // the host puts a dropped prompt back in the box
  await clock.advance(0)
  expect(s.calls.compact).toBe(1)
  // Cleared, so the person doesn't see their prompt sitting there unsent.
  expect(s.calls.filled).toEqual([''])
  expect(s.getBox()).toBe('')
  // The user's prompt went through once (the drop) and was re-sent once, unchanged.
  expect(s.calls.sent).toEqual(['thanks'])
  expect(await s.spinner($)).toBe('… · sonnet-5')
})

test('if compaction fails, the prompt is re-sent to the current model', async ($, on) => {
  const clock = mock.clock(on)
  const s = stubSession(on, { model: 'claude-opus-5-5', tokens: 200000, score: 1, compactSkip: 'vetoed' })
  await $.prompt.submit(prompt('thanks'))
  await clock.advance(0)
  expect(s.calls.sent).toEqual(['thanks'])
  expect(await s.spinner($)).toBe('… · opus-5-5')
})

test('a draft typed while compaction runs is left in the prompt box', async ($, on) => {
  const clock = mock.clock(on)
  const s = stubSession(on, { model: 'claude-opus-5-5', tokens: 200000, score: 1 })
  await $.prompt.submit(prompt('thanks'))
  s.setBox('wait, also check the ladder') // typed after the drop, before compaction ends
  await clock.advance(0)
  expect(s.getBox()).toBe('wait, also check the ladder')
  expect(s.calls.sent).toEqual(['thanks'])
})

test('a downgrade with a small context switches right away', async ($, on) => {
  const s = stubSession(on, { model: 'claude-opus-5-5', tokens: 5000, score: 1 })
  await $.prompt.submit(prompt('thanks'))
  expect(await s.spinner($)).toBe('… · sonnet-5')
  expect(s.calls.compact).toBe(0)
})

// The bug this guards: a bare "go" rated on its own reads as chit-chat, and on the first prompt
// there was no rung to measure from, so a resumed hard task fell from opus to haiku in one step.
test('a short prompt is rated on the work in flight, not on its own length', async ($, on) => {
  const s = stubSession(on, {
    model: 'claude-opus-5-5',
    tokens: 5000,
    // A rater that answers 9 only when it was shown the work in flight, 1 on the prompt alone.
    score: (asked) => (asked.includes('planner cases') ? 9 : 1),
    messages: [
      { role: 'user', text: 'compare the new planner against the baseline', toolUses: [] },
      {
        role: 'assistant',
        text: 'The comparison copy builds. Next I will regenerate the manifests and run the same planner cases.',
        toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: {} }],
      },
    ],
  })
  await $.prompt.submit(prompt('go'))
  // The tail reached the rater, tool names included.
  expect(s.calls.rated[0]).toContain('planner cases')
  expect(s.calls.rated[0]).toContain('[ran: Bash]')
  expect(await s.spinner($)).toBe('… · opus-5-5')
  expect(s.calls.compact).toBe(0)
})

test('a run of trivial prompts walks down a rung at a time', async ($, on) => {
  const s = stubSession(on, { model: 'claude-opus-5-5', tokens: 5000, score: 1 })
  await $.prompt.submit(prompt('thanks'))
  expect(await s.spinner($)).toBe('… · sonnet-5')
  await $.prompt.submit(prompt('nice'))
  expect(await s.spinner($)).toBe('… · haiku-5-5')
})

test('the session model is found by rung even when it reads as an alias', async ($, on) => {
  const s = stubSession(on, { model: 'opus', tokens: 5000, score: 1 })
  await $.prompt.submit(prompt('thanks'))
  expect(await s.spinner($)).toBe('… · sonnet-5')
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

test('each decision is logged and /autoswitch lists it', async ($, on) => {
  const s = stubSession(on, { model: 'claude-opus-5-5', tokens: 5000, score: 1 })
  on('command.register', () => ({ value: undefined }))
  await $.prompt.submit(prompt('thanks'))
  expect(s.store.get('decisions')).toMatchObject([
    { prompt: 'thanks', from: 'claude-opus-5-5', to: 'claude-sonnet-5' },
  ])
  const shown = await $.command.run({ command: 'autoswitch', args: '', origin: { kind: 'composer' } })
  expect(shown.text).toContain('opus-5-5 → sonnet-5  "thanks"')
})
