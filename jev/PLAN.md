# jevMod: plan and handoff

Where the project stands, what has been proven, and what to build next. Updated 2026-10-03, at
the end of the session that finished v0.4.

## The decision

jevMod is a **standalone, open-source Claude Code plugin** (marketplace `jevmod`, plugin `jev`).

1. **First feature: run [jev-gateway](https://github.com/vinilana/jev-gateway) from inside Claude Code.**
   The gateway asks Jev which tool fits on every model request and steers Claude when Jev is
   confident. The plugin installs it, starts it, routes the session through it, falls back to
   direct if it stops answering, shows its decisions live, and measures routing on vs off.
2. **Then: research.** New Jev use cases found online go through the funnel in `CLAUDE.md`:
   backtest on real transcripts, then shadow, then live with a control group, then keep or drop.

Why standalone and not a fork: the plugin only *uses* the gateway (its npm package, its launcher,
its setup code and its local HTTP API) and never changes its code. Keeping it standalone keeps the
author's autonomy over releases and experiments. Because the plugin installs a pinned gateway
version itself, versions can't drift apart.

## Current state: v0.4 works, not released

`claude plugin validate` passes (plugin and marketplace), `claude plugin test` passes 33 of 33,
and `tsc` is clean. On macOS it has been run for real, headless and interactive, against
jev-gateway 0.5.0 with an OpenRouter key.

| File | What it holds |
|---|---|
| `plugins/jev/.claude-plugin/plugin.json` | v0.4.0; options `gateway` (on/off), `port` (8794), `excludedRepos` (empty) |
| `plugins/jev/types/index.d.ts` | state contract: `gateway` (state, routed, paused, routing, note…), `original`, `phase`, `decision`, `last`, `session` |
| `plugins/jev/hooks/register.tsx` | the runner: setup, start, the guard, the watchdog, event polling, band, pane, log, commands |
| `plugins/jev/hooks/logic.ts` | pure: key file and provider rule, upstream, Node check, decision text, tally, report |
| `plugins/jev/hooks/sprites.ts` | owl scenes; cards cyan (pick), green (direct), grey (pass); red eye when down |
| `plugins/jev/scripts/save-key.mjs` | checks and saves the key through the gateway's own `bin/setup.mjs`; key on stdin only |
| `plugins/jev/tests/*.test.ts` | 33 tests: routing, fallback and restart, watchdog, subagents, excluded, off, external, setup, band, pane, scene |

### How it works

- **Setup** (`/jev-setup`, every step asked): Node.js ≥ 22.15 check; `npm install
  jev-gateway@0.5.0` into `~/.claude/jev-mod/gateway/0.5.0`; key from the clipboard, checked and
  saved to `~/.jev-gateway/.env` (0600) by `save-key.mjs`, clipboard cleared; an existing key
  (file or environment) is found and kept.
- **Start**: `node …/bin/jev-claude.mjs --start` with `JEV_CLAUDE_PORT` and
  `JEV_CLAUDE_UPSTREAM_BASE_URL`. The launcher detaches the gateway and keeps its pid and log; the
  gateway outlives the session. Awaited at session start, so the first request is routed.
- **Routing**: `ANTHROPIC_BASE_URL` set per request by the guard in `turn.step` (subagents too):
  `/health`, cached 1s, 800ms timeout. Down: the original URL goes back *before* the request
  leaves, a fallback is counted, one toast, and the next turn restarts the gateway in the
  background. A watchdog (every 5s) does the same between turns. The original URL is saved once
  in state and restored whenever routing stops.
- **Modes**: off (the session goes as it started), excluded (direct; prompts not logged),
  not_installed / no_key (band says `/jev-setup`), up, down, external (started through
  `jev-claude`: watched and guarded, never started or stopped; direct means the Anthropic
  default).
- **Decisions**: `/dashboard/events` polled after each main-loop request, 400ms later, and at
  turn end. A restart is detected by `startedAt` (the gateway replays its log, so `recorded`
  alone is not enough).
- **Seen**: band (owl scene, the decision line), pane (`/jev`: state, last turn, totals, buttons
  for pause, Jev routing, restart, dashboard URL, report), `/jev-report` (routing on vs off, needs
  5 turns of each), log in `~/.claude/jev-mod/log/` (v3 records).

## Verified (2026-10-03, macOS)

- [x] Headless: the plugin starts the gateway and the first request goes through it (Jev
      answered in 569ms; turn logged as `gateway`).
- [x] Headless: gateway killed mid-turn by Claude's own Bash call. The next request went direct
      (`fallbacks: 1`) and the turn finished. The next session restarted the gateway.
- [x] External mode: a session started with `ANTHROPIC_BASE_URL` at a `jev-claude` gateway (8789)
      went through it, and the plugin started nothing.
- [x] Excluded repo: nothing started, the request went direct, and the log kept no prompt.
- [x] **Interactive** session (tmux): band "Jev picked Read 0.99 (hint)" mid-turn; pane correct;
      gateway killed while idle → watchdog let go, the next turn went direct and restarted it.
- [x] Marketplace install (`claude plugin marketplace add <repo>` + `claude plugin install
      jev@jevmod`, in an isolated `CLAUDE_CONFIG_DIR`) loads the hooks module like `--plugin-dir`:
      the gateway started from that install alone.
- [x] Licence: jev-gateway is MIT (package and LICENSE); jevMod is MIT.

## Still open before release

- [ ] **Windows.** Untested. Designed for it: `node` with no shell, the gateway's own launcher
      (cross-platform), `npm` → `npm.cmd` → `cmd /c npm`, `USERPROFILE` fallback, PowerShell
      clipboard, backslash paths in exclusions. Needs one real run.
- [ ] **Publish the repository** (`github.com/tone-lotto/jevMod` does not exist yet), so
      `/plugin marketplace add tone-lotto/jevMod` works.
- [ ] `/jev-setup` itself driven end to end on a clean machine (its parts ran for real: npm
      install, launcher, save-key's gateway code; the dialog flow ran in tests only).
- [ ] Linux clipboard (`wl-paste`, `xclip`) untested.

## Known limits (in the README)

- One gateway per port, shared by every session on it; events carry no session id, so
  concurrent sessions count each other's requests.
- The launcher's pid and log files are per client, not per port: `jev-claude --stop` can stop the
  plugin's gateway (it restarts on the next turn). Upstream fix drafted.
- Options are per install key (`jev@inline` vs `jev@jevmod`): excluded repos must be set again
  after switching from `--plugin-dir` to the marketplace install.
- No unload event: uninstalling mid-session leaves the session pointed at the gateway until the
  session ends.

## Next steps, in order

1. Run it on Windows once; fix what breaks.
2. Publish the repository; install from GitHub on a second machine; drive `/jev-setup` there.
3. Open the issues drafted in `research/upstream/jev-gateway.md` (README link, per-port pid/log
   files, fast-lane proposal).
4. Use it: switch Jev routing off for some similar work and read `/jev-report` once both groups
   have 5 turns. That is idea 1's live stage; write `research/results/06-…` with the numbers.
5. Research funnel: idea 9 was parked at step 2 (`results/05-proceed.md`). Next candidates in
   `research/ideas.md`: 8 (browser guard, outside Jev), 10 (Laya), 11 (batch classification).
