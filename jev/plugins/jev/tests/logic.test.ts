import { describe, expect, test } from 'claude-code/testing'

import {
  cardFor,
  decisionText,
  emptyGatewayTurn,
  folderName,
  isExcluded,
  isValidKey,
  keyProvider,
  localGatewayOrigin,
  nodeVersionOk,
  parseEnvFile,
  reasonText,
  report,
  tallyGateway,
  upstreamFor,
} from '../hooks/logic'
import type { GatewayTurn, LogRecord, TurnRecord } from '../hooks/logic'

describe("the gateway's decisions", () => {
  test('says each decision in plain words', () => {
    expect(decisionText({ mode: 'hint', tool: 'Bash', confidence: 0.82 })).toBe('Jev picked Bash 0.82 (hint)')
    expect(decisionText({ mode: 'forced', tool: 'Read', confidence: 0.95 })).toBe('Jev picked Read 0.95 (forced)')
    expect(decisionText({ mode: 'direct', tool: 'Grep', confidence: 0.91 })).toBe('Jev called Grep 0.91 itself (direct)')
    expect(decisionText({ mode: 'passthrough', reason: 'low_confidence' })).toBe('Jev left it to Claude · Jev was unsure')
    expect(decisionText({ mode: 'passthrough', reason: 'jev_error: timeout' })).toBe('Jev left it to Claude · Jev failed')
    expect(reasonText('upstream_rejected_tool_choice')).toBe('the API refused the change')
    expect(reasonText('something_new')).toBe('something new')
  })

  test('colors the card by who decided', () => {
    expect(cardFor('hint')).toBe('pick')
    expect(cardFor('none')).toBe('pick')
    expect(cardFor('direct')).toBe('direct')
    expect(cardFor('passthrough')).toBe('pass')
  })

  test("tallies the gateway's requests per turn", () => {
    const g = emptyGatewayTurn()
    tallyGateway(g, { seq: 1, mode: 'hint', tool: 'Bash', confidence: 0.8, usage: { input: 1, output: 50, cached: 0, cacheWrite: 0, reasoning: 0 }, jev: { choice: 'Bash', confidence: 0.8, latencyMs: 240 } })
    tallyGateway(g, { seq: 2, mode: 'passthrough', reason: 'routing_disabled' })
    tallyGateway(g, { seq: 3, mode: 'passthrough', reason: 'router_error: boom' })
    expect(g).toEqual({
      requests: 3,
      modes: { hint: 1, passthrough: 2 },
      reasons: { routing_disabled: 1, router_error: 1 },
      picks: [{ tool: 'Bash', confidence: 0.8, mode: 'hint' }],
      baseline: 1,
      output: 50,
      jevMs: [240],
    })
  })
})

describe('setting the gateway up', () => {
  test("reads the gateway's key file", () => {
    expect(parseEnvFile('JEV_PROVIDER=openrouter\nexport OPENROUTER_API_KEY="sk-or-1"\n# a comment\n\n')).toEqual({ JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-or-1' })
  })

  test('finds the key the gateway will use, by its own rule', () => {
    expect(keyProvider({ JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k' }, {})).toBe('openrouter')
    expect(keyProvider({ TYPESAFE_API_KEY: 'k' }, {})).toBe('typesafe')
    expect(keyProvider({}, { OPENCODE_API_KEY: 'k' })).toBe('opencode')
    // the environment wins over the file
    expect(keyProvider({ JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'k' }, { JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k2' })).toBe('openrouter')
    // a provider named without its key is no key
    expect(keyProvider({ JEV_PROVIDER: 'typesafe' }, {})).toBeUndefined()
    expect(keyProvider({}, { OPENROUTER_API_KEY: '  ' })).toBeUndefined()
  })

  test('forwards to the API the session used before', () => {
    expect(upstreamFor(null)).toBe('https://api.anthropic.com/v1')
    expect(upstreamFor('https://llm-proxy.example.com/')).toBe('https://llm-proxy.example.com/v1')
    expect(upstreamFor('https://llm-proxy.example.com/v1')).toBe('https://llm-proxy.example.com/v1')
  })

  test("checks the Node.js the gateway needs", () => {
    expect(nodeVersionOk('v22.15.0\n')).toBe(true)
    expect(nodeVersionOk('v26.7.0')).toBe(true)
    expect(nodeVersionOk('v22.14.1')).toBe(false)
    expect(nodeVersionOk('v20.19.0')).toBe(false)
    expect(nodeVersionOk('')).toBe(false)
  })
})

describe('helpers', () => {
  test('excludes by folder name, not substring, on any platform', () => {
    expect(isExcluded('/Users/me/repo/clientA', 'clientA,x')).toBe(true)
    expect(isExcluded('/Users/me/repo/clientA/app', 'clientA')).toBe(true)
    expect(isExcluded('/Users/me/repo/clientAArchive', 'clientA')).toBe(false)
    expect(isExcluded('C:\\Users\\me\\repo\\clientA', 'clientA')).toBe(true)
    expect(isExcluded('/Users/me/repo/clientA', '')).toBe(false)
    expect(folderName('C:\\Users\\me\\demo-app')).toBe('demo-app')
  })

  test('accepts key-shaped text only', () => {
    expect(isValidKey('sk-or-v1-0123456789abcdef0123456789')).toBe(true)
    expect(isValidKey('hello world')).toBe(false)
  })

  test('finds a local jev-gateway in ANTHROPIC_BASE_URL', () => {
    expect(localGatewayOrigin('http://127.0.0.1:8789')).toBe('http://127.0.0.1:8789')
    expect(localGatewayOrigin('http://localhost:8789/')).toBe('http://localhost:8789')
    expect(localGatewayOrigin('https://api.anthropic.com')).toBeUndefined()
    expect(localGatewayOrigin(null)).toBeUndefined()
  })
})

describe('the report', () => {
  const gw = (requests: number, output: number, baseline: number): GatewayTurn => ({
    requests,
    modes: baseline ? { passthrough: requests } : { hint: 1, passthrough: requests - 1 },
    reasons: baseline ? { routing_disabled: baseline } : { low_confidence: requests - 1 },
    picks: baseline ? [] : [{ tool: 'Bash', confidence: 0.8, mode: 'hint' }],
    baseline,
    output,
    jevMs: baseline ? [] : [200, 300],
  })
  const turn = (id: string, g: GatewayTurn | undefined, ms: number, route: TurnRecord['route'] = 'gateway'): TurnRecord => ({
    type: 'turn',
    v: 3,
    at: 1,
    session: 's',
    project: 'demo-app',
    turnId: id,
    prompt: 'is it in prod?',
    route,
    actual: { steps: g?.requests ?? 1, durationMs: ms, reason: 'answer', tools: 1 },
    ...(g ? { gateway: g } : {}),
  })

  test('compares routing on with the baseline once both groups are big enough', () => {
    const records: LogRecord[] = [
      ...[1, 2, 3, 4, 5].map(i => turn(`on${i}`, gw(4, 400, 0), 6_000)),
      ...[1, 2, 3, 4, 5].map(i => turn(`off${i}`, gw(4, 800, 4), 10_000)),
    ]
    const text = report(records, 7)
    expect(text).toContain('Jev report, last 7 days: 10 turns · 10 through the gateway.')
    expect(text).toContain('jev-gateway: 40 requests in 10 turns; Jev chose the tool on 5 (13%).')
    expect(text).toContain('Left to Claude because: routing off (baseline) 20, Jev was unsure 15.')
    expect(text).toContain('Tools Jev picked: Bash 5.')
    expect(text).toContain("Jev's latency: p50 300ms, worst 300ms.")
    expect(text).toContain('output per request 100 vs 200 (-50%)')
    expect(text).toContain('turn time 6s vs 10s (-40%)')
  })

  test('says when the groups are still too small, and counts fallbacks and excluded turns', () => {
    const down: TurnRecord = { ...turn('d1', undefined, 2_000, 'down'), fallbacks: 3 }
    const text = report([turn('g1', gw(2, 200, 0), 5_000), down, turn('x1', undefined, 1_000, 'excluded')], 7)
    expect(text).toContain('3 turns · 1 through the gateway · 1 direct while the gateway was down · 1 in excluded repos.')
    expect(text).toContain('3 request(s) went direct instead of failing')
    expect(text).toContain('1 turns on, 0 off: need 5 of each.')
  })

  test('ignores records from earlier versions of the mod', () => {
    expect(report([{ type: 'turn', v: 2, at: 1 } as unknown as LogRecord], 7)).toContain('no turns logged yet')
  })
})
