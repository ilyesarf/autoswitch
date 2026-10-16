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

function stubSession(on) {
  on('store.get', ($, e) => ({ value: e.key === 'ladder' ? LADDER : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.authorize', () => ({ value: null }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context: { tokens: 1000, window: 1000000 }, rateLimits: [] } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
}

// Force a switch to sonnet-5 the way a user would.
async function switchToSonnet5($) {
  await $.prompt.submit({ text: '!sonnet-5 hi', wait: false, origin: { kind: 'composer' } })
}

test('spinner shows the routed model after the ellipsis', async ($, on) => {
  stubSession(on)
  let drawn
  on('ui.render', ($, e) => {
    drawn = e.props
    return { type: 'Text', props: {}, children: ['spinner'] }
  })
  await switchToSonnet5($)
  const ui = await $.ui.mount({
    plugin: 'autoswitch', surface: 'terminal', component: 'Spinner', requestId: 'main',
    props: { word: 'Thinking', message: null, suffix: '…', mode: 'thinking' },
  })
  expect(drawn.suffix).toBe('… · sonnet-5')
  await ui.unmount()
})

test('prompt hint shows the routed model, and stays out of the way while typing', async ($, on) => {
  stubSession(on)
  let drawn
  on('ui.render', ($, e) => {
    drawn = e.props
    return { type: 'Text', props: {}, children: ['hint'] }
  })
  await switchToSonnet5($)
  const idle = await $.ui.mount({
    plugin: 'autoswitch', surface: 'terminal', component: 'PromptHint', requestId: 'hint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  })
  expect(drawn.hint).toBe('? for shortcuts · autoswitch: sonnet-5')
  await idle.unmount()
  const typing = await $.ui.mount({
    plugin: 'autoswitch', surface: 'terminal', component: 'PromptHint', requestId: 'hint',
    props: { isDraft: true, isWorking: false, hint: 'enter to send' },
  })
  expect(drawn.hint).toBe('enter to send')
  await typing.unmount()
})

test('nothing changes before autoswitch has picked a model', async ($, on) => {
  stubSession(on)
  let drawn
  on('ui.render', ($, e) => {
    drawn = e.props
    return { type: 'Text', props: {}, children: ['spinner'] }
  })
  const ui = await $.ui.mount({
    plugin: 'autoswitch', surface: 'terminal', component: 'Spinner', requestId: 'main',
    props: { word: 'Thinking', message: null, suffix: '…', mode: 'thinking' },
  })
  expect(drawn.suffix).toBe('…')
  await ui.unmount()
})
