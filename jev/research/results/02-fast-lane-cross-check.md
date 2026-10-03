# 02 · Fast lane: low effort for quick status questions, with a cross-check

**Verdict: safe enough with jev-gateway's rule plus an exit, but small.** The turns it lowers hold
about 4% of output tokens, so the win is mostly faster answers. Proposed upstream as a gateway
feature rather than kept as a second Jev integration in the plugin.

## What was tested

One Jev call per turn with two questions: the effort class (as in 01), and an independent yes/no
check: "is the latest message a quick question about status or state that can be answered with
a short look-up, without doing new work?" Following jev-gateway, act only when both are at least
0.7 sure. 800 real turns (both samples from 01). Cost $0.045.

A lowered turn that "turns out heavy" (more than 25 requests or 20k output tokens) is a risky
downgrade: real work done at low effort.

## Results

| Rule | Turns lowered | Turned out heavy |
|---|---|---|
| status ≥ 0.6 | 120 (15%) | 5 (4.2%) |
| status ≥ 0.7 | 104 (13%) | 4 (3.8%) |
| **status ≥ 0.7 and check ≥ 0.7** | **81 (10%)** | **3 (3.7%)** |
| status ≥ 0.7 and check ≥ 0.85 | 40 (5%) | 1 (2.5%) |

- Lowered turns: median 3 requests and about 1.6k output tokens.
- They hold 3.9% of all output tokens.
- The heavy ones left are genuinely ambiguous: status questions ("is it running?",
  "are we done?") after which Claude chose to investigate at length.

## The design that follows

- Act on the two-question rule only.
- **Exit:** if a lowered turn grows past 8 requests, the rest goes back to normal effort. The
  heavy cases above ran 11 to 39 requests, so they recover early.
- **Control group:** in live mode, 25% of qualifying turns stay at normal effort, so real savings
  are measured, not estimated.

This was built and tested in plugin v0.3 (live A/B, exit after N requests), then set aside in
favour of the gateway integration.
