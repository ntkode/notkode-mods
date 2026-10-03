# Ideas

Every Jev use case, where it came from, and where it is in the funnel (see `CLAUDE.md`).
Add new ones at the bottom with a source link.

| # | Idea | Source | Status | Result |
|---|---|---|---|---|
| 1 | **Run jev-gateway from inside Claude Code**: Jev picks the next tool on each request | [vinilana/jev-gateway](https://github.com/vinilana/jev-gateway) | **Built (v0.4)**; next: live, routing on vs off per user (`/jev-report`) | Routing proven: [04](results/04-routing-a-session-through-jev-gateway.md); Opus 5.5 pilot, ~20% fewer requests: [06](results/06-benchmark-opus-5-5-pilot.md) |
| 2 | Fast lane: low effort for quick status questions | own analysis | Proven, small; propose upstream | [02](results/02-fast-lane-cross-check.md) |
| 3 | Effort router: lower "routine", raise "hard" | own analysis | Dropped | [01](results/01-four-features.md) |
| 4 | Per-turn tool and skill router | own analysis | Dropped (gateway does it per request, better) | [01](results/01-four-features.md) |
| 5 | Context router: point at the relevant note or doc | own analysis | Dropped | [01](results/01-four-features.md) |
| 6 | Done check: follow up when the turn looks unfinished | own analysis | Dropped (flags half of all turns) | [01](results/01-four-features.md) |
| 7 | Jev picks what to click in the browser | own analysis | Dropped | [03](results/03-browser.md) |
| 8 | Browser guard: block or recover mechanical browser errors (no Jev) | finding in 03 | Candidate (outside Jev) | [03](results/03-browser.md) |
| 9 | Auto-answer "should I proceed?" on routine, reversible steps | own analysis | Parked: ceiling too low (a plain yes on 11-27% of permission questions, 2-5 a day) | [05](results/05-proceed.md) |
| 10 | Laya: open-source, local alternative with the same API (`/v1/systemone`) | [comparison](https://flowtivity.ai/blog/laya-open-source-jev-alternative/) | Candidate: weak zero-shot (0.362), needs fine-tuning on own labels; GPU for speed | — |
| 11 | Batch classification outside chat: scraped pages, leads, tickets (Jev as a cheap judge in pipelines) | own projects; Langfuse "Jev as a judge" | Candidate (likely a separate tool, not the plugin) | — |
