// autoswitch: rate each prompt's difficulty and send the turn to the matching model.

// Weakest to strongest. Within a family, higher versions rank higher.
const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable']
const LADDER_TTL_MS = 24 * 60 * 60 * 1000

let ladder = [] // [{ id, family, version, window }], weakest first

// "claude-sonnet-4-5-20250929" -> [4, 5]; a trailing date is not part of the version.
function parseVersion(id, family) {
  return id.slice(id.indexOf(family) + family.length).split('-').filter(p => /^\d{1,3}$/.test(p)).map(Number)
}

function compareModels(a, b) {
  const byFamily = FAMILIES.indexOf(a.family) - FAMILIES.indexOf(b.family)
  if (byFamily) return byFamily
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const d = (a.version[i] ?? 0) - (b.version[i] ?? 0)
    if (d) return d
  }
  return 0
}

async function listModels($) {
  const auth = await $.session.authorize()
  if (!auth) return []
  const res = await $.http.fetch('https://api.anthropic.com/v1/models?limit=1000', {
    auth: auth.handle,
    headers: { 'anthropic-version': '2023-06-01' },
  })
  if (!res.ok) return []
  return JSON.parse(res.text).data
    .filter(m => m.lifecycle === 'active' && FAMILIES.includes(m.line))
    .map(m => ({ id: m.id, family: m.line, version: parseVersion(m.id, m.line), window: m.max_input_tokens }))
}

// Listed is not the same as usable (e.g. a family that needs API credits), so try each one.
async function usable($, model) {
  try {
    await $.model.complete({ model: model.id, prompt: 'ok', maxTokens: 1 })
    return true
  } catch {
    return false
  }
}

async function discover($, force) {
  const cached = await $.store.get('ladder')
  if (!force && cached && Date.now() - cached.at < LADDER_TTL_MS) return cached.models
  const listed = await listModels($)
  const checks = []
  for (const m of listed) checks.push(usable($, m))
  const ok = await Promise.all(checks)
  const models = listed.filter((m, i) => ok[i]).sort(compareModels)
  if (models.length) await $.store.set('ladder', { at: Date.now(), models })
  return models
}

function describeLadder() {
  if (!ladder.length) return 'No models discovered yet.'
  return 'Ladder (weakest → strongest):\n' +
    ladder.map((m, i) => `  ${i + 1}. ${m.id}${m.id === current ? '  ← current' : ''}`).join('\n')
}

const RUBRIC = `Rate how hard this request to a coding assistant is, from 1 to 10.
1-2: chit-chat, acknowledgements, trivial questions or one-line edits.
3-5: routine, well-scoped work.
6-8: multi-step work that needs care and judgment.
9-10: ambiguous, open-ended, or deep problems: architecture, tricky debugging, large changes.
Reply with the number only.`

const OVERRIDE = /^\s*!([\w.-]+)\s*/

// Prompts the user sent themselves; notifications and plugin prompts keep the current model.
const USER_ORIGINS = ['composer', 'bridge', 'sdk']

let current = null // model id the main conversation is routed to; null = the session's own
let lastPrompt = ''

// The newest model of the weakest family: cheap, but not an outdated judge.
function rater() {
  const weakest = ladder.filter(m => m.family === ladder[0].family)
  return weakest[weakest.length - 1].id
}

async function rate($, text) {
  const prompt = RUBRIC +
    (lastPrompt ? `\n\nPrevious request, for context only:\n${lastPrompt.slice(0, 2000)}` : '') +
    `\n\nRequest to rate:\n${text.slice(0, 4000)}`
  const reply = await $.model.complete({ model: rater(), prompt, maxTokens: 5 })
  // Newer builds answer { text, usage }, older ones a plain string.
  const answer = typeof reply === 'string' ? reply : reply?.text ?? ''
  const score = Number(answer.match(/\d+/)?.[0])
  return score >= 1 && score <= 10 ? score : null
}

// "!opus" -> strongest opus; "!sonnet-5" -> claude-sonnet-5 exactly.
function findOverride(name) {
  const exact = ladder.find(m => m.id === name || m.id === 'claude-' + name)
  if (exact) return exact.id
  const matches = ladder.filter(m => m.id.includes(name))
  return matches.length ? matches[matches.length - 1].id : null
}

// Don't hop one rung for a slightly different score: every switch costs a cold cache.
function pick(score) {
  const target = Math.round(((score - 1) / 9) * (ladder.length - 1))
  const at = ladder.findIndex(m => m.id === current)
  if (at !== -1 && Math.abs(target - at) <= 1) return current
  return ladder[target].id
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'autoswitch',
      description: 'Show the model ladder; "refresh" re-discovers models',
      argumentHint: '[refresh]',
    })
    // Don't hold up the session; switching starts once the ladder is known.
    discover($, false).then(models => { ladder = models }, () => {})
    return next(e)
  })

  on('command.run', { command: 'autoswitch' }, async ($, e) => {
    if (e.args.trim() === 'refresh') ladder = await discover($, true)
    else if (!ladder.length) ladder = await discover($, false)
    return { text: describeLadder() }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!USER_ORIGINS.includes(e.origin?.kind)) return next(e)
    if (!ladder.length) ladder = await discover($, false).catch(() => [])
    if (!ladder.length) return next(e)

    const forced = e.text.match(OVERRIDE)
    const forcedId = forced && findOverride(forced[1].toLowerCase())
    const text = forcedId ? e.text.replace(OVERRIDE, '') : e.text

    let chosen = forcedId
    let why = 'forced'
    if (!chosen) {
      const score = await rate($, text).catch(() => null)
      lastPrompt = text
      // Rating failed: leave the model as it is.
      if (score === null) return next(e)
      chosen = pick(score)
      why = 'score ' + score
    }
    lastPrompt = text

    if (chosen !== current) $.ui.toast(`autoswitch → ${chosen} (${why})`)
    current = chosen
    return next(forcedId ? { ...e, text } : e)
  })

  // Main conversation only; subagents keep whatever model they were given.
  on('turn.step', async function* ($, e, next) {
    if (!current || e.agentId) return yield* next(e)
    while (true) {
      const stream = next({ ...e, model: current })
      // Engine chunks are held until the model produces something, so the error
      // notice of a failed request can be dropped instead of shown.
      let held = []
      let step
      while (!(step = await stream.next()).done) {
        if (held && step.value.kind === 'engine') {
          held.push(step.value)
          continue
        }
        if (held) {
          for (const chunk of held) yield chunk
          held = null
        }
        yield step.value
      }
      const result = step.value
      // A request that failed before any response (e.g. no credits for that model):
      // drop the model for good and retry one rung down.
      const failed = held !== null && result?.stopReason == null && !next.signal.aborted
      if (!failed) for (const chunk of held ?? []) yield chunk
      const at = ladder.findIndex(m => m.id === current)
      if (!failed) return result
      if (at <= 0) {
        for (const chunk of held) yield chunk
        return result
      }
      const dropped = current
      ladder = ladder.filter(m => m.id !== dropped)
      await $.store.set('ladder', { at: Date.now(), models: ladder })
      current = ladder[at - 1].id
      $.ui.toast(`autoswitch: ${dropped} failed, using ${current}`)
    }
  })
}
