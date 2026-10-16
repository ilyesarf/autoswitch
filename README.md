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
- `/autoswitch` shows the model ladder, `/autoswitch refresh` rebuilds it
- `/config` has `compact_threshold` (default 100k tokens) and `max_model_age_days` (default 180)

## How it works

1. **Discover**: lists your usable models (two newest per family, released in the last 180 days) and ranks them haiku < sonnet < opus < fable, then by version.
2. **Rate**: a cheap model scores each prompt 1-10, and the score picks a rung on the ladder.
3. **Switch**: before a switch, compacts the conversation if it's large. A model that fails is dropped and the turn retries one rung down. Models that need paid credits are skipped while your credits are off.
