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
- **Measures it honestly.** 20% of turns run without Jev (a control group, drawn at random), and
  the `/jev` pane compares turns with hints against them on requests, output tokens and time.
- **Shows what it costs and saves.** The pane shows what the session cost (Claude at API prices,
  and Jev's calls as the provider prices them) and how much of your weekly quota is used. Once 5
  turns with hints and 5 control turns are logged, it estimates what hints saved per turn, in
  dollars and as a share of the weekly quota, net of Jev's cost.
- **Catches a stop on a broken promise** (done check). When Claude stops after saying more work
  is coming ("I'll report when it lands"), with nothing left running and nothing asked of you, Jev
  catches it. In `shadow` (the default) it is only recorded in `/jev`; set it `on` and Claude is
  sent back to work, once per turn. Switch it from the `/jev` pane (`d`) or in `/config`.
  Backtested on 14 days of real turns before shipping.
- **Respects private work.** Repos you exclude never ask Jev, so their conversations never reach
  it, and their prompts stay out of the plugin's log.

## What to expect

Claude Code runs with thinking on, so a hint is all any router can give it: the API refuses a
forced tool. In jev-gateway's own benchmark the effect depended on the model and the task. That's
why the plugin measures hints on your own work instead of promising savings. Each ask adds Jev's
latency before the request it is about (1.3 s on OpenCode's free model in our first live run); the
pane and the report show yours.

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

Open the pane with `/jev`. It shows where Jev runs, what it answered on the last turn, the session's
totals and spend, the last 7 days (what Jev answered, hints vs control, spend and savings), and
switches to pause Jev for this session and to set the done check (shadow, on, off).

## Settings

In `/config`, under the plugin:

| Option | Default | What it does |
|---|---|---|
| Jev: hints | `on` | `on`: Claude gets Jev's confident picks. `shadow`: Jev is asked and its picks are recorded, but Claude never sees them. `off`: Jev is never asked |
| Jev: control group (%) | `20` | with hints on, this share of turns runs without Jev, for the `/jev` pane to compare. `0` turns it off |
| Jev: done check | `shadow` | `shadow`: broken promises are recorded in `/jev`. `on`: Claude is sent back to work, once per turn. `off`: stops are never checked |
| Jev: excluded repos | empty | comma-separated folder names where Jev is never asked |

Options are stored per install: a marketplace install (`jev@notkode-mods`) and a `--plugin-dir` copy
(`jev@inline`) each keep their own. **Set your excluded repos again after switching.**

## Good to know

- **The main conversation only.** Subagents run without hints.
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
