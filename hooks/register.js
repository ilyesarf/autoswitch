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
  return 'Ladder (weakest → strongest):\n' + ladder.map((m, i) => `  ${i + 1}. ${m.id}`).join('\n')
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
}
