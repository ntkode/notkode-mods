# 07 · Prior art: which Jev uses in coding agents have measured results

**Verdict: one use case is well proven (the permission gate), two have partial evidence (skill
gate, narrow done check), and one study changes how we should ask Jev anything.** Most of the
800+ projects in [awesome-jev](https://github.com/hellogumbo/awesome-jev) publish no numbers;
only those that do are kept here. Scan made 2026-10-03; nothing below has been re-run by us yet.

## Proven: the permission gate (idea 12)

| Source | Data | Result |
|---|---|---|
| [jev-permission-gate](https://github.com/madisonrickert/jev-permission-gate) (Claude Code mod, MIT) | 5,322 calls, 3,664 of them risky | 1 unsafe allow (<0.13%); settled 62% of real agent work alone; 0.3% wrong denials; median wait 164 ms vs 329 ms for the built-in classifier |
| [themsquared/jev-benchmark](https://github.com/themsquared/jev-benchmark) | 60 hand-labelled tool calls (clear, ambiguous, adversarial) | 91.7% accuracy (100% on clear); at confidence 1.000 (67% of answers), zero misses; p50 422 ms |
| [hermes-jev-approvals](https://github.com/anpicasso/hermes-jev-approvals) | 153 real commands | 4.4× fewer prompts, 8.7× faster (methodology in its METRICS.md) |

How the best one works: a shell prefilter first (privilege escalation, remote access, deletion,
uploads), then Jev reads the last three user messages, the pending command and the project path
(never tool output) and answers eight yes/no questions. Allow only when the call serves the
request (≥ 0.5) and every risk is ≤ 0.1; deny only when risky (≥ 0.8) and unrequested (≤ 0.3);
everything else goes to the normal prompt or classifier. Claude Code exposes `tool.check`
(allow / ask / deny) for exactly this.

**Our next step:** backtest on our own transcripts: how many permission prompts and auto-mode
waits would it have settled, and would any settled call have been one we later refused or undid?

## Partial evidence

- **Skill gate (idea 13).** [jev-skill-gate](https://github.com/ShivamPansuriya/jev-skill-gate):
  one Jev question per skill at session start; the skill manifest went from 12,750 to 3,185
  tokens (−75%) on a 217-skill install, for $0.0009 a session. Recall: all 19 labelled skills
  kept, but over only 4 test cases. Saves input tokens on every request, which the pane's spend
  section can measure. Backtest: would a skill the session actually invoked have been hidden?
- **Narrow done check (idea 14).** [stingray](https://github.com/Nanako0129/stingray): 124
  labelled turns, 81.8% precision, 14.1% recall, 3.3% false positives, p50 0.75 s. Our broad done
  check (idea 6, [01](01-four-features.md)) flagged half of all turns; the narrow shapes (an
  announced action never taken, a promise to watch with nothing running) look worth a retry.

## A rule for every question we ask Jev (idea 15)

[beri.net](https://www.beri.net/article/typesafe-jev-typed-decision-model-calibration-decomposition-shadow-eval):
one broad question scored 62.6%; the same task split into five narrow questions with fitted
weights scored 95.0%. Calibration varies by question type (yes/no underconfident, choice
overconfident). Rules: calibrate per question on your own data, always offer "none of these",
compare cost per correct decision. For the hints: Jev was confident on 17% of asks in our first
live week; the log already records which hints Claude followed, which is the data per-question
calibration needs.

## Ideas without numbers (16, 17)

Output pruning ([jev-pruner](https://github.com/tamaratran/jev-pruner)) and Jev-scored
compaction ([fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)) are built
as Claude Code mods but publish no savings or quality data. They stay ideas until someone
measures them.

## Context

- Jev in general: 67.8% agreement on TypeSafe's four-workflow benchmark, level with a frontier
  LLM at about 1/200th the cost and 1/50th the latency ([Arize](https://arize.com/blog/typesafe-jev-llm-judge/),
  [DataCamp](https://www.datacamp.com/blog/system-one-models-jev)).
- [jevals](https://github.com/openlayer-ai/jevals) phrases agent evals (StepProgress,
  LoopDetection, UsedToolResult, ToolCallRisk) as Jev questions, one request per trace: a source
  of tested question wordings.
