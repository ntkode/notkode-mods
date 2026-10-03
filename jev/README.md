# jevMod

**Jev inside Claude Code.** An open-source Claude Code plugin that runs
[jev-gateway](https://github.com/vinilana/jev-gateway) for you, so Jev, TypeSafe's fast decision
model, can pick Claude's next tool on each request. You can watch it happen and measure whether
it helps on your own work.

> **Status: v0.4, working, not released yet.** Tested on macOS, headless and interactive. Windows
> is untested. See [PLAN.md](PLAN.md). Independent project, built on jev-gateway; not affiliated
> with TypeSafe.

## What it does

- **Runs the gateway for you.** It installs a pinned jev-gateway version into its own folder,
  starts it, and routes your Claude Code session through it. No separate launcher.
- **Never breaks your session.** Before every request, subagents' included, it checks the gateway
  is answering. If not, the request goes straight to the API, and the next turn restarts the
  gateway. A watchdog does the same between turns.
- **Shows each decision live.** A small pixel scene above the prompt: Claude sends the request,
  Jev (the owl) decides, and the decision comes back. *"Jev picked Read 0.99 (hint)"*, or
  *"Jev left it to Claude · Jev was unsure"*.
- **Measures it honestly.** Switch Jev's routing off for similar work, and `/jev-report`
  compares the two on tokens, requests and time.
- **Respects private work.** Repos you exclude never go through the gateway, so their
  conversations never reach Jev, and their prompts stay out of the plugin's log.

## What to expect

The gateway asks Jev on every request and steers Claude only when Jev is at least 0.7 confident.
With thinking on (Claude Code's default for Opus), it can only add *hints*: no forced tool and no
skipped LLM call. In jev-gateway's own benchmark the results depended on the model and the task
(Fable 5.1 improved on both tasks; Opus 5 and Sonnet 5 got worse on feature work). That's why the
plugin measures it on your work rather than promising savings, with one switch to turn it off.

## Install

You need Claude Code with plugin function hooks (mods), Node.js 22.15 or newer on your `PATH`,
and an API key for Jev from OpenRouter, TypeSafe, OpenCode or Vercel AI Gateway.

From GitHub (once the repository is public):

```
/plugin marketplace add tone-lotto/jevMod
/plugin install jev@jevmod
```

From a local clone:

```
/plugin marketplace add ~/path/to/jevMod
/plugin install jev@jevmod
```

Then, in Claude Code:

```
/jev-setup
```

`/jev-setup` asks before each step:

1. **Install** jev-gateway 0.5.0 with npm into `~/.claude/jev-mod/gateway/0.5.0`. Nothing global
   changes, and upgrades are deliberate.
2. **Key:** pick where Jev runs, copy your key, and choose *Read the clipboard*. The key is
   checked with one call to Jev and saved by the gateway's own setup code to
   `~/.jev-gateway/.env`, readable only by you and shared with every `jev-*` launcher. The
   clipboard is cleared afterwards, and the key is never shown or passed on a command line. If you
   already use `jev-claude`, your key is found and kept.
3. **Start:** the gateway runs in the background on `127.0.0.1:8794`, and this session's next
   request goes through it.

Open the pane with `/jev`. It has the gateway's state, the last turn's decisions, and these
switches: pause routing for this session, Jev routing on/off (the baseline), restart the gateway,
copy the dashboard URL, and the report.

## Settings

In `/config`, under the plugin:

| Option | Default | What it does |
|---|---|---|
| Jev: route through jev-gateway | `on` | `off`: nothing starts and the session goes as it started |
| Jev: gateway port | `8794` | where the plugin runs its gateway (127.0.0.1 only) |
| Jev: excluded repos | empty | comma-separated folder names never routed through the gateway |

Options are stored per install: a marketplace install (`jev@jevmod`) and a `--plugin-dir` copy
(`jev@inline`) each keep their own. **Set your excluded repos again after switching.**

## Good to know

- **The gateway keeps running** after the session ends, so the next one starts at once. Stop it
  with `JEV_CLAUDE_PORT=8794 node ~/.claude/jev-mod/gateway/0.5.0/node_modules/jev-gateway/bin/jev-claude.mjs --stop`.
- **Already using `jev-claude`?** A session started through it is watched, not managed: the
  plugin shows that gateway's decisions and guards its requests, but never starts or stops it.
- **One gateway, several sessions.** Every session on the same port shares one gateway, and its
  events carry no session id. So when two sessions run at once, each one's pane and report count
  the other's requests too.
- **Shared files with `jev-claude`.** The gateway's launcher names its pid and log files after the
  client (`~/.jev-gateway/claude.pid`, `claude.log`), not the port. If you also run `jev-claude`,
  `jev-claude --stop` can stop the plugin's gateway. The plugin restarts it on the next turn.
- **Turning the plugin off mid-session** in `/config` sends requests straight to the API again at
  once. Uninstalling it mid-session leaves the session pointed at the gateway until the session
  ends, which is fine while the gateway keeps running.

## Research

The plugin grows through measured experiments, not guesses. Ideas live in
[research/ideas.md](research/ideas.md); each one is backtested on real transcripts before it
ships, and the results, including the ideas that failed, are in [research/results/](research/results/).

## Contributing

Issues and pull requests are welcome. Read [CLAUDE.md](CLAUDE.md) for the layout, the commands,
the privacy rules and the research funnel.

## License

MIT, like jev-gateway.
