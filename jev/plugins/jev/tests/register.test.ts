import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { DONE_NUDGE, hintText } from '../hooks/logic'

// The test runner has timers; the hooks environment's typings do not declare them.
declare function setTimeout(callback: (value?: unknown) => void, ms: number): unknown

const KEY = 'sk-or-v1-test0123456789abcdef0123456789'
const UNCUT = { isStdoutTruncated: false, isStderrTruncated: false }
const HOME = '/home/t'
const KEY_FILE = `${HOME}/.jev-gateway/.env`
const LOG_DIR = `${HOME}/.claude/jev-mod/log`
const JEV_URL = 'https://openrouter.ai/api/alpha/decisions'
const TOOLS = [
  { name: 'Read', description: 'Reads a file.', mcp: false },
  { name: 'Bash', description: 'Runs a shell command.', mcp: false },
]

/** Jev's answer to the prompt triage: the effort class and its two checks. */
const triageAnswer = (o: { effort?: string; confidence?: number; quick?: number; newTopic?: number; needsEarlier?: number } = {}): JevReply => ({
  status: 200,
  body: {
    answers: {
      effort: { type: 'choice', choice: o.effort ?? 'standard', confidence: o.confidence ?? 0.8, probabilities: {} },
      quick: { type: 'noul', noul: o.quick ?? 0.1 },
      newTopic: { type: 'noul', noul: o.newTopic ?? 0.1 },
      needsEarlier: { type: 'noul', noul: o.needsEarlier ?? 0.9 },
    },
  },
})

/** Jev's answer: `tool` at `confidence`, and "a tool is needed" at `noul`. */
const answer = (tool: string, confidence = 0.9, noul = 0.8) => ({
  status: 200,
  body: { answers: { tool: { type: 'choice', choice: tool, confidence, probabilities: { [tool]: confidence } }, needs_tool: { type: 'noul', noul } } },
})

type JevReply = { status: number; body?: unknown; hold?: Promise<void> }
type Row = { role: 'user' | 'assistant'; text: string; toolUses: { tool_use_id: string; tool: string; input: Record<string, unknown>; text?: string }[] }

type World = {
  env: Record<string, string | undefined>
  files: Record<string, string>
  runs: string[][]
  answers: string[]
  /** The conversation `$.session.messages()` returns, built when asked. */
  messages: () => Row[]
  /** What each call to Jev carried. */
  asks: { state: { conversation: unknown[] }; questions: Record<string, unknown>; model: string; auth: string }[]
  /** Jev's next replies, in order; once empty, Jev hints Read. */
  jev: JevReply[]
  /** The tools each model response calls, in order; once empty, it ends the turn. */
  responses: { name: string; input: Record<string, unknown> }[][]
  /** The ids the engine gave each tool call. */
  toolUseIds: string[]
  /** While set, a tool call stays running until it resolves. */
  toolHold?: Promise<void>
  /** What `$.session.usage()` reports: the session's cost and the weekly quota used. */
  usage: { usd: number; week?: number }
  /** Options the mod wrote through $.config.set. */
  configSets: string[]
  /** Jev's next answers to the prompt triage (effort, new topic); once empty, a plain prompt. */
  triage: JevReply[]
  /** What each triage call carried. */
  triageAsks: { state: { conversation: unknown[] } }[]
  /** Jev's answer to the skill gate: per skill index, how likely it is needed. */
  skillAnswer?: (i: number) => number
  skillAsks: { state: { conversation: { text?: string }[] }; questions: Record<string, unknown> }[]
  /** The tokens the session's context holds now. */
  contextTokens: number
  /** Commands the mod ran, and prompts it sent. */
  commands: string[]
  submitted: string[]
  /** The effort each main-loop request went out with. */
  efforts: (string | number | undefined)[]
  toasts: string[]
}

type Setup = { key?: boolean; env?: Record<string, string> }

/** The world beneath the plugin: the environment, files, the conversation, Jev's API, the model, the tools, the clipboard. */
function world(on: On, clock: MockClock, setup: Setup = {}): World {
  const w: World = { env: { HOME, ...setup.env }, files: {}, runs: [], answers: [], messages: () => [], asks: [], jev: [], responses: [], toolUseIds: [], usage: { usd: 0 }, configSets: [], triage: [], triageAsks: [], skillAsks: [], contextTokens: 20_000, commands: [], submitted: [], efforts: [], toasts: [] }
  if (setup.key !== false) w.files[KEY_FILE] = `JEV_PROVIDER=openrouter\nOPENROUTER_API_KEY=${KEY}\n`

  on('env.get', (_$, e) => ({ value: w.env[e.name] }))
  on('env.set', (_$, e) => {
    w.env[e.name] = e.value
    return { value: undefined }
  })
  on('fs.read', (_$, e) => (w.files[e.path] !== undefined ? { value: w.files[e.path]! } : { deny: 'ENOENT' }))
  on('fs.write', (_$, e) => {
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', (_$, e) => ({
    value: Object.keys(w.files)
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: w.files[path]!.length, mtimeMs: clock.now(), isLink: false })),
  }))
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', ...UNCUT } })
    if (argv[0] === 'pbpaste') return out(`${KEY}\n`)
    if (argv[0] === 'pbcopy' || argv[0] === 'chmod') return out('')
    return { deny: `spawn ${argv[0]} ENOENT` }
  })
  on('http.fetch', async (_$, e) => {
    if (e.url !== JEV_URL) return { deny: 'connect ECONNREFUSED' }
    const body = JSON.parse(e.init?.body ?? '{}')
    const keys = Object.keys(body.questions ?? {})
    const ok = (answers: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers }) } })
    if (keys.includes('newTopic')) {
      w.triageAsks.push(body)
      const r = w.triage.shift() ?? triageAnswer()
      if (r.hold) await r.hold
      return { value: { status: r.status, ok: r.status < 400, headers: {}, text: JSON.stringify(r.body ?? {}) } }
    }
    if (keys.every(k => k.startsWith('skill:'))) {
      w.skillAsks.push(body)
      return ok(Object.fromEntries(keys.map(k => [k, { type: 'noul', noul: (w.skillAnswer ?? (() => 0.9))(Number(k.slice(6))) }])))
    }
    w.asks.push({ ...body, auth: e.init?.headers?.authorization ?? '' })
    const reply: JevReply = w.jev.shift() ?? answer('Read')
    if (reply.hold) await reply.hold
    return { value: { status: reply.status, ok: reply.status < 400, headers: {}, text: JSON.stringify(reply.body ?? {}) } }
  })

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/Users/me/repo/demo-app' }))
  on('session.messages', () => ({ value: w.messages() as never }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: w.contextTokens, window: 1_000_000 } as never,
      rateLimits: w.usage.week !== undefined ? [{ kind: 'seven_day', percentUsed: w.usage.week, resetsAt: '2026-10-05T14:00:00' }] : [],
      cost: { usd: w.usage.usd },
    },
  }))
  on('tool.list', () => ({ value: TOOLS }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.blit', () => ({ value: {} }))
  on('prompt.submit', (_$, e) => {
    if (e.origin.kind === 'plugin') w.submitted.push(e.text)
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  on('tool.call', async (_$, e) => {
    const call = e as unknown as { tool: string; tool_use_id: string }
    if (call.tool === 'AskUserQuestion') {
      const { questions } = e as unknown as { questions: { question: string }[] }
      return { result: { questions, answers: { [questions[0]!.question]: w.answers.shift() ?? 'Cancel' } } } as never
    }
    w.toolUseIds.push(call.tool_use_id)
    if (w.toolHold) await w.toolHold
    return { result: 'done', text: `${call.tool} result` } as never
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    if (!e.agentId) w.efforts.push(e.effort)
    const toolUses = (e.agentId ? undefined : w.responses.shift()) ?? []
    return { turnId: e.turnId, index: e.index, answer: '', toolUses, stopReason: toolUses.length ? ('tool_use' as const) : ('end_turn' as const), usage: null }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  on('prompt.attachment', (_$, e) => ({ text: e.text }) as never)
  on('command.run', (_$, e) => {
    if (e.command === 'clear' || e.command === 'compact') {
      w.commands.push(e.command)
      return { text: '' }
    }
    return { text: `no such command: ${e.command}` }
  })
  const config: Record<string, unknown> = { 'jev.doneCheck': 'off', 'jev.verify': 'on', 'jev.effort': 'on', 'jev.skillGate': 'on', 'jev.freshStart': 'on', 'jev.mode': 'on' }
  on('config.list', () => ({ value: Object.entries(config).map(([key, value]) => ({ key, value })) as never }))
  on('config.set', (_$, e) => {
    config[e.key] = e.value
    w.configSets.push(`${e.key}=${String(e.value)}`)
    return { value: e.value }
  })
  return w
}

async function start($: Engine, cwd = '/Users/me/repo/demo-app') {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
}

async function submit($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

async function step($: Engine, turnId: string, index: number, agentId?: string) {
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 2 + index, ...(agentId ? { agentId } : {}) })
  for await (const _chunk of stream) {
    // drain
  }
}

const USAGE = { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }

async function complete($: Engine, w: World, turnId: string) {
  const before = logged(w).length
  await $.turn.complete({ answer: 'Found it.', durationMs: 4_000, isAborted: false, turnId, reason: 'answer', usage: USAGE })
  await settle(() => logged(w).length > before)
}

/** A whole turn with no tools: the prompt, one model request, the end. */
async function plainTurn($: Engine, w: World, text: string, turnId = 'turn-1') {
  const sent = await submit($, text)
  await $.turn.start({ text, turnId })
  await step($, turnId, 0)
  await complete($, w, turnId)
  return sent
}

async function settle(until: () => boolean) {
  for (let i = 0; i < 200 && !until(); i++) await new Promise(resolve => setTimeout(resolve, 5))
}

function logged(w: World) {
  const text = Object.entries(w.files).find(([path]) => path.startsWith(LOG_DIR))?.[1] ?? ''
  return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.type === 'turn')
}

async function command($: Engine, name: string) {
  return $.command.run({ command: name, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
}

/** Every turn gets hints: no control turns drawn at random. */
const HINTS = { options: { controlPercent: 0 } }

const PANE_PROPS = { title: 'Jev', isFocused: false, bodyColumns: 90, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }

async function band($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({ plugin: 'jev', surface, component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
}

/** The band's two balloons: what Claude says, then what Jev says (their tails left out). */
async function lines($: Engine) {
  const b = await band($)
  const texts = (await b.findAll({ type: 'Text' })).map(t => t.text).filter(t => t !== '◂' && t !== '▸')
  await b.unmount()
  return texts
}

test('asks Jev before the first request and after the tools; each hint rides the prompt or the last tool result', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  expect(await lines($)).toEqual(['ready when you are'])

  const sent = await submit($, 'why does the test fail?')
  expect(sent).toMatchObject({ context: [hintText('Read')] })
  expect(w.asks).toHaveLength(1)
  expect(w.asks[0]!.auth).toBe(`Bearer ${KEY}`)
  expect(w.asks[0]!.state.conversation.at(-1)).toEqual({ role: 'user', text: 'why does the test fail?' })
  // the answer runs back to Claude, said in Jev's balloon
  expect(await lines($)).toEqual(['…', 'hinted Read 0.90'])

  await $.turn.start({ text: 'why does the test fail?', turnId: 'turn-1' })
  w.responses.push([{ name: 'Read', input: { file_path: 'x.ts' } }])
  await step($, 'turn-1', 0)
  // a subagent's request is not the main loop's: not counted, Jev not asked
  await step($, 'agent-turn', 0, 'agent-1')
  w.messages = () => [
    { role: 'user', text: 'why does the test fail?', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: w.toolUseIds[0]!, tool: 'Read', input: { file_path: 'x.ts' } }] },
  ]
  w.jev.push(answer('Bash', 0.85))
  const read = await $.tool.call({ tool: 'Read', file_path: 'x.ts' })
  expect(read).toMatchObject({ context: [hintText('Bash')] })
  // Jev read the result Claude is about to read, before the conversation stored it
  expect(w.asks[1]!.state.conversation).toContainEqual({ role: 'tool_result', tool: 'Read', content: 'Read result' })

  await step($, 'turn-1', 1)
  await complete($, w, 'turn-1')
  const [record] = logged(w)
  expect(record).toMatchObject({
    v: 4,
    arm: 'hint',
    prompt: 'why does the test fail?',
    actual: { steps: 2, tools: 1, usage: { output: 300 } },
    // Claude called Read after the first hint, not Bash after the second
    jev: { asked: 2, hinted: 2, followed: 1, cards: ['pick', 'pick'] },
  })
  expect(await lines($)).toEqual(['ready when you are'])

  const pane = await $.ui.mount({ plugin: 'jev', surface: 'terminal', component: 'Pane', requestId: 'jev', props: PANE_PROPS })
  expect(await pane.find({ text: /1 hints in 1 turns|measuring: 1\/5 with, 0\/5 control/ })).toBeDefined()
  await pane.unmount()
})

test('one ask per response: with calls in parallel, only the last to finish asks and carries the hint', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  w.messages = () => [{ role: 'user', text: 'look around', toolUses: [] }]
  await submit($, 'look around')
  await $.turn.start({ text: 'look around', turnId: 'turn-1' })
  w.responses.push([
    { name: 'Read', input: { file_path: 'a.ts' } },
    { name: 'Bash', input: { command: 'ls' } },
  ])
  await step($, 'turn-1', 0)
  const results = await Promise.all([$.tool.call({ tool: 'Read', file_path: 'a.ts' }), $.tool.call({ tool: 'Bash', command: 'ls' })])
  expect(w.asks).toHaveLength(2)
  expect(results.filter(r => 'context' in r && r.context)).toHaveLength(1)
})

test('the band follows the turn: Jev deciding, its card landing, then Claude thinking and working', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  let release = () => {}
  w.jev.push({ ...answer('Read'), hold: new Promise<void>(r => (release = r)) })
  const sent = submit($, 'what changed?')
  await settle(() => w.asks.length === 1)
  expect(await lines($)).toEqual(['Jev, what next?', 'hmm… deciding'])
  release()
  await sent
  expect(await lines($)).toEqual(['…', 'hinted Read 0.90'])

  await $.turn.start({ text: 'what changed?', turnId: 'turn-1' })
  w.messages = () => [{ role: 'user', text: 'what changed?', toolUses: [] }]
  w.responses.push([{ name: 'Read', input: { file_path: 'x.ts' } }])
  await step($, 'turn-1', 0)
  // once the card has crossed, Claude's request shows, and Jev, done, says nothing
  await clock.advance(7 * 180)
  expect(await lines($)).toEqual(['thinking…'])

  let done = () => {}
  w.toolHold = new Promise<void>(r => (done = r))
  const call = $.tool.call({ tool: 'Read', file_path: 'x.ts' })
  await settle(() => w.toolUseIds.length === 1)
  expect(await lines($)).toEqual(['running Read'])
  done()
  await call
  expect(w.asks).toHaveLength(2)
})

test('Jev too slow: the prompt goes on without a hint after the time budget, and the card says so', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  let release = () => {}
  w.jev.push({ ...answer('Read'), hold: new Promise<void>(r => (release = r)) })
  const sent = submit($, 'is it in prod?')
  await settle(() => w.asks.length === 1)
  await clock.advance(4_000)
  const result = await sent
  expect('context' in result ? result.context : undefined).toBeUndefined()
  expect(await lines($)).toEqual(['…', 'left it to Claude · Jev too slow'])
  release()
})

test('Jev failing: the request goes on without a hint, counted as a failure', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  w.jev.push({ status: 503 }, { status: 503 })
  const sent = submit($, 'hello')
  await settle(() => w.asks.length === 1)
  // one retry after a short pause, then it gives up
  await clock.advance(100)
  const result = await sent
  expect('context' in result ? result.context : undefined).toBeUndefined()
  expect(w.asks).toHaveLength(2)
  await $.turn.start({ text: 'hello', turnId: 'turn-1' })
  await step($, 'turn-1', 0)
  await complete($, w, 'turn-1')
  expect(logged(w)[0]).toMatchObject({ arm: 'hint', jev: { asked: 1, hinted: 0, reasons: { jev_error: 1 }, cards: ['fail'] } })
})

test('out of credits: Jev rests after a 402, says so once, and is tried again after the rest', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  w.jev.push({ status: 402 })
  await plainTurn($, w, 'hello')
  expect(w.asks).toHaveLength(1)
  expect(w.toasts.filter(t => t.includes('HTTP 402'))).toHaveLength(1)
  // resting: Jev is not called, and the skipped ask is not a failure
  await plainTurn($, w, 'and now?', 'turn-2')
  expect(w.asks).toHaveLength(1)
  expect(logged(w)[1].jev?.reasons?.jev_error).toBeUndefined()
  await clock.advance(15 * 60_000)
  await plainTurn($, w, 'and now?', 'turn-3')
  expect(w.asks).toHaveLength(2)
  expect(logged(w)[2].jev).toMatchObject({ asked: 1, hinted: 1 })
})

test('a long turn asks Jev at most 8 times: the prompt, then 7 batches of tool results', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  w.messages = () => [{ role: 'user', text: 'fix every test', toolUses: [] }]
  await submit($, 'fix every test')
  await $.turn.start({ text: 'fix every test', turnId: 'turn-1' })
  for (let i = 0; i < 12; i++) {
    w.responses.push([{ name: 'Read', input: { file_path: 'x.ts' } }])
    await step($, 'turn-1', i)
    await $.tool.call({ tool: 'Read', file_path: 'x.ts' })
  }
  await step($, 'turn-1', 12)
  await complete($, w, 'turn-1')
  expect(w.asks).toHaveLength(8)
  expect(logged(w)[0]).toMatchObject({ actual: { steps: 13, tools: 12 }, jev: { asked: 8 } })
})

test('a control turn: Jev sits it out, the owl sleeps, and the band says why', { options: { controlPercent: 100 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  await submit($, 'hello')
  await $.turn.start({ text: 'hello', turnId: 'turn-1' })
  w.responses.push([{ name: 'Bash', input: { command: 'ls' } }])
  await step($, 'turn-1', 0)
  expect(await lines($)).toEqual(['thinking…'])
  const bash = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect('context' in bash ? bash.context : undefined).toBeUndefined()
  await step($, 'turn-1', 1)
  await complete($, w, 'turn-1')
  expect(w.asks).toHaveLength(0)
  expect(logged(w)[0]).toMatchObject({ arm: 'control' })
  expect(logged(w)[0].jev).toBeUndefined()
})

test('an excluded repo: Jev is never asked, the band stays out of the way, and its words stay out of the log', { options: { excludedRepos: 'demo-app' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text as never, null, 'the engine band') as never
  })
  await start($)
  await plainTurn($, w, 'the client secret plan')
  expect(w.asks).toHaveLength(0)
  expect(logged(w)[0]).toMatchObject({ arm: 'excluded', prompt: '' })
  const quiet = await band($)
  expect(await quiet.find({ text: /Jev/ })).toBeUndefined()
  expect(await quiet.find({ text: /the engine band/ })).toBeDefined()
  await quiet.unmount()
})

test('off in /config: nothing is asked and nothing logged', { options: { mode: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  await submit($, 'hello')
  await $.turn.start({ text: 'hello', turnId: 'turn-1' })
  await step($, 'turn-1', 0)
  await $.turn.complete({ answer: 'Hi.', durationMs: 1_000, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  expect(w.asks).toHaveLength(0)
  expect(logged(w)).toEqual([])
})

test('no key: the band says what to do, on every surface, and nothing is asked', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock, { key: false })
  await start($)
  expect(await lines($)).toEqual(['no Jev yet', 'not set up · run /jev-setup'])
  const desktop = await band($, 'desktop')
  expect(await desktop.find({ text: /not set up · run \/jev-setup/ })).toBeDefined()
  await desktop.unmount()
  await submit($, 'hello')
  expect(w.asks).toHaveLength(0)
})

test('/jev-setup checks the key with one call, saves it without it reaching argv or the output, and Jev is ready', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock, { key: false })
  await start($)
  w.answers.push('OpenRouter', 'Read the clipboard')
  const out = await command($, 'jev-setup')
  expect(out.text).toContain('Key checked')
  expect(out.text).toContain('Jev is ready (OpenRouter)')
  expect(out.text).not.toContain(KEY)
  expect(w.files[KEY_FILE]).toBe(`JEV_PROVIDER=openrouter\nOPENROUTER_API_KEY=${KEY}\n`)
  expect(w.runs.some(argv => argv.join(' ').includes(KEY))).toBe(false)
  expect(w.runs).toContainEqual(['chmod', '600', KEY_FILE])
  expect(w.runs.some(argv => argv[0] === 'pbcopy')).toBe(true)
  expect(await lines($)).toEqual(['ready when you are'])
})

test('/jev-setup switching provider drops the old provider\'s model name', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock, { key: false })
  w.files[KEY_FILE] = 'JEV_PROVIDER=opencode\nOPENCODE_API_KEY=oc-0123456789abcdef0123\nJEV_MODEL=jev-1.13-free\n'
  await start($)
  w.answers.push('Set a new key', 'OpenRouter', 'Read the clipboard')
  await command($, 'jev-setup')
  expect(w.files[KEY_FILE]).toBe(`JEV_PROVIDER=openrouter\nOPENCODE_API_KEY=oc-0123456789abcdef0123\nOPENROUTER_API_KEY=${KEY}\n`)
})

test('/jev-setup with a refused key saves nothing', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock, { key: false })
  await start($)
  w.answers.push('OpenRouter', 'Read the clipboard')
  w.jev.push({ status: 401, body: { error: 'bad key' } })
  const out = await command($, 'jev-setup')
  expect(out.text).toContain('OpenRouter refused that key')
  expect(w.files[KEY_FILE]).toBeUndefined()
})

test('a session v0.4 left pointing at its gateway goes straight to the API again', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock, { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8794' } })
  await start($)
  expect(w.env.ANTHROPIC_BASE_URL).toBeUndefined()
})

test('a local proxy the session started with is kept, and the pane notes it', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock, { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789' } })
  await start($)
  expect(w.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8789')
  const pane = await $.ui.mount({ plugin: 'jev', surface: 'terminal', component: 'Pane', requestId: 'jev', props: PANE_PROPS })
  expect(await pane.find({ text: /local proxy \(http:\/\/127\.0\.0\.1:8789\)/ })).toBeDefined()
  await pane.unmount()
})

test("spend: Jev's price per call, Claude's cost and weekly quota per turn, in the log and the pane", HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  w.usage = { usd: 1.0, week: 40 }
  await start($)
  w.jev.push({ status: 200, body: { ...answer('Read').body, usage: { cost: 0.00012 } } })
  await submit($, 'what changed?')
  await $.turn.start({ text: 'what changed?', turnId: 'turn-1' })
  await step($, 'turn-1', 0)
  w.usage = { usd: 1.35, week: 40.5 }
  await complete($, w, 'turn-1')
  expect(logged(w)[0]).toMatchObject({ actual: { usd: 0.35, weekPct: 0.5, weekUsed: 40.5 }, jev: { usd: 0.00012, unpriced: 0 } })

  const pane = await $.ui.mount({ plugin: 'jev', surface: 'terminal', component: 'Pane', requestId: 'jev', props: PANE_PROPS })
  expect(await pane.find({ text: /^Spent on Jev\s+\$0\.0001  last 7 days$/ })).toBeDefined()
  await pane.unmount()
})

/** Jev's answers to the done check's three questions. */
const doneAnswer = (requested: number, waiting: number, promised: number) => ({
  status: 200,
  body: { answers: { requested: { type: 'noul', noul: requested }, waiting: { type: 'noul', noul: waiting }, promised: { type: 'noul', noul: promised } } },
})

/** A turn that ends with Claude's stop: the hint ask, one request, the stop, the end. */
async function stoppingTurn($: Engine, w: World, last: string, stop: { tasks?: { status: string }[]; active?: boolean } = {}, turnId = 'turn-1') {
  w.messages = () => [{ role: 'user', text: 'extract the contacts', toolUses: [] }]
  await submit($, 'extract the contacts')
  await $.turn.start({ text: 'extract the contacts', turnId })
  await step($, turnId, 0)
  const stopped = await $.classic.Stop({
    stop_hook_active: stop.active ?? false,
    last_assistant_message: last,
    background_tasks: (stop.tasks ?? []).map((t, i) => ({ id: `t${i}`, type: 'shell', description: 'job', ...t })),
    session_crons: [],
  })
  await complete($, w, turnId)
  return stopped
}

test('done check on: the broken promise sends Claude back to work, once per turn', { options: { controlPercent: 0, doneCheck: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  w.jev.push(answer('Bash'), doneAnswer(0.97, 0.05, 0.96))
  w.messages = () => [{ role: 'user', text: 'extract the contacts', toolUses: [] }]
  await submit($, 'extract the contacts')
  await $.turn.start({ text: 'extract the contacts', turnId: 'turn-1' })
  await step($, 'turn-1', 0)
  const first = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: "I'll keep extracting.", background_tasks: [], session_crons: [] })
  expect(first.block).toBe(DONE_NUDGE)
  const asked = w.asks.length
  // the stop that follows the push is never checked again
  const second = await $.classic.Stop({ stop_hook_active: true, last_assistant_message: 'Done: 120 contacts imported.', background_tasks: [], session_crons: [] })
  expect(second.block).toBeUndefined()
  expect(w.asks).toHaveLength(asked)
  await complete($, w, 'turn-1')
  expect(logged(w)[0].done).toMatchObject({ verdict: 'push', pushed: true })
})

test('done check: work left running keeps the promise, and Jev is not asked', { options: { controlPercent: 0, doneCheck: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  const stopped = await stoppingTurn($, w, "I'll report when the job finishes.", { tasks: [{ status: 'running' }] })
  expect(stopped.block).toBeUndefined()
  expect(w.asks).toHaveLength(1) // the hint ask only
  expect(logged(w)[0].done).toEqual({ verdict: 'running', pushed: false })
})

test('done check: a finished report, or Claude waiting on the user, lets the stop through', { options: { controlPercent: 0, doneCheck: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  w.jev.push(answer('Bash'), doneAnswer(0.97, 0.02, 0.1))
  expect((await stoppingTurn($, w, 'Done: all 120 contacts imported.')).block).toBeUndefined()
  w.jev.push(answer('Bash'), doneAnswer(0.97, 0.6, 0.95))
  expect((await stoppingTurn($, w, 'Which list should I import next?', {}, 'turn-2')).block).toBeUndefined()
  expect(logged(w).map(r => r.done.verdict)).toEqual(['ok', 'ok'])
})

test('done check: Jev failing lets the stop through', { options: { controlPercent: 0, doneCheck: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  w.jev.push(answer('Bash'), { status: 401 })
  expect((await stoppingTurn($, w, "I'll keep going.")).block).toBeUndefined()
  expect(logged(w)[0].done).toMatchObject({ verdict: 'error', pushed: false })
})

test('done check off: stops are never checked', { options: { controlPercent: 0, doneCheck: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  await stoppingTurn($, w, "I'll keep going.")
  expect(w.asks).toHaveLength(1)
  expect(logged(w)[0].done).toBeUndefined()
})

test('a reload (no session.start) sets the session up on first use: the key is read and Jev is asked', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  // no start($): /reload-plugins and plugin updates load the module without session.start
  const sent = await plainTurn($, w, 'why does the test fail?')
  expect(sent).toMatchObject({ context: [hintText('Read')] })
  expect(logged(w)[0]).toMatchObject({ arm: 'hint', project: 'demo-app' })
  expect(await lines($)).toEqual(['ready when you are'])
})

test('effort: a quick status question runs at low effort on the same model, and goes back to your effort once it grows', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  w.triage.push(triageAnswer({ effort: 'status', confidence: 0.85, quick: 0.9 }))
  await submit($, 'is it in prod?')
  await $.turn.start({ text: 'is it in prod?', turnId: 'turn-1' })
  for (let i = 0; i < 10; i++) await step($, 'turn-1', i)
  await complete($, w, 'turn-1')
  expect(w.efforts).toEqual([...Array(8).fill('low'), 'xhigh', 'xhigh'])
  expect(logged(w)[0].triage).toMatchObject({ quick: true, effort: 'status', lowEffort: 'exited' })

  // an ordinary prompt keeps the session's effort
  await plainTurn($, w, 'implement the export', 'turn-2')
  expect(w.efforts.at(-1)).toBe('xhigh')
  expect(logged(w)[1].triage.lowEffort).toBeUndefined()
})

test('fresh start: a new task in a long conversation is offered /clear, then sent again as yours', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  w.contextTokens = 180_000
  w.triage.push(triageAnswer({ newTopic: 0.95, needsEarlier: 0.03 }))
  w.answers.push('Start fresh (/clear), then send it')
  const sent = await submit($, 'ok, another subject: draft the newsletter')
  expect(sent).toMatchObject({ drop: expect.stringContaining('clearing the conversation') })
  await clock.advance(50)
  await settle(() => w.submitted.length > 0 || w.toasts.length > 0)
  expect(w.toasts).toEqual([])
  expect(w.commands).toEqual(['clear'])
  expect(w.submitted).toEqual(['ok, another subject: draft the newsletter'])
})

test('fresh start: kept when declined, and never offered for a short conversation or a follow-up', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  w.contextTokens = 180_000
  w.triage.push(triageAnswer({ newTopic: 0.95, needsEarlier: 0.03 }))
  w.answers.push('Keep the conversation')
  await plainTurn($, w, 'another subject: the invoices')
  expect(logged(w)[0].triage.fresh).toBe('kept')
  // a follow-up needs the conversation: not offered
  w.triage.push(triageAnswer({ newTopic: 0.95, needsEarlier: 0.4 }))
  await plainTurn($, w, 'and the same for March', 'turn-2')
  // a short conversation: not worth it
  w.contextTokens = 30_000
  w.triage.push(triageAnswer({ newTopic: 0.97, needsEarlier: 0.01 }))
  await plainTurn($, w, 'unrelated: what time is it in Tokyo?', 'turn-3')
  expect(w.commands).toEqual([])
  expect(logged(w).map(r => r.triage.fresh)).toEqual(['kept', undefined, undefined])
})

const LISTING = ['- deploy: Ship the app to Railway and check it.', '- generate-image: Make pictures', '  with a local server.', '- review: Review the diff for bugs.', '- translate-book: Translate scanned Japanese books.'].join('\n')

test('skill gate: skills the project will not need keep only their name, the same for the whole session', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  w.files['/Users/me/repo/demo-app/README.md'] = '# demo-app\nA Next.js app deployed on Railway.'
  w.skillAnswer = i => [0.9, 0.1, 0.8, 0.05][i]!
  await start($)
  const first = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
  expect(first.text).toBe(['- deploy: Ship the app to Railway and check it.', '- generate-image', '- review: Review the diff for bugs.', '- translate-book'].join('\n'))
  expect(w.skillAsks[0]!.state.conversation[0]!.text).toContain('A Next.js app deployed on Railway.')
  // a later render of the listing: the same decision, no new call
  const again = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
  expect(again.text).toBe(first.text)
  expect(w.skillAsks).toHaveLength(1)
  await plainTurn($, w, 'deploy it')
  expect(logged(w)[0].saved.skills).toBeGreaterThan(0)
  const pane = await $.ui.mount({ plugin: 'jev', surface: 'terminal', component: 'Pane', requestId: 'jev', props: PANE_PROPS })
  expect(await pane.find({ text: /fewer tokens on every request/ })).toBeDefined()
  await pane.unmount()
})

test('hints off: no hint reaches Claude, Jev is not asked about tools, and the other features still run', { options: { controlPercent: 0, mode: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  w.triage.push(triageAnswer({ effort: 'status', confidence: 0.9, quick: 0.9 }))
  const sent = await plainTurn($, w, 'are we done?')
  expect('context' in sent ? sent.context : undefined).toBeUndefined()
  expect(w.asks).toHaveLength(0)
  expect(w.efforts).toEqual(['low'])
  expect(logged(w)[0]).toMatchObject({ arm: 'off', triage: { lowEffort: 'applied' } })
})

test('effort off: never applied', { options: { controlPercent: 0, effort: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  w.triage.push(triageAnswer({ effort: 'status', confidence: 0.85, quick: 0.9 }))
  await plainTurn($, w, 'are we done?')
  expect(w.efforts).toEqual(['xhigh'])
  expect(logged(w)[0].triage.lowEffort).toBeUndefined()
})

test('a control turn runs with no Jev feature: no hint, no low effort, recorded to compare with', { options: { controlPercent: 100 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  w.triage.push(triageAnswer({ effort: 'status', confidence: 0.9, quick: 0.9 }))
  await plainTurn($, w, 'is it deployed?')
  expect(w.efforts).toEqual(['xhigh'])
  expect(logged(w)[0]).toMatchObject({ arm: 'control', triage: { lowEffort: 'control' } })
})

test('skill gate off: the listing stays whole and Jev is not asked', { options: { controlPercent: 0, skillGate: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  w.skillAnswer = () => 0.05
  await start($)
  const out = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
  expect(out.text).toBe(LISTING)
  expect(w.skillAsks).toHaveLength(0)
})

test('the board: each feature on or off with a key, saved in /config, and what it saved of the weekly quota', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  w.skillAnswer = i => (i === 0 ? 0.9 : 0.05)
  w.usage = { usd: 0, week: 10 }
  await start($)
  await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
  for (let i = 0; i < 3; i++) {
    w.usage = { usd: w.usage.usd, week: w.usage.week! + 0.5 }
    await plainTurn($, w, `turn ${i}`, `turn-${i}`)
  }
  const pane = await $.ui.mount({ plugin: 'jev', surface: 'terminal', component: 'Pane', requestId: 'jev', props: PANE_PROPS })
  expect(await pane.find({ text: /^skill gate/ })).toBeDefined()
  expect(await pane.find({ text: /\+\d+\.\d%|<0\.1%/ })).toBeDefined()
  expect(await pane.find({ text: /measuring: 3\/5 with, 0\/5 control/ })).toBeDefined()
  // the total is what the features saved together
  expect(await pane.find({ text: /^Quota saved\s+(\+\d+\.\d%|<0\.1%)  of the weekly quota$/ })).toBeDefined()
  await pane.press({ key: 'done' })
  await pane.press({ key: 'effort' })
  expect(w.configSets).toEqual(['jev.doneCheck=on', 'jev.effort=off'])
  expect(await pane.find({ type: 'Button', key: 'done', text: 'done check off' })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'effort', text: 'effort on' })).toBeDefined()
  await pane.unmount()
})

test('the board: the options first, then the figures, then a chart per feature by day', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  w.usage = { usd: 0, week: 10 }
  await start($)
  await plainTurn($, w, 'turn 0', 'turn-0')
  const pane = await $.ui.mount({ plugin: 'jev', surface: 'terminal', component: 'Pane', requestId: 'jev', props: PANE_PROPS })
  const texts = (await pane.findAll({})).map(n => n.text ?? '')
  const firstButton = texts.findIndex(t => /^hints (on|off)$/.test(t))
  const spent = texts.findIndex(t => /^Spent on Jev/.test(t))
  const byDay = texts.findIndex(t => /^By day/.test(t))
  expect(firstButton).toBeGreaterThan(-1)
  expect(firstButton).toBeLessThan(spent)
  expect(spent).toBeLessThan(byDay)
  for (const label of ['hints', 'effort', 'skill gate', 'fresh start', 'done check']) expect(await pane.find({ text: new RegExp(`^${label}\\s+(measuring…|[+-<>].*days|\\d+ stops checked)$`) })).toBeDefined()
  await pane.unmount()
})

/** A turn that runs `calls`, then stops; the stop's answer. */
async function verifyTurn($: Engine, calls: Record<string, unknown>[], last = 'Done.', turnId = 'turn-1') {
  await submit($, 'build the settings screen')
  await $.turn.start({ text: 'build the settings screen', turnId })
  await step($, turnId, 0)
  for (const c of calls) await $.tool.call(c as never)
  return $.classic.Stop({ stop_hook_active: false, last_assistant_message: last, background_tasks: [], session_crons: [] })
}

const EDIT_SCREEN = { tool: 'Edit', file_path: "/w/demo-app/src/Settings.tsx", old_string: 'a', new_string: 'b' }
const EDIT_CODE = { tool: 'Edit', file_path: "/w/demo-app/src/export.ts", old_string: 'a', new_string: 'b' }

test('verify: a screen changed and never looked at sends Claude back once to look at it', { options: { controlPercent: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  // a test run does not show a screen: Claude is still sent to look
  const first = await verifyTurn($, [EDIT_SCREEN, { tool: 'Bash', command: 'npm test' }])
  expect(first.block).toMatch(/You changed what the user will see \(Settings\.tsx\)/)
  // once per turn: the next stop goes through, whatever it did
  const second = await $.classic.Stop({ stop_hook_active: true, last_assistant_message: 'I could not open a browser here.', background_tasks: [], session_crons: [] })
  expect(second.block).toBeUndefined()
  await complete($, w, 'turn-1')
  expect(logged(w)[0].verify).toEqual({ need: 'look', pushed: true, files: 1 })
})

test('verify: changes checked after the last edit go through; code needs a run, a screen a look', { options: { controlPercent: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  expect((await verifyTurn($, [EDIT_CODE, { tool: 'Bash', command: 'npx vitest run' }])).block).toBeUndefined()
  await complete($, w, 'turn-1')
  expect((await verifyTurn($, [EDIT_SCREEN, { tool: 'mcp__claude-in-chrome__computer', action: 'screenshot' }], 'Done.', 'turn-2')).block).toBeUndefined()
  await complete($, w, 'turn-2')
  // a run before the last edit does not count
  expect((await verifyTurn($, [EDIT_CODE, { tool: 'Bash', command: 'npm test' }, EDIT_CODE], 'Done.', 'turn-3')).block).toMatch(/You changed export\.ts but nothing has run since/)
  await complete($, w, 'turn-3')
  expect(logged(w).map(r => r.verify)).toEqual([
    { pushed: false, files: 1 },
    { pushed: false, files: 1 },
    { need: 'run', pushed: true, files: 1 },
  ])
})

test('verify: no changes, a question to the person, or verify off: nothing to check', { options: { controlPercent: 0, verify: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  expect((await verifyTurn($, [EDIT_CODE])).block).toBeUndefined()
  await complete($, w, 'turn-1')
  const pane = await $.ui.mount({ plugin: 'jev', surface: 'terminal', component: 'Pane', requestId: 'jev', props: PANE_PROPS })
  await pane.press({ key: 'verify' })
  await pane.unmount()
  expect(w.configSets).toEqual(['jev.verify=on'])
  expect((await verifyTurn($, [{ tool: 'Read', file_path: "/w/demo-app/a.ts" }], 'Done.', 'turn-2')).block).toBeUndefined()
  await complete($, w, 'turn-2')
  expect((await verifyTurn($, [EDIT_CODE], 'Should the export include archived rows?', 'turn-3')).block).toBeUndefined()
  await complete($, w, 'turn-3')
  expect((await verifyTurn($, [EDIT_CODE], 'Done.', 'turn-4')).block).toMatch(/nothing has run since/)
})
