# jevMod: plan and handoff

Where the project stands, what has been proven, and what to build next. Updated 2026-10-03, at
the end of the session that finished v0.5.

## The decision

jevMod is a **standalone, open-source Claude Code plugin** (`jev`), distributed through the
[notkode-mods](https://github.com/ntkode/notkode-mods) marketplace with the other Notkode plugins.

1. **First feature: Jev's tool hints, native to Claude Code.** Before Claude's requests the mod
   asks Jev which tool fits and, when Jev is confident, Claude reads it as a hint. v0.4 did this by
   running [jev-gateway](https://github.com/vinilana/jev-gateway) as a proxy; v0.5 asks Jev
   itself, with jev-gateway's questions and rule ported (MIT, credited), and nothing else of the
   gateway's machinery.
2. **Then: research.** New Jev use cases found online go through the funnel in `CLAUDE.md`:
   backtest on real transcripts, then shadow, then live with a control group, then keep or drop.

## Current state: v0.5 works, not released

v0.5 drops the gateway. jev-gateway's only effect in Claude Code was a hint (with thinking on, the
API refuses a forced tool, and touching `tool_choice` breaks the prompt cache), yet it took Node,
npm, a background proxy for all traffic, a guard, fallbacks and a watchdog. The mod now asks Jev
itself and passes the hint through the hook API.

`claude plugin validate` passes, `claude plugin test` passes 44 of 44, and `tsc` is clean. Run for
real on macOS (interactive, tmux) with an OpenCode key.

| File | What it holds |
|---|---|
| `plugins/jev/.claude-plugin/plugin.json` | v0.5.0; options `mode` (on/shadow/off), `controlPercent` (20), `excludedRepos` (empty) |
| `plugins/jev/types/index.d.ts` | state contract: `status`, `phase`, `decision`, `last`, `session`, and `original` (read once, to undo v0.4's routing) |
| `plugins/jev/hooks/register.tsx` | asking Jev (prompt.submit, tool.call), turns and arms, band, pane, log, setup, commands |
| `plugins/jev/hooks/logic.ts` | pure: providers and key rule, state builder, questions and shortlist, the decision rule, tally, log, report |
| `plugins/jev/hooks/sprites.ts` | the band's scenes: only the actor at work moves; cards cyan (hint), grey (pass), red (failed) |
| `plugins/jev/tests/*.test.ts` | 44 tests: the rule, the key, the report, the hooks end to end (hint, parallel calls, timeout, failure, control, shadow, excluded, off, no key, setup, v0.4 leftover, pane, pause), the scenes |

### How it works

- **When Jev is asked**: on `prompt.submit` (before a turn's first request; the hint rides as
  `context` beside the prompt) and in `tool.call` after the last call of a response finishes (the
  hint rides as `context` after that tool result). One ask per model request, main loop only.
  The response's call count comes from `turn.step`'s result; a call waits for it (10s at most).
- **What Jev reads**: `$.session.messages()` (plus the new prompt, or the batch's results not
  stored yet), cut to 60k characters, newest first; `$.tool.list()` names and descriptions,
  shortlisted in one extra call past 120 tools. jev-gateway's two questions, its rule (≥ 0.7,
  both answers agree, never hint "no tool") and its hint wording, ported with credit.
- **Budget**: 4s per ask, one retry on 408/429/5xx; failing or slow is a pass (`jev_error`,
  `jev_timeout`), and the request goes on without a hint.
- **Arms**: each turn is drawn at `prompt.submit`: `hint`, or `control` (20%: Jev not asked),
  `shadow` with mode shadow (asked, recorded, nothing reaches Claude), `excluded`, `off` (paused
  from the pane). "Followed": the next response called the tool Jev pointed at.
- **Key**: `~/.jev-gateway/.env`, jev-gateway's own file, so keys are shared both ways;
  environment variables win. `/jev-setup` reads the clipboard, checks the key with one call to
  Jev, writes the file with `upsertEnv`, `chmod 600`, and clears the clipboard.
- **v0.4 leftover**: a session still pointing at `127.0.0.1:8794` is sent back to the URL saved in
  `original` (or the default). The old gateway process is not stopped (README says how).
- **Seen**: band (scene, then the status line with the routing setting under it), pane (`/jev`),
  `/jev-report` (hints vs control, 5 turns of each), log in `~/.claude/jev-mod/log/` (v4 records).

## Verified

v0.5 (2026-10-03, macOS, interactive in tmux, OpenCode free model):

- [x] Loads from `--plugin-dir` with the marketplace v0.4.3 copy disabled; band "Jev idle" over
      "routing on".
- [x] A turn with a Bash call: "Jev deciding…" → "Jev left it to Claude · Jev was unsure" →
      "Claude thinking…" → "Claude working · Bash" → "Jev deciding…" → "… · no tool needed" →
      "Claude thinking…" → idle. Jev answered in 1.3s per ask.
- [x] A control turn drawn at random: "routing on · control turn, no hints", the owl asleep.
- [x] Pane: last turn's asks, reasons, latency; session tiles.

v0.4 (gateway version, for the record): headless and interactive runs, fallback mid-turn,
external `jev-claude` mode, excluded repos, the marketplace install from GitHub.

- [x] Licence: jev-gateway is MIT (package and LICENSE); jevMod is MIT.

## Still open before release

- [ ] **A hint seen live**: the first live run's asks were all passes (unsure, no tool needed).
      Check a confident pick reaches Claude as `context` and shows cyan.
- [ ] **Windows.** Untested: `USERPROFILE` fallback, PowerShell clipboard, backslash paths in
      exclusions, no `chmod`. Needs one real run.
- [ ] **Make the repository public** (`ntkode/notkode-mods`, which now holds jev too, is
      private for now).
- [ ] `/jev-setup` driven end to end on a clean machine (the dialog flow ran in tests only).
- [ ] Linux clipboard (`wl-paste`, `xclip`) untested.

## Known limits (in the README)

- Main conversation only: subagents get no hints.
- A hint stays in the conversation with the prompt or tool result it rode on (about 30–40 tokens).
- Each ask adds Jev's latency before the request it is about.
- Options are per install key (`jev@inline` vs `jev@notkode-mods`): excluded repos must be set again
  after switching from `--plugin-dir` to the marketplace install.

## Next steps, in order

1. See a hint live (above); then release v0.5.0 (the marketplace description and the root README
   row already describe it).
2. Run it on Windows once; fix what breaks.
3. Make the repository public; install on a second machine; drive `/jev-setup` there.
4. Use it: read `/jev-report` once hints and control have 5 turns each. That is idea 1's live
   stage; write `research/results/07-…` with the numbers.
5. Open the issues drafted in `research/upstream/jev-gateway.md` that still apply (README link,
   fast-lane proposal).
6. Research funnel: idea 9 was parked at step 2 (`results/05-proceed.md`). Next candidates in
   `research/ideas.md`: 8 (browser guard, outside Jev), 10 (Laya), 11 (batch classification).
