import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

// The test runner has timers; the hooks environment's typings do not declare them.
declare function setTimeout(callback: (value?: unknown) => void, ms: number): unknown

const KEY = 'sk-or-v1-test0123456789abcdef0123456789'
const UNCUT = { isStdoutTruncated: false, isStderrTruncated: false }
const HOME = '/home/t'
const GATEWAY = 'http://127.0.0.1:8794'
const JEV_CLAUDE = 'http://127.0.0.1:8789'
const PACKAGE = `${HOME}/.claude/jev-mod/gateway/0.5.0/node_modules/jev-gateway`
const KEY_FILE = `${HOME}/.jev-gateway/.env`
const LOG_DIR = `${HOME}/.claude/jev-mod/log`

type Run = { argv: string[]; env?: Record<string, string>; stdin?: string }

type World = {
  env: Record<string, string | undefined>
  files: Record<string, string>
  runs: Run[]
  /** ANTHROPIC_BASE_URL as each model request went out. */
  sentTo: (string | undefined)[]
  toasts: string[]
  /** What the person picks in the next questions, in order. */
  answers: string[]
  gateway: { at: string; up: boolean; startable: boolean; routing: boolean; startedAt: string; upstream?: string; events: Record<string, unknown>[] }
  routingPosts: string[]
}

type Setup = { installed?: boolean; key?: boolean; env?: Record<string, string>; gatewayAt?: string; up?: boolean; frames?: string[] }

/** The world beneath the plugin: the environment, files, the gateway's launcher and its HTTP API, npm, the clipboard. */
function world(on: On, clock: MockClock, setup: Setup = {}): World {
  const w: World = {
    env: { HOME, ...setup.env },
    files: {},
    runs: [],
    sentTo: [],
    toasts: [],
    answers: [],
    gateway: { at: setup.gatewayAt ?? GATEWAY, up: setup.up ?? false, startable: true, routing: true, startedAt: 'start-0', events: [] },
    routingPosts: [],
  }
  if (setup.installed !== false) w.files[`${PACKAGE}/package.json`] = JSON.stringify({ name: 'jev-gateway', version: '0.5.0' })
  if (setup.key !== false) w.files[KEY_FILE] = `JEV_PROVIDER=openrouter\nOPENROUTER_API_KEY=${KEY}\n`
  let starts = 0

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
    w.runs.push({ argv, ...(e.init?.env ? { env: e.init.env } : {}), ...(e.init?.stdin !== undefined ? { stdin: e.init.stdin } : {}) })
    const out = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, ...UNCUT } })
    if (argv[0] === 'node' && argv[1] === '--version') return out('v22.20.0\n')
    if (argv[0] === 'node' && argv[1] === `${PACKAGE}/bin/jev-claude.mjs`) {
      if (argv[2] === '--stop') {
        w.gateway.up = false
        return out('jev-claude: stopped router (pid 4242).')
      }
      if (!w.gateway.startable) return out('', 1, 'jev-claude: the router did not start. Last log lines: …')
      if (!w.gateway.up) {
        w.gateway.up = true
        w.gateway.startedAt = `start-${++starts}`
        w.gateway.upstream = e.init?.env?.JEV_CLAUDE_UPSTREAM_BASE_URL
      }
      return out(`jev-claude: router up on ${GATEWAY}`)
    }
    if (argv[0] === 'npm') {
      w.files[`${PACKAGE}/package.json`] = JSON.stringify({ name: 'jev-gateway', version: '0.5.0' })
      return out('added 3 packages')
    }
    if (argv[0] === 'node' && argv[1]?.endsWith('/scripts/save-key.mjs')) {
      const input = JSON.parse(e.init?.stdin ?? '{}') as { provider: string; key: string }
      w.files[KEY_FILE] = `JEV_PROVIDER=${input.provider}\nOPENROUTER_API_KEY=${input.key}\n`
      return out(`${JSON.stringify({ ok: true, ms: 280, file: KEY_FILE })}\n`)
    }
    if (argv[0] === 'pbpaste') return out(`${KEY}\n`)
    if (argv[0] === 'pbcopy') return out('')
    return { deny: `spawn ${argv[0]} ENOENT` }
  })

  on('http.fetch', (_$, e) => {
    const g = w.gateway
    if (!e.url.startsWith(g.at) || !g.up) return { deny: 'connect ECONNREFUSED' }
    const url = new URL(e.url)
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (url.pathname === '/health') return json({ status: 'ok', pid: 4242, upstream: g.upstream, jev: 'openrouter' })
    if (url.pathname === '/dashboard/routing') {
      w.routingPosts.push(e.url)
      g.routing = url.searchParams.get('enabled') === 'true'
      return json({ routing: g.routing })
    }
    if (url.pathname === '/dashboard/events') {
      const since = Number(url.searchParams.get('since'))
      const events = g.events.filter(ev => (ev.seq as number) > since)
      return json({ router: { routing: g.routing, minConfidence: 0.7, recorded: g.events.length, startedAt: g.startedAt }, events })
    }
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.blit', (_$, e) => {
    if ('cells' in e && e.key === 'jev-scene') setup.frames?.push(e.cells)
    return { value: {} }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const { questions } = e as unknown as { questions: { question: string }[] }
    return { result: { questions, answers: { [questions[0]!.question]: w.answers.shift() ?? 'Cancel' } } } as never
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    w.sentTo.push(w.env.ANTHROPIC_BASE_URL)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return w
}

async function start($: Engine, cwd = '/Users/me/repo/demo-app') {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
}

async function step($: Engine, turnId: string, index: number, agentId?: string) {
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 2 + index, ...(agentId ? { agentId } : {}) })
  for await (const _chunk of stream) {
    // drain
  }
}

const USAGE = { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }

async function complete($: Engine, w: World, clock: MockClock, turnId: string) {
  const before = logged(w).length
  await $.turn.complete({ answer: 'Found it.', durationMs: 4_000, isAborted: false, turnId, reason: 'answer', usage: USAGE })
  await clock.advance(300) // the last look at the gateway, a moment after the turn
  await settle(() => logged(w).length > before)
}

/** One whole turn: its start, `requests` model requests, its end, and its log line. */
async function turn($: Engine, w: World, clock: MockClock, text: string, requests: number, turnId = 'turn-1') {
  await $.turn.start({ text, turnId })
  for (let index = 0; index < requests; index++) await step($, turnId, index)
  await complete($, w, clock, turnId)
}

async function settle(until: () => boolean) {
  for (let i = 0; i < 200 && !until(); i++) await new Promise(resolve => setTimeout(resolve, 5))
}

function logged(w: World) {
  const text = Object.entries(w.files).find(([path]) => path.startsWith(LOG_DIR))?.[1] ?? ''
  return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.type === 'turn')
}

/** A command the person typed. */
async function command($: Engine, name: string) {
  return $.command.run({ command: name, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
}

const launches = (w: World) => w.runs.filter(r => r.argv[1] === `${PACKAGE}/bin/jev-claude.mjs`).map(r => r.argv[2])

const PANE_PROPS = { title: 'Jev', isFocused: false, bodyColumns: 90, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }

async function band($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({ plugin: 'jev', surface, component: 'AbovePrompt', props: BAND_PROPS })
}

test('starts the gateway at session start and routes the session through it from the first request', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)

  expect(launches(w)).toEqual(['--start'])
  expect(w.runs.find(r => r.argv[2] === '--start')!.env).toEqual({ JEV_CLAUDE_PORT: '8794', JEV_CLAUDE_UPSTREAM_BASE_URL: 'https://api.anthropic.com/v1' })
  const idle = await band($)
  expect(await idle.find({ type: 'Raster' })).toBeDefined()
  expect(await idle.find({ text: /Jev waiting · routing tools/ })).toBeDefined()
  await idle.unmount()

  await turn($, w, clock, 'why does the test fail?', 2)
  expect(w.sentTo).toEqual([GATEWAY, GATEWAY])
  const [record] = logged(w)
  expect(record.route).toBe('gateway')
  expect(record.prompt).toBe('why does the test fail?')

  const out = await command($, 'jev-report')
  expect(out.text).toContain('Jev report, last 7 days: 1 turns · 1 through the gateway.')
})

test('a gateway that stops answering: requests go direct before they leave, and the next turn restarts it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock, { env: { ANTHROPIC_BASE_URL: 'https://llm-proxy.example.com' } })
  await start($)
  expect(w.gateway.upstream).toBe('https://llm-proxy.example.com/v1')
  await turn($, w, clock, 'one', 1, 'turn-1')

  w.gateway.up = false
  w.gateway.startable = false
  await clock.advance(1_001)
  await turn($, w, clock, 'two', 2, 'turn-2')
  // straight back to the address the session started with, not a failed request
  expect(w.sentTo).toEqual([GATEWAY, 'https://llm-proxy.example.com', 'https://llm-proxy.example.com'])
  expect(w.toasts.filter(t => /stopped answering/.test(t))).toHaveLength(1)
  expect(logged(w)[1]).toMatchObject({ route: 'down', fallbacks: 2 })
  const down = await band($)
  expect(await down.find({ text: /gateway down · direct/ })).toBeDefined()
  await down.unmount()

  // the next turn tries a restart; while it fails, requests keep going direct, with no new alarm
  await clock.advance(1_001)
  await turn($, w, clock, 'three', 1, 'turn-3')
  expect(launches(w)).toEqual(['--start', '--start'])
  expect(w.sentTo.at(-1)).toBe('https://llm-proxy.example.com')
  expect(w.toasts.filter(t => /stopped answering/.test(t))).toHaveLength(1)

  // once a restart works, requests go through the gateway again
  w.gateway.startable = true
  await clock.advance(1_001)
  await $.turn.start({ text: 'four', turnId: 'turn-4' })
  await settle(() => w.gateway.up)
  await clock.settle()
  await step($, 'turn-4', 0)
  expect(launches(w)).toEqual(['--start', '--start', '--start'])
  expect(w.sentTo.at(-1)).toBe(GATEWAY)
  await complete($, w, clock, 'turn-4')
  expect(logged(w)[3].route).toBe('gateway')
})

test('the watchdog lets go of a gateway that dies between turns', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  await turn($, w, clock, 'one', 1)
  expect(w.env.ANTHROPIC_BASE_URL).toBe(GATEWAY)
  w.gateway.up = false
  await clock.advance(5_000)
  await settle(() => w.env.ANTHROPIC_BASE_URL === undefined)
  expect(w.env.ANTHROPIC_BASE_URL).toBeUndefined()
})

test('subagent requests are guarded too, and counted in the turn of the main loop', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  await $.turn.start({ text: 'explore the repo', turnId: 'turn-1' })
  await step($, 'turn-1', 0)
  w.gateway.up = false
  await clock.advance(1_001)
  await step($, 'agent-turn', 0, 'agent-1')
  expect(w.sentTo).toEqual([GATEWAY, undefined])
})

test('an excluded repo never goes through the gateway, and its words stay out of the log', { options: { excludedRepos: 'demo-app' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text as never, null, 'the engine band') as never
  })
  await start($)
  expect(launches(w)).toEqual([])
  await turn($, w, clock, 'the client secret plan', 1)
  expect(w.sentTo).toEqual([undefined])
  expect(logged(w)[0]).toMatchObject({ route: 'excluded', prompt: '' })
  const quiet = await band($)
  expect(await quiet.find({ text: /Jev/ })).toBeUndefined()
  expect(await quiet.find({ text: /the engine band/ })).toBeDefined()
  await quiet.unmount()
})

test('a session started through jev-claude in an excluded repo goes direct', { options: { excludedRepos: 'demo-app' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock, { env: { ANTHROPIC_BASE_URL: JEV_CLAUDE }, gatewayAt: JEV_CLAUDE, up: true })
  await start($)
  await turn($, w, clock, 'hello', 1)
  expect(w.sentTo).toEqual([undefined])
})

test('off in /config: nothing starts and the session goes as it started', { options: { gateway: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  expect(launches(w)).toEqual([])
  await $.turn.start({ text: 'hello', turnId: 'turn-1' })
  await step($, 'turn-1', 0)
  await $.turn.complete({ answer: 'Hi.', durationMs: 1_000, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  await clock.advance(300)
  expect(w.sentTo).toEqual([undefined])
  expect(logged(w)).toEqual([])
})

test('a session started through jev-claude: the mod watches that gateway and runs none', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock, { env: { ANTHROPIC_BASE_URL: JEV_CLAUDE }, gatewayAt: JEV_CLAUDE, up: true })
  await start($)
  await turn($, w, clock, 'one', 1, 'turn-1')
  w.gateway.up = false
  await clock.advance(1_001)
  await turn($, w, clock, 'two', 1, 'turn-2')
  expect(w.sentTo).toEqual([JEV_CLAUDE, undefined])
  expect(launches(w)).toEqual([])

  w.gateway.up = true
  await clock.advance(1_001)
  await turn($, w, clock, 'three', 1, 'turn-3')
  expect(w.sentTo.at(-1)).toBe(JEV_CLAUDE)
  expect(launches(w)).toEqual([])
})

test('not set up: the band says what to do and nothing is routed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock, { installed: false })
  await start($)
  expect(launches(w)).toEqual([])
  for (const surface of ['terminal', 'desktop'] as const) {
    const b = await band($, surface)
    expect(await b.find({ text: /Jev not set up · run \/jev-setup to install it/ })).toBeDefined()
    await b.unmount()
  }
  await turn($, w, clock, 'hello', 1)
  expect(w.sentTo).toEqual([undefined])
})

test('no key: the band asks for one', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock, { key: false })
  await start($)
  expect(launches(w)).toEqual([])
  const b = await band($)
  expect(await b.find({ text: /add a key for Jev/ })).toBeDefined()
  await b.unmount()
})

test('/jev-setup installs the pinned gateway after asking, saves the key without it ever reaching argv, and starts routing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock, { installed: false, key: false })
  await start($)
  w.answers.push('Install', 'OpenRouter', 'Read the clipboard')
  const out = await command($, 'jev-setup')

  expect(out.text).toContain('Installed jev-gateway 0.5.0')
  expect(out.text).toContain('Key checked (Jev answered in 280ms)')
  expect(out.text).toContain(`jev-gateway is running on ${GATEWAY}`)
  const npm = w.runs.find(r => r.argv[0] === 'npm')!
  expect(npm.argv).toContain('jev-gateway@0.5.0')
  expect(npm.argv).toContain(`${HOME}/.claude/jev-mod/gateway/0.5.0`)
  const save = w.runs.find(r => r.argv[1]?.endsWith('/scripts/save-key.mjs'))!
  expect(JSON.parse(save.stdin!)).toMatchObject({ provider: 'openrouter', key: KEY, root: PACKAGE })
  expect(w.runs.some(r => r.argv.join(' ').includes(KEY))).toBe(false)
  expect(out.text).not.toContain(KEY)
  expect(w.runs.some(r => r.argv[0] === 'pbcopy')).toBe(true)

  await turn($, w, clock, 'hello', 1)
  expect(w.sentTo).toEqual([GATEWAY])
})

test('/jev-setup stops at a cancelled install and changes nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock, { installed: false, key: false })
  await start($)
  w.answers.push('Cancel')
  const out = await command($, 'jev-setup')
  expect(out.text).toContain('nothing was installed')
  expect(w.runs.some(r => r.argv[0] === 'npm')).toBe(false)
})

test('the band and the log show what Jev decided; the pane switches Jev routing and pauses this session', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)

  await $.turn.start({ text: 'why does the test fail?', turnId: 'turn-1' })
  w.gateway.events.push({ seq: 1, mode: 'hint', tool: 'Bash', confidence: 0.82, usage: { input: 10, output: 40, cached: 900, cacheWrite: 0, reasoning: 0 }, jev: { choice: 'Bash', confidence: 0.82, latencyMs: 240 } })
  await step($, 'turn-1', 0)
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const b = await band($, surface)
    expect(await b.find({ text: /Jev picked Bash 0\.82 \(hint\)/ })).toBeDefined()
    await b.unmount()
  }

  w.gateway.events.push({ seq: 2, mode: 'passthrough', reason: 'low_confidence', usage: { input: 10, output: 60, cached: 900, cacheWrite: 0, reasoning: 0 } })
  await step($, 'turn-1', 1)
  await clock.settle()
  const passed = await band($)
  expect(await passed.find({ text: /Jev left it to Claude · Jev was unsure/ })).toBeDefined()
  await passed.unmount()

  await complete($, w, clock, 'turn-1')
  const [record] = logged(w)
  expect(record.gateway.requests).toBe(2)
  expect(record.gateway.modes).toEqual({ hint: 1, passthrough: 1 })
  expect(record.gateway.picks[0].tool).toBe('Bash')
  const after = await band($)
  expect(await after.find({ text: /Jev waiting/ })).toBeDefined()
  await after.unmount()

  const pane = await $.ui.mount({ plugin: 'jev', surface: 'terminal', component: 'Pane', requestId: 'jev', props: PANE_PROPS })
  expect(await pane.find({ text: /^running$/ })).toBeDefined()
  expect(await pane.find({ text: /Bash/ })).toBeDefined()
  await pane.press({ key: 'routing' })
  expect(w.routingPosts).toEqual([`${GATEWAY}/dashboard/routing?enabled=false`])
  await pane.press({ key: 'route' })
  expect(w.env.ANTHROPIC_BASE_URL).toBeUndefined()
  await pane.unmount()

  await turn($, w, clock, 'paused now', 1, 'turn-2')
  expect(w.sentTo.at(-1)).toBeUndefined()
})

test('a reload mid-turn does not leave the band stuck', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  world(on, clock)
  await start($)
  await $.turn.start({ text: 'build it', turnId: 'turn-1' })
  await step($, 'turn-1', 0)
  await start($) // what a hot reload fires: the turn in flight is gone with the old module
  const b = await band($)
  expect(await b.find({ text: /Jev deciding/ })).toBeUndefined()
  expect(await b.find({ text: /Jev waiting/ })).toBeDefined()
  await b.unmount()
})

test('the scene moves while a turn runs and holds still after it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const frames: string[] = []
  const w = world(on, clock, { frames })
  await start($)
  await $.turn.start({ text: 'redesign the router', turnId: 'turn-1' })
  await step($, 'turn-1', 0)

  const b = await $.ui.mount({ plugin: 'jev', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
  for (let i = 0; i < 4; i++) await clock.advance(180)
  expect(frames.length).toBeGreaterThan(2)
  expect(new Set(frames).size).toBeGreaterThan(1)

  await complete($, w, clock, 'turn-1')
  const count = frames.length
  await clock.advance(720)
  expect(frames.length).toBe(count)
  await b.unmount()
})

test('the pane shows the last turn and the switches on terminal and desktop', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on, clock)
  await start($)
  await turn($, w, clock, 'is it in prod?', 1)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'jev', surface, component: 'Pane', requestId: 'jev', props: PANE_PROPS })
    expect(await pane.find({ text: /is it in prod\?/ })).toBeDefined()
    expect(await pane.find({ text: /through the gateway/ })).toBeDefined()
    expect(await pane.find({ text: /can only send hints/ })).toBeDefined()
    for (const key of ['route', 'routing', 'restart', 'report']) expect(await pane.find({ key })).toBeDefined()
    expect(await pane.find({ key: 'setup' })).toBeUndefined()
    await pane.unmount()
  }
})
