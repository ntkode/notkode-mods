# 06 · Jev routing with Opus 5.5: a one-run pilot on the gateway's benchmark

**Verdict: promising, not proven.** Both tasks were solved with routing on and off. With routing
on, Opus 5.5 made about 20% fewer requests and used about 25% fewer input tokens; output tokens
and time improved on the debugging task only. That is one run per side, so it is a hint, not a
measurement.

## Setup

- [jev-gateway-bench](https://github.com/vinilana/jev-gateway-bench) (the gateway's own benchmark),
  with jev-gateway 0.5.0 (the version the plugin installs) and Jev through OpenRouter.
- Claude Code 2.1.288, `claude-opus-5-5`, run clean: no personal settings, MCP servers or plugins,
  only Bash, Edit, Write, Read, Glob and Grep. A fresh gateway per run; a hidden verifier scores
  the result.
- One run with routing on and one off per task (2026-10-03).

## Results

| | Debugging (chess-bugfix) on / off | Feature (chess-san) on / off |
|---|---:|---:|
| Solved | 36/36 · 36/36 | 42/42 · 42/42 |
| LLM requests | 7 / 9 (−22%) | 8 / 10 (−20%) |
| Input tokens | 110k / 156k (−30%) | 146k / 191k (−24%) |
| Output tokens | 4,646 / 6,052 (−23%) | 11,204 / 11,172 (0%) |
| Time | 55 s / 62 s (−11%) | 110 s / 107 s (+3%) |
| Requests Jev steered (hints) | 29% | 38% |

- The saving comes from fewer requests: a hint at the right moment saves Claude a look-around step.
- Input tokens were 81-88% cached, so the money saved is smaller than the input percentage.
- On the feature task, the published benchmark found routing made Opus 5 clearly worse (+47%
  requests, +83% time). Opus 5.5 showed no such loss here, in one run.
- Jev cost: one call per request (7 and 8 calls), well under a cent.

## What it does not say

- One run per side: the published series shows run-to-run spread larger than some of these
  differences. Five runs per mode per task (20 sessions) would start to measure.
- Clean Claude with 6 tools. A real setup with many MCP tools and skills gives Jev a different
  choice to make (the bench's `--user-tools`).
- Real work is not chess tasks: `/jev-report` (routing on vs off on your own turns) is the
  measurement that counts in the end.
