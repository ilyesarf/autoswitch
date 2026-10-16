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
let lastCompaction = 'none yet'
// A downgrade waiting for the turn to end, so the conversation can be compacted first
// (the host refuses compaction inside prompt.submit). { target, why }
let pending = null
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

// A higher rung than the current one; a model off the ladder counts as the top.
function isUpgrade(from, to) {
  const a = ladder.findIndex(m => m.id === from)
  return a === -1 || ladder.findIndex(m => m.id === to) > a
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

    const previous = current ?? await $.session.model()
    pending = null
    if (chosen !== previous) {
      // Going down with a big context: this turn stays on the stronger model, the conversation
      // is compacted when it ends, and the cheaper model takes over from the next prompt.
      // Going up, or forced: switch now; a hard prompt shouldn't wait on a weaker model.
      if (!forcedId && !isUpgrade(previous, chosen) && await needsCompaction($, chosen, threshold)) {
        pending = { target: chosen, why }
        current = previous
        $.ui.toast(`autoswitch: ${shortName(chosen)} from the next prompt, compacting after this turn (${why})`)
        $.ui.invalidate('ui.render')
        return next(forcedId ? { ...e, text } : e)
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

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!pending || e.agentId || e.isAborted) return result
    const { target, why } = pending
    pending = null
    lastCompaction = await compactNow($)
    if (lastCompaction === 'yes') {
      current = target
      $.ui.toast(`autoswitch → ${target} (${why}, compacted)`)
    } else {
      $.ui.toast(`autoswitch: staying on ${current}, compaction ${lastCompaction}`)
    }
    $.ui.invalidate('ui.render')
    return result
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
