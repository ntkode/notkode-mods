# 09 · Where the weekly quota goes

**Verdict: the context Claude re-reads, not what it writes.** Output is under 10% of weighted
usage. The fixed base context (system prompt, tools, skills) is 37%, the growing conversation
38%, tool results kept in context 15%. The levers are a smaller base (skills), shorter
conversations (a new task in a new context), and smaller tool results (Bash).

## What was measured

`backtest/quota.py`, over 7 days of transcripts (excluded repos left out): 8,547 API requests,
each counted once, token types weighted by relative API price (input 1, cache read 0.1, cache
write 1.25 or 2, output 5). 2.05 billion cache-read tokens against 6.4 million output tokens.

| Share of weighted usage | Where |
|---|---|
| 37.9% | rest of the conversation (prompts, answers, thinking, carried since the last compaction) |
| 37.2% | base context: system prompt, built-in tools, skills (first request of each session) |
| 15.3% | tool results kept in context: Bash 10.4%, Read 2.3%, Artifact 1.2%, Chrome 0.5% |
| 9.5% | output |

- Base context: median 54k tokens per session (p90 68k), resent on every request; 175 sessions,
  median 8 requests each. A fresh session in this repo (`/context`): 29.7k, of which skills 9.7k
  (55 skills), built-in tools 14.4k, system prompt 4k, MCP tools 0.6k (already deferred).
- Auto-compact window is 1M tokens, so conversations grow very long before anything is dropped.
- Main loop 91%, subagents 9%. Opus 5.5 84%, Fable 5.1 12%, Sonnet 5.5 3%.

## What follows

1. **New task, new context.** Turns that open an unrelated topic ("ok, another subject …") keep
   re-reading the whole previous conversation. Jev can tell a topic switch (a closed question about
   the prompt vs the conversation) and suggest `/clear`, or start the work in a subagent. Biggest
   share; backtest next: how many turns open a new topic, and how much context they carried.
2. **Skill gate** (idea 13): 9.7k of the base is the skill list; trimming 75% of it saves roughly
   5–10% of all usage.
3. **Bash output** (idea 16): 10% of usage is Bash results re-read later; pruning the long ones
   could save a few percent. Needs care: Claude must keep what it needs.
4. Output-side ideas (fast lane, effort) can save at most a part of 9.5%.
