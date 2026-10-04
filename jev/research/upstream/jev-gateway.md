# Drafts for jev-gateway's maintainer

Issues to open on [vinilana/jev-gateway](https://github.com/vinilana/jev-gateway), one each.
Drafts only: nothing here has been sent. Open them once jevMod's repository is public, so the
links work.

---

## 1. A Claude Code plugin that runs jev-gateway: link from the README?

Hi! I built **jevMod**, an open-source Claude Code plugin that runs jev-gateway from inside the
session: <link to the public repo>.

- It installs a pinned jev-gateway version (0.5.0) into its own folder with npm, asks for the key
  once, and saves it to `~/.jev-gateway/.env` through your own `bin/setup.mjs`
  (`validateKey` and `saveEnv`), so it shares the key with every `jev-*` launcher.
- It starts the gateway with your launcher (`jev-claude.mjs --start`, with `JEV_CLAUDE_PORT` and
  `JEV_CLAUDE_UPSTREAM_BASE_URL`), then routes the running session by setting
  `ANTHROPIC_BASE_URL`, which Claude Code reads on every request. No restart and no wrapper
  command.
- Before every request it checks `/health`. If the gateway stops answering, the request goes
  straight to the API, and the next turn restarts the gateway, so a dead gateway never fails a
  request.
- It reads `/dashboard/events` to show each decision live ("Jev picked Read 0.99 (hint)") and
  uses `/dashboard/routing` for an on/off baseline comparison per user.
- A session started through `jev-claude` is watched, never managed.

It never changes gateway code, and it says plainly that results depend on the model and the task,
pointing to your benchmark. Would you add a link under the Claude Code section of the README?
Happy to adjust anything you'd rather it did differently.

---

## 2. Launcher pid and log files are per client, not per port

`runLauncher` names its files after the client: `~/.jev-gateway/claude.pid` and `claude.log`. Two
gateways for the same client on different ports (`JEV_CLAUDE_PORT=8794` next to the default 8789)
therefore share both files:

- `jev-claude --stop` on 8789 also kills the pid in `claude.pid`, which may be the gateway on
  8794 if that one started last.
- Each gateway replays the shared `claude.log` at start (`JEV_LOG_FILE`), so one dashboard shows
  the other's history.

Reproduce: `JEV_CLAUDE_PORT=8794 jev-claude --start`, then `jev-claude --start` (8789), then
`jev-claude --stop`. Both stop.

Suggestion: include the port when it is not the default, e.g. `claude-8794.pid` and
`claude-8794.log`. I can send a PR.

---

## 3. Proposal: a fast lane for quick status questions

Data and method: <link>/research/results/02-fast-lane-cross-check.md

On 800 real Claude Code turns, asking Jev two questions per turn (an effort class, plus an
independent "is this a quick status question?" check) and acting only when both are at least 0.7
sure picked out 10% of turns. Those turns ran a median of 3 requests and held about 4% of output
tokens. 3.7% of them turned out heavy, and an exit after 8 requests recovers those early.

The gateway already sees every request, so it could lower `effort` (or `reasoning.effort`) on the
first request of such a turn, with the same two-question rule it uses for tools, a control group,
and the exit. The win is mostly faster answers to quick questions, not big token savings. If
you're interested, I can send a PR behind a flag that is off by default, so it never changes
current behaviour.
