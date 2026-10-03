// Pure parts of the mod: how jev-gateway's decisions are read and added up, and the report.
// Nothing here touches `$`, so tests run it as is.
//
// The mod runs jev-gateway (github.com/vinilana/jev-gateway) for Claude Code: it starts the
// gateway, points this session's model requests at it by setting ANTHROPIC_BASE_URL, which
// Claude Code reads on every request, and goes back to direct the moment the gateway stops
// answering. On each request the gateway asks Jev which tool fits and steers Claude when Jev
// is confident; the mod shows that live and measures it against routing switched off.

/** The jev-gateway release the mod installs: a known version, upgraded on purpose. */
export const GATEWAY_VERSION = '0.5.0'
export const DEFAULT_PORT = 8794
export const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com/v1'
/** The Node.js the gateway needs (its package.json `engines`). */
export const NODE_MIN: readonly [number, number] = [22, 15]

/**
 * Where Jev runs, as the gateway's own `providers.json` lists them (labels and key names only:
 * the key check and the key file go through the gateway's own `bin/setup.mjs`).
 */
export const GATEWAY_PROVIDERS = {
  openrouter: { label: 'OpenRouter', keyEnv: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/settings/keys' },
  typesafe: { label: 'TypeSafe', keyEnv: 'TYPESAFE_API_KEY', keyUrl: 'https://typesafe.ai' },
  opencode: { label: 'OpenCode (free model)', keyEnv: 'OPENCODE_API_KEY', keyUrl: 'https://opencode.ai/auth' },
  vercel: { label: 'Vercel AI Gateway', keyEnv: 'AI_GATEWAY_API_KEY', keyUrl: 'https://vercel.com/dashboard/ai-gateway/api-keys' },
} as const
export type GatewayProvider = keyof typeof GATEWAY_PROVIDERS

/** The variables of a `.env` file (`NAME=value`, `export` and quotes allowed). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

/**
 * Which provider the gateway will use, by its own rule: an explicit JEV_PROVIDER, else whichever
 * key is there. The process environment wins over the key file, as the gateway's launcher has it.
 */
export function keyProvider(file: Record<string, string>, env: Record<string, string | undefined>): GatewayProvider | undefined {
  const merged: Record<string, string | undefined> = { ...file }
  for (const [name, value] of Object.entries(env)) if (value?.trim()) merged[name] = value
  const present = (id: GatewayProvider) => Boolean(merged[GATEWAY_PROVIDERS[id].keyEnv]?.trim())
  const ids = Object.keys(GATEWAY_PROVIDERS) as GatewayProvider[]
  const chosen = merged.JEV_PROVIDER?.trim().toLowerCase()
  const id = ids.find(p => p === chosen) ?? ids.find(present)
  return id && present(id) ? id : undefined
}

/** Where the gateway forwards: the API the session used before it was routed, plus `/v1`. */
export function upstreamFor(original: string | null | undefined): string {
  const base = original?.trim().replace(/\/+$/, '')
  if (!base) return ANTHROPIC_UPSTREAM
  return base.endsWith('/v1') ? base : `${base}/v1`
}

/** Whether `node --version` printed a Node.js the gateway runs on. */
export function nodeVersionOk(text: string): boolean {
  const m = /v?(\d+)\.(\d+)/.exec(text.trim())
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > NODE_MIN[0] || (major === NODE_MIN[0] && minor >= NODE_MIN[1])
}

// ---------------------------------------------------------------- the gateway's decisions

/** One routed request, as jev-gateway's /dashboard/events reports it (the fields the mod reads). */
export type GatewayEvent = {
  seq: number
  mode: string
  reason?: string
  tool?: string
  confidence?: number
  status?: number
  durationMs?: number
  usage?: { input: number; output: number; cached: number; cacheWrite: number; reasoning: number }
  jev?: { choice: string; confidence: number; latencyMs: number }
}

/** Modes where Jev chose the tool: steered by a hint, forced, or answered without the LLM. */
export const PICK_MODES: ReadonlySet<string> = new Set(['hint', 'forced', 'direct'])

/** Why the gateway let the LLM decide, in plain words. */
export const REASON_TEXT: Record<string, string> = {
  low_confidence: 'Jev was unsure',
  jev_answers_disagree: "Jev's two checks disagreed",
  no_tool_needed: 'no tool needed',
  no_tools: 'no tools in the request',
  no_messages: 'empty request',
  routing_disabled: 'routing off (baseline)',
  disabled_by_header: 'routing off for this request',
  tool_choice_already_decided: 'Claude Code already chose',
  hosted_tool_selected: 'a hosted tool fit',
  namespaced_tool_selected: 'a namespaced tool fit',
  jev_unknown_tool: 'Jev named an unknown tool',
  jev_unexpected_answer: 'unexpected Jev answer',
  jev_error: 'Jev failed',
  router_error: 'gateway error',
  unreadable_request: 'unreadable request',
  too_many_tools: 'too many tools',
}

export function reasonText(reason: string | undefined): string {
  if (!reason) return 'passed through'
  const key = reason.split(':')[0]!.replace(/^upstream_rejected_.*/, 'upstream_rejected')
  return REASON_TEXT[key] ?? (key === 'upstream_rejected' ? 'the API refused the change' : key.replace(/_/g, ' '))
}

/** One decision as the band says it: `Jev picked Bash 0.82 (hint)`, or why Jev left it to Claude. */
export function decisionText(d: { mode: string; tool?: string; confidence?: number; reason?: string }): string {
  const sure = d.confidence !== undefined ? ` ${d.confidence.toFixed(2)}` : ''
  if (d.mode === 'direct' && d.tool) return `Jev called ${d.tool}${sure} itself (direct)`
  if (PICK_MODES.has(d.mode) && d.tool) return `Jev picked ${d.tool}${sure} (${d.mode})`
  if (d.mode === 'none') return `Jev: no tool needed${sure} (none)`
  return `Jev left it to Claude · ${reasonText(d.reason)}`
}

/** The card the decision runs back to Claude as: Jev picked, Jev answered without the LLM, or Claude decides. */
export type DecisionCard = 'pick' | 'direct' | 'pass'

export function cardFor(mode: string): DecisionCard {
  if (mode === 'direct') return 'direct'
  return mode === 'hint' || mode === 'forced' || mode === 'none' ? 'pick' : 'pass'
}

/** The gateway's requests during one turn. */
export type GatewayTurn = {
  requests: number
  modes: Record<string, number>
  reasons: Record<string, number>
  picks: { tool: string; confidence: number; mode: string }[]
  /** Requests forwarded with routing switched off: the baseline. */
  baseline: number
  output: number
  jevMs: number[]
  /** Who decided each request, in order: the pane's trail (absent in logs from before 0.4.3). */
  cards?: DecisionCard[]
}

export function emptyGatewayTurn(): GatewayTurn {
  return { requests: 0, modes: {}, reasons: {}, picks: [], baseline: 0, output: 0, jevMs: [], cards: [] }
}

export function tallyGateway(turn: GatewayTurn, event: GatewayEvent): void {
  turn.requests++
  turn.modes[event.mode] = (turn.modes[event.mode] ?? 0) + 1
  if (event.reason) {
    const reason = event.reason.split(':')[0]!
    turn.reasons[reason] = (turn.reasons[reason] ?? 0) + 1
    if (reason === 'routing_disabled') turn.baseline++
  }
  if (PICK_MODES.has(event.mode) && event.tool && turn.picks.length < 30) {
    turn.picks.push({ tool: event.tool, confidence: event.confidence ?? event.jev?.confidence ?? 0, mode: event.mode })
  }
  if (event.jev && turn.jevMs.length < 100) turn.jevMs.push(event.jev.latencyMs)
  const cards = (turn.cards ??= [])
  if (cards.length < 200) cards.push(cardFor(event.mode))
  turn.output += event.usage?.output ?? 0
}

// ---------------------------------------------------------------- the log

/** How the turn's requests went: through the gateway, straight to the API, or why not routed. */
export type Route = 'gateway' | 'direct' | 'excluded' | 'down'

export type TurnRecord = {
  type: 'turn'
  v: 3
  at: number
  session: string
  project: string
  turnId: string
  prompt: string
  route: Route
  actual: {
    steps: number
    durationMs: number
    reason: string
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
    tools: number
  }
  gateway?: GatewayTurn
  /** Requests sent direct because the gateway stopped answering mid-turn. */
  fallbacks?: number
}

export type LogRecord = TurnRecord

export function parseLog(text: string): LogRecord[] {
  const out: LogRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as LogRecord)
    } catch {
      // a line cut by a crash; skip it
    }
  }
  return out
}

// ---------------------------------------------------------------- the report

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!
}

function change(a: number, b: number): string {
  if (b === 0) return 'n/a'
  const p = Math.round(((a - b) / b) * 100)
  return `${p > 0 ? '+' : ''}${p}%`
}

const MIN_GROUP = 5

export function report(records: readonly LogRecord[], days: number): string {
  const turns = records.filter(r => r.type === 'turn' && r.v === 3)
  if (turns.length === 0) return `Jev report (last ${days} days): no turns logged yet.`
  const lines: string[] = []
  const byRoute = new Map<Route, number>()
  for (const t of turns) byRoute.set(t.route, (byRoute.get(t.route) ?? 0) + 1)
  lines.push(`Jev report, last ${days} days: ${turns.length} turns · ${[...byRoute.entries()].map(([r, n]) => `${n} ${r === 'gateway' ? 'through the gateway' : r === 'direct' ? 'direct' : r === 'excluded' ? 'in excluded repos' : 'direct while the gateway was down'}`).join(' · ')}.`)
  const fallbacks = turns.reduce((s, t) => s + (t.fallbacks ?? 0), 0)
  if (fallbacks > 0) lines.push(`The gateway stopped answering during ${turns.filter(t => t.fallbacks).length} turn(s); ${fallbacks} request(s) went direct instead of failing.`)

  const routed = turns.filter(t => t.gateway && t.gateway.requests > 0)
  if (routed.length === 0) return lines.join('\n')
  const all = routed.map(t => t.gateway!)
  const requests = all.reduce((s, g) => s + g.requests, 0)
  const tally = (pick: (g: GatewayTurn) => Record<string, number>) => {
    const m = new Map<string, number>()
    for (const g of all) for (const [k, n] of Object.entries(pick(g))) m.set(k, (m.get(k) ?? 0) + n)
    return m
  }
  const modes = tally(g => g.modes)
  const reasons = tally(g => g.reasons)
  const tools = new Map<string, number>()
  for (const g of all) for (const p of g.picks) tools.set(p.tool, (tools.get(p.tool) ?? 0) + 1)
  const top = (m: Map<string, number>, n: number, label = (k: string) => k) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${label(k)} ${v}`).join(', ')
  const picked = [...PICK_MODES].reduce((s, m) => s + (modes.get(m) ?? 0), 0)
  const jevMs = all.flatMap(g => g.jevMs)

  lines.push('', `jev-gateway: ${requests} requests in ${routed.length} turns; Jev chose the tool on ${picked} (${Math.round((picked / requests) * 100)}%).`)
  lines.push(`  How: ${top(modes, 6)}.`)
  if (reasons.size > 0) lines.push(`  Left to Claude because: ${top(reasons, 6, reasonText)}.`)
  if (tools.size > 0) lines.push(`  Tools Jev picked: ${top(tools, 8)}.`)
  if (jevMs.length > 0) lines.push(`  Jev's latency: p50 ${median(jevMs)}ms, worst ${Math.max(...jevMs)}ms.`)

  const on = routed.filter(t => t.gateway!.baseline === 0)
  const off = routed.filter(t => t.gateway!.baseline === t.gateway!.requests)
  lines.push('', 'Routing on vs off (baseline), per turn:')
  if (on.length >= MIN_GROUP && off.length >= MIN_GROUP) {
    const perRequest = (g: readonly TurnRecord[]) => median(g.map(t => t.gateway!.output / t.gateway!.requests))
    const requestsPerTurn = (g: readonly TurnRecord[]) => median(g.map(t => t.gateway!.requests))
    const time = (g: readonly TurnRecord[]) => median(g.map(t => t.actual.durationMs))
    lines.push(`  output per request ${Math.round(perRequest(on))} vs ${Math.round(perRequest(off))} (${change(perRequest(on), perRequest(off))})`)
    lines.push(`  requests per turn ${requestsPerTurn(on)} vs ${requestsPerTurn(off)} (${change(requestsPerTurn(on), requestsPerTurn(off))})`)
    lines.push(`  turn time ${Math.round(time(on) / 1000)}s vs ${Math.round(time(off) / 1000)}s (${change(time(on), time(off))})`)
    lines.push(`  over ${on.length} turns on and ${off.length} off; medians, so compare similar work.`)
  } else {
    lines.push(`  ${on.length} turns on, ${off.length} off: need ${MIN_GROUP} of each. Switch "Jev routing" off in the /jev pane for some similar work.`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- helpers

/** Whether the session's folder, or one above it, is named in `excluded` (comma-separated names). */
export function isExcluded(cwd: string, excluded: string): boolean {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return excluded
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .some(name => parts.includes(name))
}

export function isValidKey(key: string): boolean {
  return /^[A-Za-z0-9._\-]{20,300}$/.test(key)
}

/** The last folder name of a path, on any platform. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/**
 * Whether a base URL points at the gateway this mod runs on `port`: one an earlier install of the
 * mod left in the environment, not one jev-claude started.
 */
export function isOwnGateway(baseUrl: string | null | undefined, port: number): boolean {
  const origin = localGatewayOrigin(baseUrl)
  return origin !== undefined && Number(origin.split(':').pop()) === port
}

// ---------------------------------------------------------------- formatting for the pane

/** A prompt as one clean line: pasted-image markers and runs of whitespace gone. */
export function cleanPrompt(text: string): string {
  return text.replace(/\[(?:Image|Pasted text) #\d+[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** `Read ×3 · Bash ×2`: the tools Jev picked, most picked first. */
export function toolCounts(picks: readonly string[]): string {
  const m = new Map<string, number>()
  for (const t of picks) m.set(t, (m.get(t) ?? 0) + 1)
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => (n > 1 ? `${t} ×${n}` : t))
    .join(' · ')
}

/** `55s`, `5m 17s`. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** `840`, `23.6k`, `1.2M`. */
export function tokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** `640ms`, `1.7s`. */
export function latency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** `http://127.0.0.1:8789` from a base URL that points at a gateway on this machine, else undefined. */
export function localGatewayOrigin(baseUrl: string | null | undefined): string | undefined {
  const m = /^(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+)(?:\/|$)/.exec(baseUrl?.trim() ?? '')
  return m ? m[1] : undefined
}
