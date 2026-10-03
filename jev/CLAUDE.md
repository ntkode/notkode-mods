# jevMod

An open-source Claude Code plugin (a "mod": function hooks, not just skills) that brings Jev,
TypeSafe's fast decision model, into Claude Code. Its first feature runs jev-gateway from inside
the session. Read `PLAN.md` first: it holds the decisions, what has been proven, the current code
state and the next steps.

## Layout

- `.claude-plugin/marketplace.json`: the marketplace (`jevmod`), so users can install with `/plugin install jev@jevmod`
- `plugins/jev/`: the plugin
  - `.claude-plugin/plugin.json`: manifest and `userConfig` (the `/config` rows)
  - `hooks/register.tsx`: the hooks module (`register(on, options)`)
  - `hooks/logic.ts`, `hooks/sprites.ts`: pure code, no `$`, tested directly
  - `scripts/save-key.mjs`: run with `node` by `/jev-setup`; checks and saves the Jev key through the gateway's own `bin/setup.mjs` (key on stdin, never argv)
  - `types/index.d.ts`: the `$.state` contract
  - `tests/*.test.ts`: run with `claude plugin test`
  - `experiments/`: new use cases, each off by default (create when the first one lands)
- `research/`: `ideas.md` (use cases and their status), `backtest/` (replay harness), `results/` (one file per experiment), `upstream/` (drafts for jev-gateway's maintainer)

## Commands

```bash
claude plugin validate plugins/jev      # what the module hooks and calls, and what the engine would refuse
claude plugin test plugins/jev          # the tests, against the engine itself
npx -y -p typescript@5.6 tsc -p plugins/jev   # type-check (after the plugin has loaded once, so .claude-plugin/types exists)
claude --plugin-dir plugins/jev         # run it: the folder is watched and hot-reloads on save
```

Before writing hooks code, load the `plugin-authoring` skill: it names this build's types file.
Grep it for the event or noun at hand rather than guessing.

## Mod API rules learned the hard way

- Every helper that receives `$` must be a **top-level function declaration**, and `$` is always
  spelled `$.noun.method(...)` at the call site. Otherwise `claude plugin validate` refuses the module.
- `turn.step` hooks are async generators: `return yield* next(e)`. Only `model` and `effort` can be
  rewritten; work after `yield*` runs once the request is done.
- `$.process.run` waits for the whole output: detach long-lived processes (`nohup … &` with all
  three fds redirected) or the call hangs.
- Module variables reset on every hot reload (and `session.start` fires again); `$.state` values
  survive. A reload in the middle of a turn kills its background work: clear transient state at
  `session.start` and bound every network call with a timeout.
- `$.env.set('ANTHROPIC_BASE_URL', …)` reroutes the session's next model request (proven).
  Never point it at something that isn't answering.
- `command.run` output text is read by the model too: never put secrets in it.
- Options are stored per install key: `jev@inline` for `--plugin-dir`, `jev@jevmod` for the
  marketplace install. Settings under one never reach the other.
- `mock.env` answers `env.get` only: a test of code that calls `$.env.set` hooks `env.get` and
  `env.set` over one object itself. A `tool.call` carries the tool's arguments at the top level
  (`e.questions` for the dialog `$.ui.ask` opens), not under `e.input`. A band that returns
  `next(e)` needs a `ui.render` hook beneath it in the test.
- Interactive checks: run the session in tmux. `send-keys Enter` does not submit there; send a
  raw carriage return (`tmux send-keys -l $'\r'`).
- Tests: hooks beneath the plugin must be registered before the test's first `$` call. Op events
  (`session.id`, `fs.read`, `http.fetch`, …) answer `{ value }` (or `{ deny }`). Catch background
  promises, or the file fails with "a rejection nothing handled".

## Privacy rules (this repo is public)

- Never commit transcript data: `research/backtest/data/` is git-ignored because it holds real prompts.
- No personal names, client names, emails or private prompts in code, tests, docs or result files.
  Use neutral samples (`clientA`, `demo-app`, "is it in prod?").
- `excludedRepos` defaults to empty; each user sets their own in `/config`.
- Secrets travel in environment variables or the gateway's key file, never in argv, logs or command output.

## The research funnel

Every new use case, especially ones found online, goes through these steps before reaching users:

1. Write it in `research/ideas.md`, with its source.
2. Backtest it on real transcripts with `research/backtest/` (minutes, cents). Most ideas stop here.
3. Shadow mode in `plugins/jev/experiments/`: it records what it would do and changes nothing.
4. Live with a control group, then keep it (move into the core) or drop it.
5. Write `research/results/NN-name.md`: numbers, verdict, and why. A failed idea is a result too.

Experiments stay off by default and separate from the gateway integration, so a half-tested idea
can never break the part people rely on.
