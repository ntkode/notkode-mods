# Backtest harness

Replays your own Claude Code history through Jev, so an idea can be judged on real work in
minutes, for cents, before anyone builds it.

```bash
cd research/backtest
python3 extract.py                    # last 14 days, 400 random turns -> data/turns.jsonl
node fast-lane.mts                    # experiment 02
node browser.mts                      # experiment 03 (reads transcripts itself)
node proceed.mts --local              # experiment 05, transcripts only: nothing leaves the machine
```

- **Key:** read from the macOS Keychain entry `/jev-setup` creates, or from `OPENROUTER_API_KEY`.
- **Private repos:** set `JEVMOD_EXCLUDE=clientA,clientB` (folder names) and those transcripts are
  never read, so they never reach Jev.
- **Data stays local:** `data/` holds real prompts and is git-ignored. Never commit it.
- Scripts append results as they go (`data/*.jsonl`), so an interrupted run resumes where it stopped.
- **A new experiment:** copy `fast-lane.mts`, change the questions and the comparison, then write
  the numbers and the verdict to `../results/NN-name.md`.
