// autoswitch: rate each prompt's difficulty and send the turn to the matching model.

// Weakest to strongest. Within a family, higher versions rank higher.
const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable']
const LADDER_TTL_MS = 24 * 60 * 60 * 1000
// Older versions only add weak rungs; the previous version is still a useful downgrade.
const VERSIONS_PER_FAMILY = 2

let ladder = [] // [{ id, family, version, window, created }], weakest first
let maxAgeDays = 180

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

// Sorted weakest first: models released within maxAgeDays, newest versions of each family only.
function trim(models) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const sorted = models.filter(m => Date.parse(m.created) >= cutoff).sort(compareModels)
  return sorted.filter(m => sorted.filter(o => o.family === m.family && compareModels(o, m) > 0).length < VERSIONS_PER_FAMILY)
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
    .map(m => ({ id: m.id, family: m.line, version: parseVersion(m.id, m.line), window: m.max_input_tokens, created: m.created_at }))
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

// Whether paid usage credits are on, from the account usage endpoint /usage reads.
// Undocumented, so anything unexpected counts as off.
async function hasCredits($) {
  try {
    const auth = await $.session.authorize()
    if (!auth) return false
    const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
      auth: auth.handle,
      headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' },
    })
    return res.ok && JSON.parse(res.text).extra_usage?.is_enabled === true
  } catch {
    return false
  }
}

// Models that once failed while credits were off. The 1-token check passes for them
// anyway, so it can't be trusted for these.
async function needsCredits($) {
  return (await $.store.get('needsCredits')) ?? []
}

// Models that have answered a real request while credits were off, so a later failure
// is something transient, not missing credits.
async function worked($) {
  return (await $.store.get('worked')) ?? []
}

let creditsOn = null // as last seen by discover

async function discover($, force) {
  const credits = await hasCredits($)
  creditsOn = credits
  const cached = await $.store.get('ladder')
  const fresh = cached && Date.now() - cached.at < LADDER_TTL_MS &&
    cached.credits === credits && cached.models.every(m => m.created)
  if (!force && fresh) return trim(cached.models)
  const skip = credits ? [] : await needsCredits($)
  const listed = trim(await listModels($)).filter(m => !skip.includes(m.id))
  const checks = []
  for (const m of listed) checks.push(usable($, m))
  const ok = await Promise.all(checks)
  const models = listed.filter((m, i) => ok[i])
  if (models.length) await $.store.set('ladder', { at: Date.now(), models, credits })
  return models
}

// A model failed a real request. If credits are off and it has never answered without them,
// missing credits is why, so remember it. Otherwise it's dropped for this session only.
async function markFailed($, id) {
  ladder = ladder.filter(m => m.id !== id)
  if (await hasCredits($)) return
  if ((await worked($)).includes(id)) return
  const known = await needsCredits($)
  if (!known.includes(id)) await $.store.set('needsCredits', [...known, id])
  const cached = await $.store.get('ladder')
  if (cached) await $.store.set('ladder', { ...cached, models: cached.models.filter(m => m.id !== id) })
}

async function markWorked($, id) {
  if (creditsOn !== false) return
  const known = await worked($)
  if (!known.includes(id)) await $.store.set('worked', [...known, id])
}

function describeLadder() {
  if (!ladder.length) return 'No models discovered yet.'
  return 'Ladder (weakest → strongest):\n' +
    ladder.map((m, i) => `  ${i + 1}. ${m.id}${m.id === current ? '  ← current' : ''}`).join('\n') +
    `\nLast compaction: ${lastCompaction}`
}

const RUBRIC = `Rate how hard the next turn of this conversation is for a coding assistant, from 1 to 10.
Rate the work the request asks for, not how long the request is. A short request to carry on
("go", "continue", "yes", "now do it") is exactly as hard as the work it continues, which the
conversation shows; an unfinished hard task is still hard.
1-2: chit-chat, acknowledgements, trivial questions or one-line edits, or closing out finished work.
3-5: routine, well-scoped work.
6-8: multi-step work that needs care and judgment.
9-10: ambiguous, open-ended, or deep problems: architecture, tricky debugging, large changes.
Reply with the number only.`

// How much conversation the rater reads. Enough to tell "go" with hard work in flight from "go"
// once it is done, short enough that rating stays a cheap call.
const CONTEXT_MESSAGES = 6
const CONTEXT_CHARS = 600

const OVERRIDE = /^\s*!([\w.-]+)\s*/

// Prompts the user sent themselves; notifications and plugin prompts keep the current model.
const USER_ORIGINS = ['composer', 'bridge', 'sdk']

let current = null // model id the main conversation is routed to; null = the session's own
let lastCompaction = 'none yet'
const subagents = new Set() // agent ids seen in turn.step, so their spinners are left alone

// "claude-sonnet-4-5-20250929" -> "sonnet-4-5"
function shortName(id) {
  return id.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

// The newest model of the weakest family: cheap, but not an outdated judge.
function rater() {
  const weakest = ladder.filter(m => m.family === ladder[0].family)
  return weakest[weakest.length - 1].id
}

// The tail of the conversation, oldest first: the work the next turn carries on from. Read from
// the transcript, so it is there after a resume too, where a remembered prompt would not be.
async function tail($) {
  let messages
  try {
    messages = await $.session.messages()
  } catch {
    return ''
  }
  if (!Array.isArray(messages)) return ''
  return messages.slice(-CONTEXT_MESSAGES).map(m => {
    // Which tools ran says what kind of work is in flight; their output is too bulky to pass on.
    const tools = (m.toolUses ?? []).map(u => u.tool).join(', ')
    const body = [m.text?.slice(0, CONTEXT_CHARS), tools && `[ran: ${tools}]`].filter(Boolean).join(' ')
    return body && `${m.role}: ${body}`
  }).filter(Boolean).join('\n\n')
}

async function rate($, text) {
  const context = await tail($)
  const prompt = RUBRIC +
    (context ? `\n\nThe conversation so far, for context:\n${context}` : '') +
    `\n\nThe request to rate:\n${text.slice(0, 4000)}`
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

// Which rung a model sits on. The session's own model can read as an alias ("opus", "sonnet[1m]"),
// so fall back to the strongest rung the name matches; -1 for a model that is not on the ladder.
function rungOf(id) {
  const exact = ladder.findIndex(m => m.id === id)
  if (exact !== -1) return exact
  const name = String(id ?? '').replace(/^claude-/, '').replace(/\[.*$/, '')
  if (!name) return -1
  const matched = ladder.map((m, i) => (m.id.includes(name) ? i : -1)).filter(i => i !== -1)
  return matched.length ? matched[matched.length - 1] : -1
}

// Walk to the rung the score names: straight up, since a hard prompt shouldn't wait on a weaker
// model, but one rung at a time down, so a turn misread as easy costs a rung and not the whole
// ladder. A stretch of easy prompts still walks to the bottom.
function pick(score, from) {
  const target = Math.round(((score - 1) / 9) * (ladder.length - 1))
  const at = rungOf(from)
  if (at === -1) return ladder[target].id
  return ladder[target > at ? target : Math.max(target, at - 1)].id
}

// A new model reads the whole conversation uncached, so a big context should be compacted
// before it does. It must also fit the target's window.
async function needsCompaction($, target, threshold) {
  try {
    // `tokens` comes from the last response; right after a resume there is none, so estimate locally.
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const tokens = context?.tokens ?? context?.breakdown?.totalTokens ?? 0
    const window = ladder.find(m => m.id === target)?.window ?? Infinity
    return tokens > threshold || tokens >= window
  } catch {
    return false
  }
}

// 'yes' or 'failed: <reason>', so the reason is never silent.
async function compactNow($) {
  try {
    const res = await $.session.compact()
    // A hook vetoed it; the context is still as large as it was.
    return res?.skip ? 'failed: ' + res.skip : 'yes'
  } catch (err) {
    return 'failed: ' + String(err?.message ?? err)
  }
}

// A dropped prompt lands back in the box, where it looks like it never went through. Take it
// out, but leave anything else alone: by then the person may have typed something new.
async function clearIfDropped($, text) {
  const box = await $.prompt.read().catch(() => null)
  if (box && box.text.trim() === text.trim()) await $.prompt.fill({ text: '' }).catch(() => {})
}

// The host refuses compaction while prompt.submit holds the prompt, so a downgrade drops it,
// compacts once the session is idle, and re-sends it to the cheaper model.
async function compactThenResend($, text, previous, target, why) {
  await clearIfDropped($, text)
  lastCompaction = await compactNow($)
  if (lastCompaction === 'yes') {
    current = target
    $.ui.toast(`autoswitch → ${target} (${why}, compacted)`)
  } else {
    current = previous
    $.ui.toast(`autoswitch: staying on ${previous}, compaction ${lastCompaction}`)
  }
  $.ui.invalidate('ui.render')
  // Again, in case the host put the text back while compaction ran.
  await clearIfDropped($, text)
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch {
    await $.prompt.submit({ text })
  }
}

// A higher rung than the current one; a model off the ladder counts as the top.
function isUpgrade(from, to) {
  const a = rungOf(from)
  return a === -1 || rungOf(to) > a
}

export function register(on, options) {
  const threshold = options?.compact_threshold ?? 100000
  maxAgeDays = options?.max_model_age_days ?? maxAgeDays

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'autoswitch',
      description: 'Show the model ladder; "refresh" re-discovers models, "reset" also forgets learned credit failures',
      argumentHint: '[refresh|reset]',
    })
    // Don't hold up the session; switching starts once the ladder is known.
    discover($, false).then(models => { ladder = models }, () => {})
    return next(e)
  })

  on('command.run', { command: 'autoswitch' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'reset') await $.store.set('needsCredits', [])
    if (arg === 'refresh' || arg === 'reset') ladder = await discover($, true)
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

    // The rung to measure from. On the first prompt nothing is routed yet, and the model the
    // person chose themselves is the anchor; without it a low score falls to the bottom rung.
    const previous = current ?? await $.session.model()

    let chosen = forcedId
    let why = 'forced'
    if (!chosen) {
      const score = await rate($, text).catch(() => null)
      // Rating failed: leave the model as it is.
      if (score === null) return next(e)
      chosen = pick(score, previous)
      why = 'score ' + score
    }

    if (chosen !== previous && rungOf(chosen) !== rungOf(previous)) {
      // Going down with a big context: compact first, so the cheaper model answers this very
      // prompt from a small context. Prompts with attachments can't be re-sent as they were.
      // Going up, or forced: switch now; a hard prompt shouldn't wait on a weaker model.
      const downgrade = !forcedId && !isUpgrade(previous, chosen)
      if (downgrade && !e.attachments?.length && await needsCompaction($, chosen, threshold)) {
        $.clock.after(0, () => { compactThenResend($, text, previous, chosen, why) })
        return { drop: `autoswitch: compacting before switching to ${shortName(chosen)}, then re-sending your prompt` }
      }
      $.ui.toast(`autoswitch → ${chosen} (${why})`)
    }
    current = chosen
    $.ui.invalidate('ui.render')
    return next(forcedId ? { ...e, text } : e)
  })

  // Main conversation only; subagents keep whatever model they were given.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) subagents.add(e.agentId)
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
      // drop the model and retry one rung down.
      const failed = held !== null && result?.stopReason == null && !next.signal.aborted
      if (!failed) for (const chunk of held ?? []) yield chunk
      const at = ladder.findIndex(m => m.id === current)
      if (!failed) {
        if (result?.stopReason != null) await markWorked($, current).catch(() => {})
        return result
      }
      if (at <= 0) {
        for (const chunk of held) yield chunk
        return result
      }
      const dropped = current
      await markFailed($, dropped)
      current = ladder[at - 1].id
      $.ui.invalidate('ui.render')
      $.ui.toast(`autoswitch: ${dropped} failed, using ${current}`)
    }
  })

  // /model shows the configured model, not the one answering, so show the routed one here.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!current || subagents.has(e.requestId)) return next(e)
    return next({ ...e, props: { ...e.props, suffix: e.props.suffix + ' · ' + shortName(current) } })
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!current || e.props.isDraft) return next(e)
    const label = 'autoswitch: ' + shortName(current)
    return next({ ...e, props: { ...e.props, hint: e.props.hint ? e.props.hint + ' · ' + label : label } })
  })
}
