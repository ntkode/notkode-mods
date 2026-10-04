# 01 · Four per-turn features: effort, tools, context, done check

**Verdict: drop three, keep one narrow piece.** Only spotting quick status questions held up, and
it is worth little on its own. See 02.

## What was tested

Before each turn, Jev read the project name, the last 6 exchanges and the new prompt, and
answered, in one call:

- **Effort:** a choice among `status` / `routine` / `standard` / `hard`.
- **Tool router:** a yes/no per MCP server and skill: "will this prompt need it?"
- **Context router:** a choice among the project's memory notes and `docs/*.md` (or none).
- **Done check** (after the turn, a second call): "was everything asked actually done?",
  "does the answer claim something no tool result shows?", "does it end by asking permission
  for a routine step?"

Each answer was compared with what really happened in the turn. Two independent samples of 400
real turns over 14 days (one author's sessions across about 25 projects). Cost about $0.10 per
run; Jev p50 305ms, p95 about 450ms.

## Results (run 1 → run 2)

**Effort: does Jev's class match how much work the turn turned out to be?**

| Class | Turns | Median requests | Turned out heavy (>25 requests) |
|---|---|---|---|
| status | 110 → 93 | 3 → 3 | 3% → 4% |
| routine | 70 → 67 | 5 → 7 | 6% → **15%** |
| standard | 182 → 188 | 6 → 9 | 11% → 21% |
| hard | 38 → 52 | 5 → 9 | 13% → 13% |

- "status" is consistent: those turns really are small.
- "routine" is not safe to lower: a short "ok, run it" can start a 48-request job.
- "hard" turns were no heavier than "standard", so raising them to max effort is not justified.
- Estimated output-token change if live: −3.2% → +0.6%.

**Tool router**

| | Run 1 | Run 2 |
|---|---|---|
| MCP suggestions actually used | 14 of 25 (56%) | 12 of 34 (35%) |
| Turns that used an MCP server and were caught beforehand | 14 of 82 (17%) | 12 of 88 (14%) |
| Skill suggestions invoked | 1 of 114 | 3 of 118 |

The browser tools were the best case (7 of 10, then 10 of 15), and still caught few of the
browser turns.

**Context router:** pointed at a note on 176 → 169 turns. Claude opened that note in 22% → 21%.

**Done check:** flagged 48% → 51% of turns as unfinished. After flagged turns, the user's next
message was a "is it done?" check 1% → 3% of the time, against 2% → 1% after unflagged turns:
no signal, and half of all turns would get a follow-up.

## Why

Jev is strong at closed, well-separated choices. "Is this finished?" or "which of 34 tools might
matter?", judged from a short summary, are open-ended judgments, and that is where it failed. The
one closed question with clear options, "is this a quick status question?", is the one that
worked.
