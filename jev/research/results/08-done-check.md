# 08 · Done check: can Jev tell Claude stopped before finishing?

**Verdict: the broad question fails again; one narrow shape works.** "Is the requested work
unfinished, and could Claude go on?" does not separate the turns you had to push from the rest.
"Claude's last message says work is still under way or that it will do something next" does,
with no false pushes at a high threshold. The useful rule is stingray's "unwatched promise":
Claude promised to keep going, and nothing is actually running.

## What was tested

`backtest/done-check.mts`. Every turn of the last 14 days (1,350, excluded repos left out). Ground
truth by hand: 193 candidate turns read, 13 labelled half-done, where the next message pushed
Claude to finish ("continue and only stop when finished", "do it yourself", "why did we stop?",
"are we done? I don't see any agent running"). Turns that ended asking a real question (124)
counted as legitimate stops. Jev read the recent conversation, the turn's tool calls and Claude's
final message, and answered five yes/no questions in one call: was work requested, is part of it
unfinished, can Claude go on alone, is it waiting on the user, does the final message promise more
work. 413 turns (all 13 positives, 400 others); $0.035; Jev p50 266 ms.

## Results

| Rule | Caught (of 13) | Pushed wrongly (of 400) | Precision |
|---|---|---|---|
| unfinished ≥ 0.7 | 4 (31%) | 89 (22%) | 4% |
| unfinished and can go on ≥ 0.7 | 1 (8%) | 5 (1%) | 17% |
| requested, unfinished, can go on, not blocked ≥ 0.7 | 1 (8%) | 2 (1%) | 33% |
| requested, not blocked, and (unfinished and can go on, or **promised**) ≥ 0.8 | 3 (23%) | 8 (2%) | 27% |
| the same at ≥ 0.9 | 2 (15%) | **0** | 100% |

Mean answers, half-done vs others: promised 0.61 vs 0.43 (the only clear gap); unfinished 0.54
vs 0.45; can go on 0.42 vs 0.45 (no signal); blocked 0.43 vs 0.53.

The 8 "wrong" pushes at 0.8 were read one by one: 6 have the same shape as the positives. Claude
ended with "I'll report when it lands", and the next message was "are the agents still running?",
"assure it keeps extracting" or "speed it up". The labels undercount that shape, so the real
precision of the promise rule is higher than the table shows.

## Why

"Is this finished?" is the open-ended judgement Jev handles badly (as in [01](01-four-features.md)).
"Does this message promise more work?" is a closed question about the text in front of it, and
Jev answers it well. Whether the promised work is really running is not a question for Jev at
all: the mod can check it itself (background shells, monitors, agents still running).

## Next step (funnel step 3)

Shadow mode in `plugins/jev/experiments/`: at each stop, ask Jev only "does the final message
promise more work?" (≥ 0.9) and "is it waiting on the user?" (< 0.1), check locally whether
anything is still running, and record what it would have done, without pushing. Go live only if
a week of shadow records shows ≤ 3 wrong pushes per 100 stops.
