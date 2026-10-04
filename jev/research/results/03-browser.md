# 03 · Could Jev help Claude navigate the browser?

**Verdict: no.** Better than chance at picking what to click, nowhere near good enough to steer
clicks. The browser's real problems in the data were mechanical errors that plain rules could
prevent.

## Where Jev could even help

Claude in Chrome mostly navigates with screenshots, clicks at screen positions and JavaScript.
Jev reads text only, so the only decisions it could weigh in on are the moments when `find` or
`read_page` listed several elements and Claude then acted on one. Over 14 days: about 2,400
browser actions, 48 such moments, 24 with more than one option.

## Results (24 choice points; cost under $0.01; Jev p50 302ms)

| Setup | Jev matched Claude's click | When Jev was ≥ 0.5 confident |
|---|---|---|
| Random guessing | 39% | — |
| Jev, knowing what Claude searched for | 58% (14) | 64% (7 of 11) |
| Jev, knowing only the user's request | 58% (14) | 53% (8 of 15) |

Some of Jev's most confident picks (0.83 to 0.93) were wrong. Many misses were login forms,
where Claude filled several fields in one go, so "which element first" had more than one right
answer. Even allowing for that, it is not reliable.

Loading the browser tools ahead of time: right 7 of 10 times when suggested, but it caught only 7
of 60 browser turns.

## What the data pointed to instead (no Jev needed)

127 browser errors in the same period, mostly mechanical:

- 13 attempts to open browser-internal pages;
- 12 actions aimed at the wrong tab, or at a tab outside Claude's group;
- 11 scripts broken by the page navigating away mid-run;
- 13 timeouts;
- 6 screenshots of error pages.

A rule-based mod could block or recover about a third of these. Candidate idea, outside Jev.
