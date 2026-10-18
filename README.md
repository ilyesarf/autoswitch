# autoswitch

I keep forgetting to switch models. I don't need Opus 5.5 to write docs; Sonnet is good enough.

autoswitch is a Claude Code mod that picks the model for each prompt, so you don't have to `/model` by hand.

## Install

Requires Claude Code 2.1.299+ and a claude.ai or Anthropic API login (not Bedrock/Vertex/Foundry).

```
/plugin install autoswitch --marketplace ilyesarf/autoswitch
```

On older versions:

```
/plugin marketplace add ilyesarf/autoswitch
/plugin install autoswitch@autoswitch
```

Or run it from a local clone: `claude --plugin-dir /path/to/autoswitch`

## Use

Just prompt as usual. A toast shows when it switches, and the model actually answering shows in the
spinner (`Thinking… · sonnet-5`) and under the prompt. `/model` keeps showing your configured default.

- `!<model> prompt` forces a model: `!opus`, `!sonnet-5`, `!haiku-5-5`
- `/autoswitch` shows the model ladder, the last compaction and the last 20 routing decisions, `/autoswitch refresh` rebuilds it,
  `/autoswitch reset` also forgets models wrongly marked as needing credits
- `/config` has `compact_threshold` (default 100k tokens) and `max_model_age_days` (default 180)

## How it works

1. **Discover**: lists your usable models released in the last 180 days and keeps the newest of each
   family as a rung, haiku < sonnet < opus < fable. The family's previous version is kept as a fallback
   for when the newest fails, not as a rung of its own.
2. **Rate**: a cheap model sorts the next turn into one of four bands, `trivial`, `routine`, `involved`
   or `hard`, each pinned by examples. It reads the tail of the conversation as well as your prompt, so
   `go` or `continue` is rated on the work it carries on from and not on its length. Each band names a
   family, haiku to fable; a family you can't use passes the turn up to the next stronger one. An
   answer that isn't a band keeps the model you're on.
3. **Switch**: going up switches right away, straight to the rung the band names. Going down moves
   one rung at a time, so a turn misread as easy costs a rung instead of the whole ladder; a stretch
   of easy prompts still walks to the bottom. Going down with a large context holds your prompt,
   compacts, then re-sends it to the cheaper model. A model that fails is dropped and the turn retries on its family's previous version, or one rung down. Models that need paid credits are skipped while your credits are off.
