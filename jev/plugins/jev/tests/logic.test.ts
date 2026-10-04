import { describe, expect, test } from 'claude-code/testing'

import {
  MAX_TOOLS,
  NEEDS_TOOL_KEY,
  NO_TOOL,
  PROVIDERS,
  TOOL_KEY,
  buildState,
  cardFor,
  cleanPrompt,
  decide,
  decisionText,
  duration,
  emptyJevTurn,
  folderName,
  isExcluded,
  isGatewayOn,
  isValidKey,
  jevAccess,
  latency,
  localGatewayOrigin,
  normalizeAnswers,
  parseEnvFile,
  pickArm,
  reasonText,
  report,
  shortlistQuestions,
  shortlisted,
  skipReason,
  tally,
  tokens,
  toolCounts,
  toolQuestions,
  truncate,
  turnsFrom,
  upsertEnv,
} from '../hooks/logic'
import type { Answer, JevTurn, LogRecord, TurnRecord } from '../hooks/logic'

const TOOLS = [
  { name: 'Read', description: 'Reads a file.' },
  { name: 'Bash', description: 'Runs a shell command.' },
]
const choice = (pick: string, confidence: number): Answer => ({ type: 'choice', choice: pick, confidence, probabilities: { [pick]: confidence } })
const needs = (noul: number): Answer => ({ type: 'noul', noul })

describe("jev-gateway's rule", () => {
  test('hints only when Jev is sure and its two answers agree', () => {
    expect(decide(TOOLS, { [TOOL_KEY]: choice('Read', 0.9), [NEEDS_TOOL_KEY]: needs(0.8) })).toEqual({ mode: 'hint', tool: 'Read', confidence: 0.9 })
    expect(decide(TOOLS, { [TOOL_KEY]: choice('Read', 0.6), [NEEDS_TOOL_KEY]: needs(0.8) })).toEqual({ mode: 'pass', reason: 'low_confidence', confidence: 0.6 })
    expect(decide(TOOLS, { [TOOL_KEY]: choice('Read', 0.9), [NEEDS_TOOL_KEY]: needs(0.2) })).toMatchObject({ mode: 'pass', reason: 'jev_answers_disagree' })
    // "no tool" is never hinted: it could only end a turn early
    expect(decide(TOOLS, { [TOOL_KEY]: choice(NO_TOOL, 0.95), [NEEDS_TOOL_KEY]: needs(0.1) })).toMatchObject({ mode: 'pass', reason: 'no_tool_needed' })
    expect(decide(TOOLS, { [TOOL_KEY]: choice('Write', 0.95), [NEEDS_TOOL_KEY]: needs(0.9) })).toMatchObject({ mode: 'pass', reason: 'jev_unknown_tool' })
    expect(decide(TOOLS, { [TOOL_KEY]: choice('Read', 0.95) })).toEqual({ mode: 'pass', reason: 'jev_unexpected_answer' })
  })

  test('takes the winning probability when a choice comes without a confidence', () => {
    const answers = normalizeAnswers({ tool: { type: 'choice', choice: 'Read', probabilities: { Read: 0.7, Bash: 0.3 } }, needs_tool: { type: 'noul', noul: 0.9 }, junk: { type: 'x' } })
    expect(answers).toEqual({ tool: { type: 'choice', choice: 'Read', confidence: 0.7, probabilities: { Read: 0.7, Bash: 0.3 } }, needs_tool: { type: 'noul', noul: 0.9 } })
  })

  test('skips what is not its to decide', () => {
    const said = [{ role: 'user' as const, text: 'hi' }]
    expect(skipReason(TOOLS, [])).toBe('no_messages')
    expect(skipReason([], said)).toBe('no_tools')
    expect(skipReason([...TOOLS, TOOLS[0]!], said)).toBe('duplicate_tool_names')
    expect(skipReason([{ name: NO_TOOL, description: '' }], said)).toBe('reserved_tool_name')
    expect(skipReason([{ name: 'a tool', description: '' }], said)).toBe('unsafe_tool_name')
    expect(skipReason(TOOLS, said)).toBeUndefined()
  })

  test('asks two questions, with "no tool" offered beside the tools', () => {
    const q = toolQuestions(TOOLS)
    expect(Object.keys(q)).toEqual([TOOL_KEY, NEEDS_TOOL_KEY])
    expect(q[TOOL_KEY]!.type === 'choice' && Object.keys(q[TOOL_KEY]!.criteria)).toEqual(['Read', 'Bash', NO_TOOL])
  })

  test('shortlists a roster too big for one question, the top three of each shard', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ name: `t${i}`, description: `tool ${i}` }))
    const { questions, shards } = shortlistQuestions(many)
    expect(shards.map(s => s.length)).toEqual([84, 84, 82])
    expect(Object.keys(questions)).toEqual(['shard:0', 'shard:1', 'shard:2'])
    const probabilities = { t0: 0.5, t1: 0.2, t2: 0.1, t3: 0.05, none_of_these: 0.9 }
    const kept = shortlisted(shards, { 'shard:0': { type: 'choice', choice: 't0', confidence: 0.5, probabilities } })
    expect(kept.map(t => t.name)).toEqual(['t0', 't1', 't2'])
    expect(many.length).toBeGreaterThan(MAX_TOOLS)
  })
})

describe('what Jev reads', () => {
  test('the conversation in order: prose, each call and its result, with results not stored yet', () => {
    const turns = turnsFrom(
      [
        { role: 'user', text: 'why does the test fail?', toolUses: [] },
        { role: 'assistant', text: 'Looking.', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'x.ts' }, text: 'contents' }, { tool_use_id: 'b', tool: 'Bash', input: { command: 'npm test' } }] },
      ],
      { b: '1 failing' },
    )
    expect(turns).toEqual([
      { role: 'user', text: 'why does the test fail?' },
      { role: 'assistant', text: 'Looking.' },
      { role: 'assistant', tool_calls: [{ tool: 'Read', arguments: '{"file_path":"x.ts"}' }] },
      { role: 'tool_result', tool: 'Read', content: 'contents' },
      { role: 'assistant', tool_calls: [{ tool: 'Bash', arguments: '{"command":"npm test"}' }] },
      { role: 'tool_result', tool: 'Bash', content: '1 failing' },
    ])
  })

  test('the newest turns that fit, and how many were left out', () => {
    const big = 'x'.repeat(3_900)
    const turns = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, text: `${i}${big}` }))
    const state = buildState(turns)
    expect(state.earlier_turns_omitted).toBeGreaterThan(0)
    expect(state.conversation.at(-1)).toEqual(turns.at(-1))
    expect(state.conversation.length + state.earlier_turns_omitted!).toBe(40)
    expect(truncate('abcdefghij'.repeat(10), 40)).toContain('…[truncated]…')
  })
})

describe('the key', () => {
  test("reads jev-gateway's key file", () => {
    expect(parseEnvFile('JEV_PROVIDER=openrouter\nexport OPENROUTER_API_KEY="sk-or-1"\n# a comment\n\n')).toEqual({ JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-or-1' })
  })

  test('writes a key in, keeping the rest of the file', () => {
    expect(upsertEnv('# mine\nOPENROUTER_API_KEY=old\n', { JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'new' })).toBe('# mine\nOPENROUTER_API_KEY=new\nJEV_PROVIDER=openrouter\n')
    expect(upsertEnv('', { A: '1' })).toBe('A=1\n')
  })

  test("picks the provider, key, endpoint and model by jev-gateway's rule", () => {
    expect(jevAccess({ JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k' }, {})).toEqual({ provider: 'openrouter', key: 'k', url: PROVIDERS.openrouter.url, model: PROVIDERS.openrouter.model })
    expect(jevAccess({ TYPESAFE_API_KEY: 'k' }, {})?.provider).toBe('typesafe')
    // the environment wins over the file
    expect(jevAccess({ JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'k' }, { JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k2' })?.key).toBe('k2')
    // a model id from another provider's namespace is ignored
    expect(jevAccess({ TYPESAFE_API_KEY: 'k', JEV_MODEL: 'typesafe/jev-1.13' }, {})?.model).toBe(PROVIDERS.typesafe.model)
    expect(jevAccess({ OPENCODE_API_KEY: 'k', JEV_MODEL: PROVIDERS.opencode.paidModel }, {})?.model).toBe(PROVIDERS.opencode.paidModel)
    expect(jevAccess({ TYPESAFE_API_KEY: 'k', TYPESAFE_BASE_URL: 'http://127.0.0.1:9000/' }, {})?.url).toBe('http://127.0.0.1:9000/v1/systemone')
    // a provider named without its key is no key
    expect(jevAccess({ JEV_PROVIDER: 'typesafe' }, {})).toBeUndefined()
    expect(jevAccess({}, { OPENROUTER_API_KEY: '  ' })).toBeUndefined()
  })

  test('accepts key-shaped text only', () => {
    expect(isValidKey('sk-or-v1-0123456789abcdef0123456789')).toBe(true)
    expect(isValidKey('hello world')).toBe(false)
  })
})

describe('turns and decisions', () => {
  test('says each answer in plain words, and colors its card', () => {
    expect(decisionText({ mode: 'hint', tool: 'Bash', confidence: 0.82 })).toBe('Jev hinted Bash 0.82')
    expect(decisionText({ mode: 'hint', tool: 'Bash', confidence: 0.82 }, true)).toBe('Jev would hint Bash 0.82 (shadow)')
    expect(decisionText({ mode: 'pass', reason: 'low_confidence' })).toBe('Jev left it to Claude · Jev was unsure')
    expect(decisionText({ mode: 'pass', reason: 'jev_error: HTTP 500' })).toBe('Jev left it to Claude · Jev failed')
    expect(reasonText('something_new')).toBe('something new')
    expect(cardFor({ mode: 'hint' })).toBe('pick')
    expect(cardFor({ mode: 'pass', reason: 'low_confidence' })).toBe('pass')
    expect(cardFor({ mode: 'pass', reason: 'jev_error: HTTP 500' })).toBe('fail')
    expect(cardFor({ mode: 'pass', reason: 'jev_timeout' })).toBe('fail')
  })

  test('draws control turns at the configured rate; shadow is always shadow', () => {
    expect(pickArm('on', 20, 0.1)).toBe('control')
    expect(pickArm('on', 20, 0.5)).toBe('hint')
    expect(pickArm('on', 0, 0)).toBe('hint')
    expect(pickArm('shadow', 100, 0)).toBe('shadow')
  })

  test("tallies a turn's answers", () => {
    const j = emptyJevTurn()
    tally(j, { mode: 'hint', tool: 'Read', confidence: 0.9 }, 240)
    tally(j, { mode: 'pass', reason: 'low_confidence', confidence: 0.4 }, 300)
    tally(j, { mode: 'pass', reason: 'jev_error: HTTP 500' }, 90)
    expect(j).toEqual({ asked: 3, hinted: 1, followed: 0, picks: [{ tool: 'Read', confidence: 0.9 }], reasons: { low_confidence: 1, jev_error: 1 }, ms: [240, 300, 90], cards: ['pick', 'pass', 'fail'] })
  })
})

describe('the report', () => {
  const jev = (): JevTurn => ({ asked: 2, hinted: 1, followed: 1, picks: [{ tool: 'Read', confidence: 0.9 }], reasons: { low_confidence: 1 }, ms: [200, 300], cards: ['pick', 'pass'] })
  const turn = (id: string, arm: TurnRecord['arm'], steps: number, output: number, ms: number): TurnRecord => ({
    type: 'turn',
    v: 4,
    at: 1,
    session: 's',
    project: 'demo-app',
    turnId: id,
    prompt: 'is it in prod?',
    arm,
    actual: { steps, durationMs: ms, reason: 'answer', tools: 1, usage: { input: 10, output, cacheRead: 0, cacheWrite: 0 } },
    ...(arm === 'hint' || arm === 'shadow' ? { jev: jev() } : {}),
  })

  test('compares turns with hints against control turns once both groups are big enough', () => {
    const records: LogRecord[] = [...[1, 2, 3, 4, 5].map(i => turn(`h${i}`, 'hint', 3, 300, 6_000)), ...[1, 2, 3, 4, 5].map(i => turn(`c${i}`, 'control', 4, 500, 10_000))]
    const text = report(records, 7)
    expect(text).toContain('Jev report, last 7 days: 10 turns · 5 with hints · 5 control · 0 shadow.')
    expect(text).toContain('Jev was asked 10 times and was confident on 5 (50%).')
    expect(text).toContain('Claude followed 5 of 5 hints (100%).')
    expect(text).toContain('Tools Jev picked: Read 5.')
    expect(text).toContain('Left to Claude because: Jev was unsure 5.')
    expect(text).toContain("Jev's latency: p50 300ms, worst 300ms")
    expect(text).toContain('requests per turn 3 vs 4 (-25%)')
    expect(text).toContain('output tokens per turn 300 vs 500 (-40%)')
    expect(text).toContain('turn time 6s vs 10s (-40%)')
  })

  test('says when the groups are still too small, and counts excluded turns apart', () => {
    const text = report([turn('h1', 'hint', 2, 200, 5_000), turn('x1', 'excluded', 1, 50, 1_000)], 7)
    expect(text).toContain('2 turns · 1 with hints · 0 control · 0 shadow · 1 excluded or off.')
    expect(text).toContain('1 turns with hints, 0 control: need 5 of each.')
  })

  test('ignores records from earlier versions of the mod', () => {
    expect(report([{ type: 'turn', v: 3, at: 1 } as unknown as LogRecord], 7)).toContain('no turns logged yet')
  })
})

describe('helpers', () => {
  test('formats what the pane shows', () => {
    expect(cleanPrompt('[Image #3] I want an empty line\n\n  above')).toBe('I want an empty line above')
    expect(toolCounts(['Read', 'Bash', 'Read', 'Bash', 'Read', 'Grep'])).toBe('Read ×3 · Bash ×2 · Grep')
    expect(duration(55_000)).toBe('55s')
    expect(duration(317_000)).toBe('5m 17s')
    expect(tokens(23_600)).toBe('23.6k')
    expect(latency(1732)).toBe('1.7s')
  })

  test('excludes by folder name, not substring, on any platform', () => {
    expect(isExcluded('/Users/me/repo/clientA', 'clientA,x')).toBe(true)
    expect(isExcluded('/Users/me/repo/clientA/app', 'clientA')).toBe(true)
    expect(isExcluded('/Users/me/repo/clientAArchive', 'clientA')).toBe(false)
    expect(isExcluded('C:\\Users\\me\\repo\\clientA', 'clientA')).toBe(true)
    expect(isExcluded('/Users/me/repo/clientA', '')).toBe(false)
    expect(folderName('C:\\Users\\me\\demo-app')).toBe('demo-app')
  })

  test('finds a local gateway in ANTHROPIC_BASE_URL, and the port v0.4 used', () => {
    expect(localGatewayOrigin('http://localhost:8789/')).toBe('http://localhost:8789')
    expect(localGatewayOrigin('https://api.anthropic.com')).toBeUndefined()
    expect(isGatewayOn('http://127.0.0.1:8794', 8794)).toBe(true)
    expect(isGatewayOn('http://127.0.0.1:8789', 8794)).toBe(false)
    expect(isGatewayOn(null, 8794)).toBe(false)
  })
})
