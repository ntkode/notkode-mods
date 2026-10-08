# jevMod

**Jev inside Claude Code.** An open-source Claude Code plugin that asks Jev, TypeSafe's fast
decision model, which tool fits Claude's next step, and passes Claude the answer as a hint. You can
watch it happen and measure whether it helps on your own work.

> **Status: v0.5, released.** Native to Claude Code: no gateway, no proxy, no
> Node.js. Tested on macOS, headless and interactive. Windows is untested. See [PLAN.md](PLAN.md).
> Independent project; the questions and the decision rule are ported from
> [jev-gateway](https://github.com/vinilana/jev-gateway) (MIT). Not affiliated with TypeSafe.

## What it does

- **Asks Jev before Claude's requests.** Before the first request of a turn, and after each batch
  of tool results, the plugin sends Jev the conversation and Claude's tool list. It asks jev-gateway's
  two questions: which tool fits next, and is a tool needed at all.
- **Hints only when Jev is sure.** When Jev is at least 0.7 confident and both answers agree, Claude
  reads one line beside the prompt or the tool result: *"A tool-routing model suggests the "Read"
  tool… Ignore this if it does not fit."* Claude is free to ignore it.
- **Never slows Claude down for long, never breaks it.** Each ask has a 4-second budget. If Jev
  fails or is slow, that request simply goes without a hint.
- **Shows it live.** A small pixel scene above the prompt shows one actor moving at a time. Claude
  (left) sends the conversation to Jev (the owl, right). The owl works only while Jev decides. Its
  answer flies back as a card: cyan for a hint, grey when Jev left it to Claude, red when Jev failed.
  Then Claude thinks and works while the owl holds still. The status line sits beside the scene,
  with the routing setting under it.
- **Measures each feature in weekly quota.** The `/jev` board shows, per feature, the share of
  your weekly quota it saved over the last 7 days (negative when it cost more). The skill gate and
  fresh start save tokens directly; hints and effort are measured against control turns (20%,
  drawn at random, run with no Jev feature at all). The account's own rate turns tokens into
  quota percent.
- **Saves quota where it goes** (see [research 09](research/results/09-where-the-quota-goes.md):
  most of it is context Claude re-reads on every request):
  - **Skill gate:** at session start Jev judges which of your skills this project needs; the
    others keep only their name in the list Claude reads on every request (still callable). In
    this repo, 55 skills: 39 reduced to their names.
  - **Effort:** quick status questions ("are we done?", "is it in prod?") run at low effort, on
    the same model, back to your effort if the turn grows past 8 requests.
  - **Fresh start:** when a prompt starts a new task that needs nothing from a long
    conversation (100k+ tokens), Jev offers `/clear` or `/compact` first, then sends your prompt.
- **Catches a stop on a broken promise** (done check). When Claude stops after saying more work
  is coming ("I'll report when it lands"), with nothing left running and nothing asked of you, Jev
  sends Claude back to work, once per turn. Off by default.
  Backtested on 14 days of real turns before shipping.
- **Makes Claude check its work** (verify). When Claude ends a turn having changed files that
  nothing ran or looked at since, it is sent back once: a screen it changed (`.tsx`, `.vue`,
  `.html`, `.css`…) to look at it in a browser, a simulator or a screenshot; other code to run the
  tests, the build or the code. If it has no way to check, it says so instead of calling it done.
  Not when Claude ends on a question to you, nor while work still runs. On by default.
- **Respects private work.** Repos you exclude never ask Jev, so their conversations never reach
  it, and their prompts stay out of the plugin's log.

## What to expect

Claude Code runs with thinking on, so a hint is all any router can give it: the API refuses a
forced tool. In jev-gateway's own benchmark the effect depended on the model and the task. That's
why the plugin measures hints on your own work instead of promising savings. Each ask adds Jev's
latency before the request it is about (1.3 s on OpenCode's free model in our first live run); the
board shows yours.

## Install

You need Claude Code with plugin function hooks (mods), and an API key for Jev from OpenRouter,
TypeSafe, OpenCode or Vercel AI Gateway.

It is part of the [notkode-mods](https://github.com/ntkode/notkode-mods) marketplace. In Claude
Code:

```
/plugin marketplace add ntkode/notkode-mods
/plugin install jev@notkode-mods
```

To work on the plugin itself, run a clone instead: `claude --plugin-dir path/to/notkode-mods/jev/plugins/jev`
(the folder hot-reloads on save).

Then:

```
/jev-setup
```

Pick where Jev runs, copy your key, and choose *Read the clipboard*. The key is checked with one
call to Jev and saved to `~/.jev-gateway/.env`, readable only by you. jev-gateway reads the same
file, so a key you already set up there is found and kept. The clipboard is cleared afterwards, and
the key is never shown or passed on a command line. Keys in the environment (`OPENROUTER_API_KEY`,
`TYPESAFE_API_KEY`, …) work too and win over the file.

Open the board with `/jev`. At the top, the options: each feature on or off (keys `h` hints, `e`
effort, `k` skill gate, `t` fresh start, `d` done check, `v` verify). Then the two figures that matter over the
last 7 days: what Jev cost, and how much of the weekly quota it saved. Then the features table, each
with its own share of that saving, and under it a chart per feature, one column a day: green what it
saved that day, yellow hanging below the line what it cost; the done check charts the stops it
checked, verify the turns it sent back to check. Every feature works on its own.

## Settings

In `/config`, under the plugin:

| Option | Default | What it does |
|---|---|---|
| Jev: hints | `on` | `on`: Claude gets Jev's confident tool picks as a hint. `off`: no hints |
| Jev: control group (%) | `20` | this share of turns runs with no Jev feature, the baseline for hints and effort. `0` turns it off |
| Jev: done check | `off` | `on`: Claude is sent back to work after a broken promise, once per turn |
| Jev: verify | `on` | `on`: changes nothing ran or looked at send Claude back once to check them (screens: look; code: run) |
| Jev: effort | `on` | `on`: quick status questions at low effort, same model |
| Jev: skill gate | `on` | `on`: skills the project won't need keep only their name |
| Jev: fresh start | `on` | `on`: offer `/clear` or `/compact` when a new task starts in a long conversation |
| Jev: excluded repos | empty | comma-separated folder names where Jev is never asked |

Options are stored per install: a marketplace install (`jev@notkode-mods`) and a `--plugin-dir` copy
(`jev@inline`) each keep their own. **Set your excluded repos again after switching.**

## Good to know

- **The main conversation only.** Subagents run without hints.
- **At most 8 asks per turn.** The prompt's, then after the first 7 batches of tool results; a long
  turn goes on without hints after that, so it does not send Jev the conversation before every request.
- **Out of credits, or a refused key, rests Jev.** On HTTP 401, 402 or 403 the plugin says so once and
  stops calling Jev for 15 minutes (until then, the turn goes on without it). `/jev-setup` ends the rest.
- **Hints stay in the conversation.** A hint is saved with the prompt or the tool result it rode
  on, so later requests see old hints too (about 30 to 40 tokens each).
- **Coming from v0.4?** A session the old version had routed through its gateway on port 8794 is
  sent straight to the API again. The old gateway process may still be running. Stop it with
  `JEV_CLAUDE_PORT=8794 node ~/.claude/jev-mod/gateway/0.5.0/node_modules/jev-gateway/bin/jev-claude.mjs --stop`,
  then delete `~/.claude/jev-mod/gateway/`.
- **Running `jev-claude` as well?** Then that gateway hints too, and the pane says so. Use one or
  the other to measure either.

## Research

The plugin grows through measured experiments, not guesses. Ideas live in
[research/ideas.md](research/ideas.md); each one is backtested on real transcripts before it
ships, and the results, including the ideas that failed, are in [research/results/](research/results/).

## Contributing

Issues and pull requests are welcome. Read [CLAUDE.md](CLAUDE.md) for the layout, the commands,
the privacy rules and the research funnel.

## License

MIT, like jev-gateway.
