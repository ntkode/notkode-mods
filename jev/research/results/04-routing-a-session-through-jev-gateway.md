# 04 · A mod can route its own session through jev-gateway, and back

**Verdict: proven.** Claude Code reads `ANTHROPIC_BASE_URL` on every model request, so a mod can
switch the running session onto the gateway, and back to direct, with no restart and no
`jev-claude` launcher.

## Setup

- jev-gateway 0.5.0, installed locally and started as a plain server on port 8799:
  `PORT=8799 UPSTREAM_BASE_URL=https://api.anthropic.com/v1 JEV_PROVIDER=openrouter OPENROUTER_API_KEY=… node dist/index.js`
- Headless Claude Code runs (`claude -p "Reply with exactly: ok" --model haiku`) with a normal
  claude.ai login. The gateway forwards the client's own credentials.
- Tiny test mods loaded with `--plugin-dir`. The gateway's `/dashboard/events` was the witness.

## Results

| Run | How the base URL was set | Outcome |
|---|---|---|
| Control | `ANTHROPIC_BASE_URL=http://127.0.0.1:8799` before starting | `ok`; gateway recorded the request (HTTP 200) |
| Mod at session start | the mod calls `$.env.set('ANTHROPIC_BASE_URL', …)` in `session.start` | `ok`; recorded by the gateway |
| Mod at turn start | the same, in `turn.start` | `ok`; recorded by the gateway |
| Fallback | session started pointed at a dead port; the mod clears the variable in `turn.start` | `ok`, straight to the API |
| No mod | session started pointed at the same dead port | `API Error: Connection refused (ECONNREFUSED)` |

## Consequences for the design

- The plugin can own the whole gateway experience: install, start, route, stop.
- It must guard every request: if the gateway stops answering, restore the original base URL
  *before* the request goes out, or the session fails.
- Confirmed in an interactive session too, with plugin v0.4 (2026-10-03). The band showed
  "Jev picked Read 0.99 (hint)" mid-turn. A gateway killed while the session sat idle was let go
  by the watchdog, the next turn's request went direct, and the gateway restarted in the
  background. Headless, a gateway killed mid-turn (by Claude's own Bash call) cost nothing: the
  next request went direct and the turn finished.
