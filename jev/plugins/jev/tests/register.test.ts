import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { hintText } from '../hooks/logic'

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
}

type Setup = { key?: boolean; env?: Record<string, string> }

/** The world beneath the plugin: the environment, files, the conversation, Jev's API, the model, the tools, the clipboard. */
function world(on: On, clock: MockClock, setup: Setup = {}): World {
  const w: World = { env: { HOME, ...setup.env }, files: {}, runs: [], answers: [], messages: () => [], asks: [], jev: [], responses: [], toolUseIds: [] }
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
    w.asks.push({ ...body, auth: e.init?.headers?.authorization ?? '' })
    const reply: JevReply = w.jev.shift() ?? answer('Read')
    if (reply.hold) await reply.hold
    return { value: { status: reply.status, ok: reply.status < 400, headers: {}, text: JSON.stringify(reply.body ?? {}) } }
  })

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.messages', () => ({ value: w.messages() as never }))
  on('tool.list', () => ({ value: TOOLS }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.blit', () => ({ value: {} }))
  on('prompt.submit', (_$, e) => ({ text: e.text, ...(e.context ? { context: e.context } : {}) }))
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
    const toolUses = (e.agentId ? undefined : w.responses.shift()) ?? []
    return { turnId: e.turnId, index: e.index, answer: '', toolUses, stopReason: toolUses.length ? ('tool_use' as const) : ('end_turn' as const), usage: null }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
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

/** The band's two lines: what is happening, and the setting under it. */
async function lines($: Engine) {
  const b = await band($)
  const texts = (await b.findAll({ type: 'Text' })).map(t => t.text)
  await b.unmount()
  return texts
}

test('asks Jev before the first request and after the tools; each hint rides the prompt or the last tool result', HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  expect(await lines($)).toEqual(['Jev idle', 'routing on'])

  const sent = await submit($, 'why does the test fail?')
  expect(sent).toMatchObject({ context: [hintText('Read')] })
  expect(w.asks).toHaveLength(1)
  expect(w.asks[0]!.auth).toBe(`Bearer ${KEY}`)
  expect(w.asks[0]!.state.conversation.at(-1)).toEqual({ role: 'user', text: 'why does the test fail?' })
  // the answer runs back to Claude, said under the status line's setting
  expect(await lines($)).toEqual(['Jev hinted Read 0.90', 'routing on'])

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
  expect(await lines($)).toEqual(['Jev idle', 'routing on'])

  const out = await command($, 'jev-report')
  expect(out.text).toContain('1 turns · 1 with hints · 0 control · 0 shadow.')
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
  expect(await lines($)).toEqual(['Jev deciding…', 'routing on'])
  release()
  await sent
  expect(await lines($)).toEqual(['Jev hinted Read 0.90', 'routing on'])

  await $.turn.start({ text: 'what changed?', turnId: 'turn-1' })
  w.messages = () => [{ role: 'user', text: 'what changed?', toolUses: [] }]
  w.responses.push([{ name: 'Read', input: { file_path: 'x.ts' } }])
  await step($, 'turn-1', 0)
  // once the card has crossed, Claude's request shows
  await clock.advance(7 * 180)
  expect(await lines($)).toEqual(['Claude thinking…', 'routing on'])

  let done = () => {}
  w.toolHold = new Promise<void>(r => (done = r))
  const call = $.tool.call({ tool: 'Read', file_path: 'x.ts' })
  await settle(() => w.toolUseIds.length === 1)
  expect(await lines($)).toEqual(['Claude working · Read', 'routing on'])
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
  expect(await lines($)).toEqual(['Jev left it to Claude · Jev too slow', 'routing on'])
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

test('a control turn: Jev sits it out, the owl sleeps, and the band says why', { options: { controlPercent: 100 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  await submit($, 'hello')
  await $.turn.start({ text: 'hello', turnId: 'turn-1' })
  w.responses.push([{ name: 'Bash', input: { command: 'ls' } }])
  await step($, 'turn-1', 0)
  expect(await lines($)).toEqual(['Claude thinking…', 'routing on · control turn, no hints'])
  const bash = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect('context' in bash ? bash.context : undefined).toBeUndefined()
  await step($, 'turn-1', 1)
  await complete($, w, 'turn-1')
  expect(w.asks).toHaveLength(0)
  expect(logged(w)[0]).toMatchObject({ arm: 'control' })
  expect(logged(w)[0].jev).toBeUndefined()
})

test('shadow: Jev is asked and recorded, Claude gets nothing, and Claude choosing the same tool counts', { options: { mode: 'shadow' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  const sent = await submit($, 'run the tests')
  expect('context' in sent ? sent.context : undefined).toBeUndefined()
  expect(await lines($)).toEqual(['Jev would hint Read 0.90 (shadow)', 'routing in shadow · Claude sees no hints'])
  await $.turn.start({ text: 'run the tests', turnId: 'turn-1' })
  w.responses.push([{ name: 'Read', input: { file_path: 'package.json' } }])
  await step($, 'turn-1', 0)
  w.messages = () => [{ role: 'user', text: 'run the tests', toolUses: [] }]
  const read = await $.tool.call({ tool: 'Read', file_path: 'package.json' })
  expect('context' in read ? read.context : undefined).toBeUndefined()
  await step($, 'turn-1', 1)
  await complete($, w, 'turn-1')
  expect(logged(w)[0]).toMatchObject({ arm: 'shadow', jev: { asked: 2, hinted: 2, followed: 1 } })
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
  expect(await lines($)).toEqual(['Jev not set up · run /jev-setup', 'routing off · no key'])
  const desktop = await band($, 'desktop')
  expect(await desktop.find({ text: /Jev not set up/ })).toBeDefined()
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
  expect(await lines($)).toEqual(['Jev idle', 'routing on'])
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

test("the pane shows the last turn's answers, and pausing stops Jev for this session", HINTS, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  await plainTurn($, w, 'why does the test fail?')
  const pane = await $.ui.mount({ plugin: 'jev', surface: 'terminal', component: 'Pane', requestId: 'jev', props: PANE_PROPS })
  expect(await pane.find({ text: /ready/ })).toBeDefined()
  expect(await pane.find({ text: /Jev hinted/ })).toBeDefined()
  expect(await pane.find({ text: /^Read$/ })).toBeDefined()
  await pane.press({ key: 'pause' })
  await pane.unmount()

  expect(await lines($)).toEqual(['Jev paused', 'routing paused for this session'])
  await plainTurn($, w, 'and now?', 'turn-2')
  expect(w.asks).toHaveLength(1)
  expect(logged(w)[1]).toMatchObject({ arm: 'off' })
})
