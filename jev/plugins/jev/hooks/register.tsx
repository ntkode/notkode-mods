import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { JevArm, JevReadiness, JevSessionView, JevTurnView } from '../types'

import {
  JEV_TIMEOUT_MS,
  MAX_TOOLS,
  OLD_GATEWAY_PORT,
  PROVIDERS,
  buildState,
  cardFor,
  cleanPrompt,
  DONE_NUDGE,
  DONE_QUESTIONS,
  decide,
  doneText,
  doneVerdict,
  decisionText,
  dollars,
  jevCost,
  duration,
  emptyJevTurn,
  folderName,
  hintText,
  isExcluded,
  isGatewayOn,
  isValidKey,
  jevAccess,
  latency,
  localGatewayOrigin,
  median,
  normalizeAnswers,
  parseEnvFile,
  parseLog,
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
  turnsFrom,
  upsertEnv,
} from './logic'
import type { Answer, Arm, Decision, DoneCheck, Spend, JevAccess, JevState, JevTurn, LogRecord, MessageRow, Provider, Question, Tool, TurnRecord } from './logic'
import { ANIMATED, ANSWER_FRAMES, SCENE_ROWS, STILL, rasterCells, scenePixels } from './sprites'
import type { Card, Scene, SceneState } from './sprites'

type $ = EngineInterface

const PANE = 'jev'
const EMPTY_SESSION: JevSessionView = { turns: 0, hintTurns: 0, controlTurns: 0, requests: 0, asked: 0, hinted: 0, followed: 0, output: 0, jevMs: [], jevUsd: 0, jevUnpriced: 0 }
const status = atom({ plugin: 'jev', key: 'status' } as const, { state: 'off', mode: 'on' })
const lastView = atom({ plugin: 'jev', key: 'last' } as const, null)
const sessionView = atom({ plugin: 'jev', key: 'session' } as const, EMPTY_SESSION)
const phase = atom({ plugin: 'jev', key: 'phase' } as const, null)
const decision = atom({ plugin: 'jev', key: 'decision' } as const, null)
const original = atom({ plugin: 'jev', key: 'original' } as const, { saved: false, value: null })
const weekView = atom({ plugin: 'jev', key: 'week' } as const, null)
/** The window the pane's summary covers. */
const WEEK_DAYS = 7

const FRAME_MS = 180
/** How long a tool call waits for its response to end, to learn whether it is the response's last. */
const STEP_WAIT_MS = 10_000
/** jev-gateway's key file: the mod reads and writes the same one, so a key set in either works in both. */
const KEY_FILE = '.jev-gateway/.env'
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529])

/** One response of Claude's model, while its tool calls run. */
type Step = {
  /** Resolves with how many tools the response called once it is whole; -1 when it never was. */
  done: Promise<number>
  /** Tool calls of this response that have finished. */
  finished: number
  /** Their results as Claude reads them, before the conversation stores them. */
  results: Record<string, string>
}

/** A turn of the main loop, from its start to its end. */
type Turn = {
  prompt: string
  arm: Arm | 'excluded' | 'off'
  steps: number
  tools: number
  jev: JevTurn
  /** The tool Jev pointed at for the next request (hinted, or would have in shadow). */
  pending?: string
  step?: Step
  /** The session's cost and weekly quota when the turn started. */
  before?: Usage
  /** The done check at the turn's last stop, while it runs and once it is in. */
  done?: Promise<DoneCheck | undefined>
}

/** The session's cost so far (US dollars, API prices) and the weekly quota used (percent). */
type Usage = { usd?: number; week?: number; weekResetsAt?: string }

async function usageNow($: $): Promise<Usage> {
  try {
    const u = await $.session.usage()
    const week = u.rateLimits.find(r => r.kind === 'seven_day')
    return { ...(u.cost ? { usd: u.cost.usd } : {}), ...(week ? { week: week.percentUsed, ...(week.resetsAt ? { weekResetsAt: week.resetsAt } : {}) } : {}) }
  } catch {
    return {}
  }
}

// The options, read at each load.
let mode: 'on' | 'shadow' | 'off' = 'on'
let controlPercent = 20
let doneMode: 'shadow' | 'on' | 'off' = 'shadow'
let excludedRepos = ''

// The session's facts, worked out at session.start (which a reload fires again).
let home = ''
let sessionId = ''
let project = ''
let logPath = ''
let excluded = false
let access: JevAccess | undefined

const turns = new Map<string, Turn>()
let current: string | undefined
/** What prompt.submit settled for the turn about to start: its arm, and Jev's first answer. */
let opening: { arm: Turn['arm']; jev: JevTurn; pending?: string } | undefined
let writing: Promise<void> = Promise.resolve()

// The animation: when the last tool call started (for the spark), the band's site, the timer.
let lastToolAt = 0
let bandSite: string | undefined
/** The scene the band's lines were last drawn for: the clock moves the scene on without a state change. */
let drawnScene: Scene | undefined
let ticker: { cancel: () => void } | undefined

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function within<T>($: $, p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, $.clock.sleep(ms).then(() => undefined, () => undefined)])
}

/** A number in [0, 1) for the control group's draw. */
function roll(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32
}

// ------------------------------------------------------------ the key and the session

/** The key file and the environment, by jev-gateway's rule (the environment wins). */
async function loadAccess($: $): Promise<JevAccess | undefined> {
  let file: Record<string, string> = {}
  try {
    file = parseEnvFile(await $.fs.read(`${home}/${KEY_FILE}`))
  } catch {
    // no key file yet
  }
  return jevAccess(file, {
    JEV_PROVIDER: await $.env.get('JEV_PROVIDER'),
    JEV_MODEL: await $.env.get('JEV_MODEL'),
    JEV_URL: await $.env.get('JEV_URL'),
    TYPESAFE_BASE_URL: await $.env.get('TYPESAFE_BASE_URL'),
    TYPESAFE_API_KEY: await $.env.get('TYPESAFE_API_KEY'),
    OPENROUTER_API_KEY: await $.env.get('OPENROUTER_API_KEY'),
    AI_GATEWAY_API_KEY: await $.env.get('AI_GATEWAY_API_KEY'),
    OPENCODE_API_KEY: await $.env.get('OPENCODE_API_KEY'),
  })
}

/**
 * Versions up to 0.4 sent the session through a gateway on port 8794. A session reloaded into this
 * version may still point there: send it back where it went before, or the next request fails.
 */
async function undoGatewayRouting($: $): Promise<void> {
  if (!isGatewayOn(await $.env.get('ANTHROPIC_BASE_URL'), OLD_GATEWAY_PORT)) return
  const saved = await read($, original)
  const before = saved.saved && !isGatewayOn(saved.value, OLD_GATEWAY_PORT) ? (saved.value ?? undefined) : undefined
  await $.env.set('ANTHROPIC_BASE_URL', before)
}

/** Works out whether Jev can be asked here, from the options, the folder and the key. */
async function configure($: $, cwd: string): Promise<void> {
  excluded = isExcluded(cwd, excludedRepos)
  access = mode === 'off' || excluded ? undefined : await loadAccess($)
  const gateway = localGatewayOrigin(await $.env.get('ANTHROPIC_BASE_URL'))
  const state: JevReadiness = mode === 'off' ? 'off' : excluded ? 'excluded' : access ? 'ready' : 'no_key'
  await update($, status, before => ({
    state,
    mode,
    ...(access ? { provider: PROVIDERS[access.provider].label } : {}),
    ...(gateway ? { gateway } : {}),
    ...(before.paused ? { paused: true } : {}),
    doneCheck: doneMode,
  }))
}

/** Turns are followed (logged, counted) when Jev could be asked, and in excluded repos for the record. */
function tracked(): boolean {
  return mode !== 'off' && (excluded || access !== undefined)
}

/** How the next turn is run: excluded, paused (off), or drawn between hints and control (or shadow). */
function armFor(paused: boolean): Turn['arm'] {
  if (excluded) return 'excluded'
  if (paused || !access) return 'off'
  return pickArm(mode === 'shadow' ? 'shadow' : 'on', controlPercent, roll())
}

// ------------------------------------------------------------ asking Jev

/** One call to Jev, retried once on a busy or failing server; throws with the status on a refusal. */
async function askJev($: $, a: JevAccess, state: JevState, questions: Record<string, Question>, spend?: Spend): Promise<Record<string, Answer>> {
  const init = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${a.key}`,
      'content-type': 'application/json',
      // OpenRouter attributes traffic by these; the others ignore them.
      'http-referer': 'https://github.com/ntkode/notkode-mods',
      'x-title': 'jev for Claude Code',
    },
    body: JSON.stringify({ model: a.model, state, questions }),
  }
  for (let attempt = 0; ; attempt++) {
    const res = await $.http.fetch(a.url, init)
    if (res.ok) {
      const body = JSON.parse(res.text) as { answers?: unknown; usage?: { cost?: unknown } }
      if (spend) {
        spend.calls++
        // OpenRouter prices each call; the other providers report tokens only.
        if (typeof body.usage?.cost === 'number') {
          spend.priced++
          spend.usd = (spend.usd ?? 0) + body.usage.cost
        }
      }
      return normalizeAnswers(body.answers)
    }
    if (attempt > 0 || !RETRYABLE.has(res.status)) throw Object.assign(new Error(`HTTP ${res.status} from ${PROVIDERS[a.provider].label}`), { status: res.status })
    await $.clock.sleep(100)
  }
}

/** What Jev makes of Claude's next request: the tools, the conversation, then jev-gateway's rule. */
async function nextDecision($: $, rows: readonly MessageRow[], results: Readonly<Record<string, string>>, spend: Spend): Promise<Decision> {
  const a = access
  if (!a) return { mode: 'pass', reason: 'jev_error: no key' }
  const tools: Tool[] = (await $.tool.list()).map(t => ({ name: t.name, description: t.description }))
  const conversation = turnsFrom(rows, results)
  const skip = skipReason(tools, conversation)
  if (skip) return { mode: 'pass', reason: skip }
  const state = buildState(conversation)
  let offered = tools
  if (tools.length > MAX_TOOLS) {
    const { questions, shards } = shortlistQuestions(tools)
    offered = shortlisted(shards, await askJev($, a, state, questions, spend))
    if (offered.length === 0) return { mode: 'pass', reason: 'jev_unexpected_answer' }
  }
  return decide(offered, await askJev($, a, state, toolQuestions(offered), spend))
}

/** The main conversation as Jev reads it. */
async function conversationRows($: $): Promise<MessageRow[]> {
  return (await $.session.messages()).map(m => ({
    role: m.role,
    text: m.text,
    toolUses: m.toolUses.map(u => ({ tool_use_id: u.tool_use_id, tool: u.tool, input: u.input, ...(u.text !== undefined ? { text: u.text } : {}) })),
  }))
}

/**
 * Asks Jev about Claude's next request while the band shows it, and counts the answer in `jev`.
 * Never throws: Jev failing or running out of time is a pass, and the request goes on without a hint.
 */
async function consult($: $, jev: JevTurn, arm: JevArm, rows: readonly MessageRow[], results: Readonly<Record<string, string>> = {}): Promise<Decision> {
  const started = await $.clock.now()
  await update($, phase, () => ({ name: 'asking', at: started, arm }))
  animate($)
  const spend: Spend = { calls: 0, priced: 0 }
  const work = nextDecision($, rows, results, spend).catch((error): Decision => ({ mode: 'pass', reason: `jev_error: ${message(error)}` }))
  const d: Decision = (await within($, work, JEV_TIMEOUT_MS)) ?? { mode: 'pass', reason: 'jev_timeout' }
  const at = await $.clock.now()
  tally(jev, d, at - started, spend)
  await update($, decision, () => ({
    mode: d.mode,
    at,
    ...(d.tool ? { tool: d.tool } : {}),
    ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
    ...(d.reason ? { reason: d.reason } : {}),
    ...(arm === 'shadow' ? { shadow: true } : {}),
  }))
  return d
}

// ------------------------------------------------------------ the done check

type StopEvent = { stop_hook_active: boolean; last_assistant_message?: string; background_tasks?: readonly { status: string }[]; session_crons?: readonly unknown[] }

/**
 * At Claude's stop: is it a broken promise? Background work or a scheduled wake-up keeps the
 * promise, so Jev is asked only when nothing is pending. Never throws: a failed check lets the stop through.
 */
async function checkStop($: $, e: StopEvent): Promise<DoneCheck> {
  const pending = (e.background_tasks ?? []).filter(t => t.status === 'running' || t.status === 'pending').length + (e.session_crons?.length ?? 0)
  if (pending > 0) return { verdict: 'running', pushed: false }
  const a = access
  if (!a) return { verdict: 'error', pushed: false, reason: 'jev_error: no key' }
  const started = await $.clock.now()
  const spend: Spend = { calls: 0, priced: 0 }
  try {
    const rows = await conversationRows($)
    const last = e.last_assistant_message?.trim()
    // The stop's own message may not be stored yet.
    if (last && rows.at(-1)?.text.trim() !== last) rows.push({ role: 'assistant', text: last, toolUses: [] })
    const work = askJev($, a, buildState(turnsFrom(rows)), DONE_QUESTIONS, spend)
    const answers = await within($, work, JEV_TIMEOUT_MS)
    const ms = (await $.clock.now()) - started
    if (!answers) return { verdict: 'error', pushed: false, reason: 'jev_timeout', ms }
    const v = doneVerdict(answers)
    return { ...v, pushed: v.verdict === 'push' && doneMode === 'on', ms, ...(spend.usd !== undefined ? { usd: spend.usd } : {}) }
  } catch (error) {
    return { verdict: 'error', pushed: false, reason: `jev_error: ${message(error)}` }
  }
}

// ------------------------------------------------------------ the band above the prompt

/**
 * What the band shows now, from the mod's state and the clock: the same answer for a redraw and
 * for the animation. Jev's answer runs back to Claude as soon as it lands, then Claude's own
 * phase (thinking, working) shows, with a hint it carries resting beside it.
 */
async function sceneOf($: $): Promise<SceneState> {
  const s = await read($, status)
  if (s.state !== 'ready') return { ...STILL, scene: 'unset' }
  const step = await read($, phase)
  if (!step) return { ...STILL, scene: 'idle', asleep: s.paused === true }
  const now = await $.clock.now()
  const since = (at: number) => Math.max(0, Math.floor((now - at) / FRAME_MS))
  const asleep = step.arm === 'control' || step.arm === 'off'
  const shadow = step.arm === 'shadow'
  const d = await read($, decision)
  const card: Card = d ? cardFor(d) : 'none'
  const answered = d !== null && d.at >= step.at
  if (step.name === 'asking' && !answered) return { ...STILL, scene: 'asking', frame: since(step.at), asleep, shadow }
  if (d && since(d.at) < ANSWER_FRAMES) return { ...STILL, scene: 'answering', frame: since(d.at), card, asleep, shadow }
  // Answered and landed: Claude's request goes out next.
  const scene: Scene = step.name === 'working' ? 'working' : 'thinking'
  return { scene, frame: since(step.at), card, spark: now - lastToolAt < 2 * FRAME_MS, asleep, shadow }
}

/** Repaints the scene's cells a few times a second while the turn moves; no redraw. */
function animate($: $): void {
  if (ticker) return
  ticker = $.clock.every(FRAME_MS, async () => {
    if (!bandSite) return
    const now = await sceneOf($)
    if (now.scene !== drawnScene) {
      // a card landed, Claude took over: the lines beside the scene change too
      drawnScene = now.scene
      $.ui.invalidate('ui.render')
      return
    }
    if (!ANIMATED.has(now.scene)) return
    const art = rasterCells(scenePixels(now))
    await $.ui.blit({ requestId: bandSite, key: 'jev-scene', cells: art.cells }).catch(() => undefined)
  })
}

function stopAnimation(): void {
  ticker?.cancel()
  ticker = undefined
}

/** Moves the turn to its next phase, which redraws the band and keeps the animation running. */
async function enter($: $, name: 'thinking' | 'working' | null, arm: JevArm = 'hint', tool?: string): Promise<void> {
  const at = await $.clock.now()
  await update($, phase, () => (name ? { name, at, arm, ...(tool ? { tool } : {}) } : null))
  if (name) animate($)
  else stopAnimation()
}

/** The standing setting, under the band's status line. */
function routingText(s: { mode: string; paused?: boolean }, arm?: JevArm): string {
  if (s.paused) return 'routing paused for this session'
  if (s.mode === 'shadow') return 'routing in shadow · Claude sees no hints'
  if (arm === 'control') return 'routing on · control turn, no hints'
  return 'routing on'
}

/** Line 1 of the band, and the pane's "now": what is happening this moment. */
function nowLine($: $, e: Parameters<$['ui']['resolve']>[0], scene: Scene, d: { mode: 'hint' | 'pass'; reason?: string; tool?: string; confidence?: number } | null, shadow: boolean, tool?: string, paused?: boolean): RenderElement {
  const { Text } = $.ui.resolve(e)
  switch (scene) {
    case 'unset':
      return <Text dimColor>Jev not set up · run /jev-setup</Text>
    case 'idle':
      return <Text dimColor>{paused ? 'Jev paused' : 'Jev idle'}</Text>
    case 'asking':
      return <Text color="yellow">Jev deciding…</Text>
    case 'answering': {
      if (!d) return <Text color="yellow">Jev deciding…</Text>
      const card = cardFor(d)
      return (
        <Text color={card === 'pick' ? 'cyan' : card === 'fail' ? 'red' : undefined} dimColor={card === 'pass'}>
          {decisionText(d, shadow)}
        </Text>
      )
    }
    case 'thinking':
      return <Text>Claude thinking…</Text>
    case 'working':
      return <Text>Claude working{tool ? ` · ${tool}` : ''}</Text>
  }
}

async function drawBand($: $, e: Parameters<$['ui']['resolve']>[0] & { requestId?: string; props: { hasSurvey: boolean; maxRows: number } }, next: () => RenderElement | Promise<RenderElement>): Promise<RenderElement> {
  const s = await read($, status)
  if (e.props.hasSurvey || s.state === 'off' || s.state === 'excluded') return next()
  const now = await sceneOf($)
  drawnScene = now.scene
  const step = await read($, phase)
  const d = await read($, decision)
  const { Box, Text } = $.ui.resolve(e)
  const status1 = nowLine($, e, now.scene, d, now.shadow, step?.tool, s.paused)
  const status2 = s.state === 'ready' ? routingText(s, step?.arm) : 'routing off · no key'

  // The scene, with an empty line above it to set it apart from the transcript; the setting under the status.
  if (e.surface === 'terminal' && e.props.maxRows >= SCENE_ROWS + 1) {
    const { Raster } = $.ui.resolve(e)
    bandSite = e.requestId
    const art = rasterCells(scenePixels(now))
    return (
      <Box flexDirection="row" marginTop={1}>
        <Raster key="jev-scene" columns={art.columns} rows={art.rows} cells={art.cells} />
        <Box marginLeft={2} flexDirection="column">
          {status1}
          <Text dimColor>{status2}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box>
      <Text color={ANIMATED.has(now.scene) ? 'yellow' : 'cyan'}>◆ </Text>
      {status1}
      <Text dimColor> · {status2}</Text>
    </Box>
  )
}

// ------------------------------------------------------------ the log

function log($: $, record: LogRecord): Promise<void> {
  if (!logPath) return Promise.resolve()
  writing = writing
    .then(async () => {
      let text = ''
      try {
        text = await $.fs.read(logPath)
      } catch {
        // first line of this session's log
      }
      await $.fs.write(logPath, text + JSON.stringify(record) + '\n')
    })
    .catch(error => $.ui.log(`jev: could not write the log: ${String(error)}`, { to: 'debug' }))
  return writing
}

async function readLogs($: $, days: number): Promise<LogRecord[]> {
  const dir = `${home}/.claude/jev-mod/log`
  const since = (await $.clock.now()) - days * 86_400_000
  const out: LogRecord[] = []
  let entries: Awaited<ReturnType<$['fs']['list']>> = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.name.endsWith('.jsonl') || entry.mtimeMs < since) continue
    try {
      out.push(...parseLog(await $.fs.read(`${dir}/${entry.name}`)).filter(r => r.at >= since))
    } catch {
      // a file being written; the next report reads it
    }
  }
  return out
}

// ------------------------------------------------------------ after a turn

type TurnEnd = {
  durationMs: number
  reason: string
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
}

async function finish($: $, turnId: string, turn: Turn, e: TurnEnd): Promise<void> {
  const done = turn.done ? await within($, turn.done, JEV_TIMEOUT_MS + 1000) : undefined
  const after = await usageNow($)
  const before = turn.before ?? {}
  const delta = (a?: number, b?: number) => (a !== undefined && b !== undefined ? Math.max(0, Math.round((a - b) * 1e6) / 1e6) : undefined)
  const usd = delta(after.usd, before.usd)
  const weekPct = delta(after.week, before.week)
  const record: TurnRecord = {
    type: 'turn',
    v: 4,
    at: await $.clock.now(),
    session: sessionId,
    project,
    turnId,
    // An excluded repo's words stay out of the log too.
    prompt: excluded ? '' : turn.prompt.slice(0, 500),
    arm: turn.arm,
    actual: {
      steps: turn.steps,
      durationMs: e.durationMs,
      reason: e.reason,
      tools: turn.tools,
      ...(e.usage
        ? { usage: { input: e.usage.input_tokens, output: e.usage.output_tokens, cacheRead: e.usage.cache_read_input_tokens, cacheWrite: e.usage.cache_creation_input_tokens } }
        : {}),
      ...(usd !== undefined ? { usd } : {}),
      ...(weekPct !== undefined ? { weekPct } : {}),
      ...(after.week !== undefined ? { weekUsed: after.week } : {}),
    },
    ...(turn.jev.asked > 0 ? { jev: turn.jev } : {}),
    ...(done ? { done } : {}),
  }
  await log($, record)
  await publish($, record)
  await refreshWeek($)
}

/** The last days from the log, for the pane: what Jev answered, hints vs control, spend, savings. */
async function refreshWeek($: $): Promise<void> {
  const lines = report(await readLogs($, WEEK_DAYS), WEEK_DAYS).split('\n')
  await update($, weekView, () => lines)
}

/** Feeds the pane (the turn just logged, the session's totals) and returns the band to rest. */
async function publish($: $, record: TurnRecord): Promise<void> {
  const j = record.jev
  const view: JevTurnView = {
    prompt: record.prompt.slice(0, 160),
    arm: record.arm,
    steps: record.actual.steps,
    durationMs: record.actual.durationMs,
    ...(record.actual.usage ? { output: record.actual.usage.output } : {}),
    ...(j
      ? {
          jev: {
            asked: j.asked,
            hinted: j.hinted,
            followed: j.followed,
            picks: j.picks.map(p => p.tool),
            reasons: j.reasons,
            ...(j.ms.length > 0 ? { ms: median(j.ms) } : {}),
            cards: j.cards,
          },
        }
      : {}),
    ...(record.done ? { done: { verdict: record.done.verdict, pushed: record.done.pushed } } : {}),
  }
  const hinting = record.arm === 'hint'
  await update($, lastView, () => view)
  await update($, sessionView, before => {
    const s = { ...EMPTY_SESSION, ...before }
    return {
      turns: s.turns + 1,
      hintTurns: s.hintTurns + (hinting ? 1 : 0),
      controlTurns: s.controlTurns + (record.arm === 'control' ? 1 : 0),
      requests: s.requests + record.actual.steps,
      asked: s.asked + (j?.asked ?? 0),
      hinted: s.hinted + (hinting ? (j?.hinted ?? 0) : 0),
      followed: s.followed + (hinting ? (j?.followed ?? 0) : 0),
      output: s.output + (record.actual.usage?.output ?? 0),
      jevMs: j?.ms.length ? [...s.jevMs, median(j.ms)].slice(-100) : s.jevMs,
      jevUsd: s.jevUsd + (j?.usd ?? 0),
      jevUnpriced: s.jevUnpriced + (j?.unpriced ?? 0),
    }
  })
  await update($, decision, () => null)
  await enter($, null)
}

// ------------------------------------------------------------ the pane

const STATE_TEXT: Record<string, { text: string; color: string }> = {
  off: { text: 'off', color: 'gray' },
  no_key: { text: 'needs a key', color: 'yellow' },
  ready: { text: 'ready', color: 'green' },
  excluded: { text: 'off in this repo', color: 'gray' },
}

/** One cell per time Jev was asked: what it answered. */
const CARD_CELL: Record<string, { cell: string; color?: string; dim?: boolean }> = {
  pick: { cell: '■', color: 'cyan' },
  pass: { cell: '·', dim: true },
  fail: { cell: '×', color: 'red' },
}

const ARM_TEXT: Record<JevTurnView['arm'], string | undefined> = {
  hint: undefined,
  control: 'control turn: Jev sat it out, to compare with',
  shadow: 'shadow: Jev was asked, Claude saw none of it',
  excluded: 'excluded repo: Jev was not asked',
  off: 'paused: Jev was not asked',
}

async function drawPane($: $, e: Parameters<$['ui']['resolve']>[0]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const s = await read($, status)
  const last = await read($, lastView)
  const step = await read($, phase)
  const d = await read($, decision)
  const session = { ...EMPTY_SESSION, ...(await read($, sessionView)) }
  const state = STATE_TEXT[s.state] ?? { text: s.state, color: 'gray' }
  const ready = s.state === 'ready'
  const pct = (n: number, of: number) => (of > 0 ? ` (${Math.round((n / of) * 100)}%)` : '')
  const label = (text: string) => <Text dimColor>{text.padEnd(16)}</Text>
  const tile = (value: string, name: string, color?: string) => (
    <Box flexDirection="column" marginRight={3}>
      <Text bold color={color}>{value}</Text>
      <Text dimColor>{name}</Text>
    </Box>
  )
  const now = await sceneOf($)
  const usage = await usageNow($)
  const week = await read($, weekView)
  const lj = last?.jev
  const sessionJev = session.jevMs.length ? median(session.jevMs) : undefined

  return (
    <Box flexDirection="column">
      {/* where things stand */}
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text bold>Jev</Text>
          <Text color={state.color}>  ● {state.text}</Text>
          {ready ? <Text color={s.paused ? 'yellow' : 'cyan'}>  {routingText(s)}</Text> : null}
        </Text>
        <Text dimColor>{s.provider ?? ''}</Text>
      </Box>
      {ready ? (
        <Text dimColor wrap="truncate-end">
          asked before each of Claude's requests · hints at ≥ 0.7 · {controlPercent}% control turns
        </Text>
      ) : null}
      {ready ? (
        <Text wrap="truncate-end">
          <Text dimColor>done check  </Text>
          <Text color={(s.doneCheck ?? doneMode) === 'on' ? 'cyan' : undefined} dimColor={(s.doneCheck ?? doneMode) === 'off'}>
            {DONE_MODE_TEXT[s.doneCheck ?? doneMode]}
          </Text>
        </Text>
      ) : null}
      {s.gateway ? (
        <Text color="yellow" wrap="wrap">
          This session's requests go through a local proxy ({s.gateway}). If it is jev-gateway, it hints too: run one or the other to measure either.
        </Text>
      ) : null}

      {/* the turn running now */}
      {step ? (
        <Box marginTop={1}>
          <Text wrap="truncate-end">
            <Text color="yellow">▶ now  </Text>
            {nowLine($, e, now.scene, d, now.shadow, step.tool, s.paused)}
          </Text>
        </Box>
      ) : null}

      {/* the last turn */}
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Last turn</Text>
          {last ? (
            <Text dimColor>
              {'  '}
              {duration(last.durationMs)} · {last.steps} requests{last.output !== undefined ? ` · ${tokens(last.output)} out` : ''}
            </Text>
          ) : null}
        </Text>
        {last === null ? (
          <Text dimColor>No turn yet. Send a prompt and Jev's answers show up here.</Text>
        ) : (
          <Box flexDirection="column">
            {last.prompt ? <Text dimColor italic wrap="truncate-end">“{cleanPrompt(last.prompt)}”</Text> : null}
            {ARM_TEXT[last.arm] ? <Text dimColor>{ARM_TEXT[last.arm]}</Text> : null}
            {last.done ? (
              <Text color={last.done.verdict === 'push' ? (last.done.pushed ? 'cyan' : 'yellow') : undefined} dimColor={last.done.verdict !== 'push'}>
                done check · {doneText(last.done, doneMode === 'shadow')}
              </Text>
            ) : null}
            {lj ? (
              <Box flexDirection="column" marginTop={1}>
                {lj.cards.length > 0 ? (
                  <Text wrap="wrap">
                    {lj.cards.map(c => {
                      const cell = CARD_CELL[c] ?? CARD_CELL.pass!
                      return <Text color={cell.color} dimColor={cell.dim}>{cell.cell}</Text>
                    })}
                  </Text>
                ) : null}
                <Text>
                  {label(last.arm === 'shadow' ? 'Jev would hint' : 'Jev hinted')}
                  <Text color="cyan" bold>{lj.hinted}</Text>
                  <Text dimColor> of {lj.asked} asks{pct(lj.hinted, lj.asked)}</Text>
                </Text>
                {lj.hinted > 0 ? (
                  <Text>
                    {label(last.arm === 'shadow' ? 'Claude did too' : 'Claude followed')}
                    <Text bold>{lj.followed}</Text>
                    <Text dimColor> of {lj.hinted}</Text>
                  </Text>
                ) : null}
                {lj.picks.length > 0 ? (
                  <Text wrap="wrap">
                    {label('picked')}
                    <Text color="cyan">{toolCounts(lj.picks)}</Text>
                  </Text>
                ) : null}
                {Object.keys(lj.reasons).length > 0 ? (
                  <Text wrap="wrap">
                    {label('left to Claude')}
                    <Text>
                      {Object.entries(lj.reasons)
                        .sort((a, b) => b[1] - a[1])
                        .map(([r, n]) => `${reasonText(r)} ${n}`)
                        .join(' · ')}
                    </Text>
                  </Text>
                ) : null}
                {lj.ms !== undefined ? (
                  <Text>
                    {label('Jev latency')}
                    <Text color={lj.ms > 1000 ? 'yellow' : undefined}>{latency(lj.ms)}</Text>
                    <Text dimColor> per ask, before Claude's request</Text>
                  </Text>
                ) : null}
              </Box>
            ) : null}
          </Box>
        )}
      </Box>

      {/* what it cost, and what hints saved */}
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Spend</Text>
          <Text dimColor>  this session</Text>
        </Text>
        <Text wrap="truncate-end">
          {label('this session')}
          {usage.usd !== undefined ? <Text>Claude {dollars(usage.usd)}</Text> : <Text dimColor>Claude cost unknown</Text>}
          <Text dimColor> at API prices</Text>
          <Text> · Jev {jevCost(session.jevUsd, session.jevUnpriced)}</Text>
          <Text dimColor> over {session.asked} asks</Text>
        </Text>
        {usage.week !== undefined ? (
          <Text wrap="truncate-end">
            {label('weekly quota')}
            <Text color={usage.week >= 80 ? 'red' : usage.week >= 50 ? 'yellow' : undefined} bold>{usage.week.toFixed(1)}%</Text>
            <Text dimColor> used{usage.weekResetsAt ? ` · resets ${resets(usage.weekResetsAt)}` : ''}</Text>
          </Text>
        ) : (
          <Text dimColor>{'weekly quota'.padEnd(16)}not reported (API key, or no request yet)</Text>
        )}
      </Box>

      {/* the last days, from the log */}
      {week ? (
        <Box marginTop={1} flexDirection="column">
          {week.map((line, i) =>
            line === '' ? (
              <Text key={`week-${i}`}> </Text>
            ) : i === 0 ? (
              <Text key="week-0" wrap="wrap">
                <Text bold>{line.split(':')[0]}</Text>
                <Text dimColor>{line.slice(line.indexOf(':') + 1)}</Text>
              </Text>
            ) : (
              <Text key={`week-${i}`} wrap="wrap" dimColor={line.startsWith('  ')} color={/^\s*Hints (saved|cost)/.test(line) ? (line.includes('saved') ? 'green' : 'yellow') : undefined}>
                {line.trim()}
              </Text>
            ),
          )}
        </Box>
      ) : null}

      {/* the session */}
      <Box marginTop={1} flexDirection="column">
        <Text bold>This session</Text>
        <Box flexDirection="row" flexWrap="wrap">
          {tile(String(session.turns), 'turns')}
          {tile(String(session.requests), 'requests')}
          {tile(`${session.hinted}${pct(session.hinted, session.asked)}`, 'hinted', 'cyan')}
          {session.hinted > 0 ? tile(`${session.followed}${pct(session.followed, session.hinted)}`, 'followed') : null}
          {session.controlTurns > 0 ? tile(String(session.controlTurns), 'control turns') : null}
          {session.output ? tile(tokens(session.output), 'output') : null}
          {sessionJev !== undefined ? tile(latency(sessionJev), 'Jev p50', sessionJev > 1000 ? 'yellow' : undefined) : null}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor wrap="wrap">
          {s.mode === 'shadow'
            ? 'Shadow: Jev is asked and its picks are recorded, but Claude never sees them. The last 7 days show how often Claude chose the same tool on its own.'
            : last === null
              ? "Jev picks the tool that fits Claude's next step, and Claude gets it as a hint it may ignore. Some turns run without Jev (control), so the last 7 days can tell whether hints help on your own work."
              : 'Hints vs control puts turns with hints next to turns without Jev: same kind of work, with and without.'}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="row" flexWrap="wrap" columnGap={2}>
        {s.state === 'no_key' ? <Button key="setup" hotkey="s" plain variant="primary" label="set up" onPress={() => void $.command.run({ command: 'jev-setup', args: '' })} /> : null}
        {ready ? <Button key="pause" hotkey="p" plain label={s.paused ? 'resume' : 'pause'} onPress={() => setPaused($, !s.paused)} /> : null}
        {ready ? <Button key="done" hotkey="d" plain label={`done check: ${DONE_NEXT[s.doneCheck ?? doneMode]}`} onPress={() => cycleDoneCheck($)} /> : null}
        {/* the terminal's pane has its own ✕ */}
        {e.surface !== 'terminal' ? <Button key="close" role="dismiss" plain label="close" onPress={() => $.ui.close({ id: PANE })} /> : null}
      </Box>
    </Box>
  )
}

const DONE_NEXT = { shadow: 'on', on: 'off', off: 'shadow' } as const
const DONE_MODE_TEXT = {
  shadow: 'shadow · broken promises are only recorded',
  on: 'on · Claude is sent back to work',
  off: 'off · stops are not checked',
} as const

/** Moves the done check to its next mode, saved in /config like the menu would. */
async function cycleDoneCheck($: $): Promise<void> {
  const value = DONE_NEXT[doneMode]
  try {
    const row = (await $.config.list()).find(r => r.key.endsWith('.doneCheck') && r.key.startsWith('jev'))
    const written = row ? await $.config.set({ key: row.key, value }) : { deny: 'the option is not in /config' }
    if (written.deny !== undefined) {
      $.ui.toast(`Jev: the done check stays ${doneMode} (${written.deny}).`)
      return
    }
  } catch (error) {
    $.ui.toast(`Jev: the done check stays ${doneMode} (${message(error)}).`)
    return
  }
  doneMode = value
  await update($, status, s => ({ ...s, doneCheck: value }))
}

/** `Mon 14:00` for a reset time. */
function resets(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
  return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Stops or resumes asking Jev in this session alone. */
async function setPaused($: $, paused: boolean): Promise<void> {
  await update($, status, s => ({ ...s, paused }))
}

// ------------------------------------------------------------ setup

async function ask($: $, question: string, options: string[], header = 'Jev'): Promise<string | undefined> {
  try {
    return await $.ui.ask(question, { header, options })
  } catch {
    return undefined
  }
}

const CLIPBOARD: readonly { read: string[]; clear: string[] }[] = [
  { read: ['pbpaste'], clear: ['pbcopy'] },
  { read: ['powershell', '-NoProfile', '-Command', 'Get-Clipboard'], clear: ['powershell', '-NoProfile', '-Command', 'Set-Clipboard -Value $null'] },
  { read: ['wl-paste', '--no-newline'], clear: ['wl-copy', '--clear'] },
  { read: ['xclip', '-selection', 'clipboard', '-o'], clear: ['xclip', '-selection', 'clipboard'] },
]

/** The clipboard's text through whichever tool this platform has, and how to clear it after. */
async function readClipboard($: $): Promise<{ text: string; clear: string[] } | undefined> {
  for (const tool of CLIPBOARD) {
    try {
      const r = await $.process.run(tool.read, { timeoutMs: 5000 })
      if (r.exitCode === 0) return { text: r.stdout.trim(), clear: tool.clear }
    } catch {
      // not this platform's tool
    }
  }
  return undefined
}

type Checked = { ok: boolean; ms?: number; status?: number; reason?: string }

/** One small call to Jev with the key: it answers, or says why not. */
async function checkKey($: $, a: JevAccess): Promise<Checked> {
  const started = await $.clock.now()
  const state: JevState = { conversation: [{ role: 'user', text: 'What is in the README?' }] }
  const call = askJev($, a, state, toolQuestions([{ name: 'Read', description: 'Reads a file from the local filesystem.' }])).then(
    (): Checked => ({ ok: true }),
    (error): Checked => ({ ok: false, reason: message(error), ...((error as { status?: number }).status ? { status: (error as { status: number }).status } : {}) }),
  )
  const r = (await within($, call, 15_000)) ?? { ok: false, reason: 'no answer in 15s' }
  return r.ok ? { ok: true, ms: (await $.clock.now()) - started } : r
}

/** Writes the key to jev-gateway's key file, keeping the rest of it, readable only by the user. */
async function saveKey($: $, provider: Provider, key: string, model?: string): Promise<void> {
  const path = `${home}/${KEY_FILE}`
  let text = ''
  try {
    text = await $.fs.read(path)
  } catch {
    // a new file
  }
  await $.fs.write(path, upsertEnv(text, { JEV_PROVIDER: provider, [PROVIDERS[provider].keyEnv]: key, ...(model ? { JEV_MODEL: model } : {}) }))
  // No chmod on Windows: the file sits in the user's own profile there.
  await $.process.run(['chmod', '600', path], { timeoutMs: 5000 }).catch(() => undefined)
}

/** Asks for a key for Jev, checks it, and saves it. */
async function setUpKey($: $): Promise<{ text: string; ok: boolean }> {
  const ids = Object.keys(PROVIDERS) as Provider[]
  const chosen = await ask($, 'Where should the mod reach Jev?', ids.map(id => PROVIDERS[id].label))
  const id = ids.find(p => PROVIDERS[p].label === chosen)
  if (!id) return { ok: false, text: 'Jev setup cancelled.' }
  const p = PROVIDERS[id]
  const how = await ask(
    $,
    `Copy your ${p.label} API key (get one at ${p.keyUrl}), then choose "Read the clipboard". It is read once, checked with one call to Jev, saved to ~/${KEY_FILE} (readable only by you; jev-gateway reads the same file), never shown, and the clipboard is cleared.`,
    ['Read the clipboard', 'Cancel'],
    'API key',
  )
  if (how !== 'Read the clipboard') return { ok: false, text: 'Jev setup cancelled.' }
  const clip = await readClipboard($)
  if (!clip) return { ok: false, text: `Jev setup stopped: no clipboard tool found. Put the key in ~/${KEY_FILE} as ${p.keyEnv}=<key> instead, then run /jev-setup again.` }
  if (!isValidKey(clip.text)) return { ok: false, text: 'Jev setup stopped: the clipboard does not hold an API key (one line of letters, digits, dots, dashes or underscores). Copy the key and run /jev-setup again.' }

  const accessWith = (model?: string) => jevAccess({ JEV_PROVIDER: id, [p.keyEnv]: clip.text, ...(model ? { JEV_MODEL: model } : {}) }, {})!
  let model: string | undefined
  let checked = await checkKey($, accessWith())
  if (!checked.ok && id === 'opencode' && (checked.status === 404 || checked.status === 410)) {
    const paid = await ask($, `The free Jev model is unavailable on ${p.label}. Use the paid one? Its key check may be billed.`, ['Use the paid model', 'Cancel'])
    if (paid !== 'Use the paid model') return { ok: false, text: 'Jev setup stopped: the free model is unavailable. Nothing was saved.' }
    model = PROVIDERS.opencode.paidModel
    checked = await checkKey($, accessWith(model))
  }
  if (!checked.ok) {
    const refused = checked.status === 401 || checked.status === 403
    return { ok: false, text: `Jev setup stopped: ${refused ? `${p.label} refused that key` : 'the key check failed'} (${checked.reason ?? 'no answer'}). Nothing was saved.` }
  }
  await saveKey($, id, clip.text, model)
  await $.process.run(clip.clear, { stdin: '', timeoutMs: 5000 }).catch(() => undefined)
  return { ok: true, text: `Key checked (Jev answered in ${checked.ms ?? '?'}ms) and saved to ~/${KEY_FILE}; clipboard cleared.` }
}

async function setup($: $, cwd: string): Promise<string> {
  if (mode === 'off') return 'Jev is off: set "Jev: hints" to on or shadow in /config first.'
  if (excluded) return 'This repo is in the excluded list (/config, "Jev: excluded repos"), so Jev is never asked here.'
  const lines: string[] = []
  const existing = await loadAccess($)
  const keep = existing ? await ask($, `A key for Jev is already set up (${PROVIDERS[existing.provider].label}). Keep it?`, ['Keep it', 'Set a new key']) : 'Set a new key'
  if (keep === undefined) return 'Jev setup cancelled.'
  if (keep === 'Set a new key') {
    const key = await setUpKey($)
    lines.push(key.text)
    if (!key.ok) return lines.join('\n')
  }
  await configure($, cwd)
  if (!access) return [...lines, `Jev setup stopped: no key found in ~/${KEY_FILE} or the environment.`].join('\n')
  lines.push(`Jev is ready (${PROVIDERS[access.provider].label}): it is asked before Claude's requests from the next one. /jev shows its answers.`)
  return lines.join('\n')
}

// ------------------------------------------------------------ hooks

export const register: Register = (on, options) => {
  mode = options.mode === 'off' || options.mode === 'shadow' ? options.mode : 'on'
  doneMode = options.doneCheck === 'on' || options.doneCheck === 'off' ? options.doneCheck : 'shadow'
  controlPercent = typeof options.controlPercent === 'number' && options.controlPercent >= 0 && options.controlPercent <= 100 ? options.controlPercent : 20
  excludedRepos = typeof options.excludedRepos === 'string' ? options.excludedRepos : ''
  let cwd = ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = e.cwd
    project = folderName(cwd)
    home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    sessionId = await $.session.id()
    const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
    logPath = home ? `${home}/.claude/jev-mod/log/${day}-${sessionId}.jsonl` : ''

    // A load or reload starts with no turn in flight: clear what a cut-short one left behind, and
    // views an older version of the mod left in another shape.
    await update($, phase, () => null)
    await update($, decision, () => null)
    const last = (await read($, lastView)) as Record<string, unknown> | null
    if (last && !('arm' in last)) await update($, lastView, () => null)
    const totals = (await read($, sessionView)) as Record<string, unknown>
    if (!('hintTurns' in totals)) await update($, sessionView, () => EMPTY_SESSION)

    await $.command.register({ name: 'jev', description: 'Open the Jev pane: the last turn, the last 7 days (hints vs control, spend, savings), and the switches' })
    await $.command.register({ name: 'jev-setup', description: "Add a key for Jev, so it is asked before Claude's requests" })

    try {
      await undoGatewayRouting($)
      await configure($, cwd)
      await refreshWeek($)
    } catch (error) {
      $.ui.log(`jev: ${message(error)}`, { to: 'debug' })
    }
    return started
  })

  // ------------------------------------------------------------ during a turn

  // Before Claude's first request: Jev reads the conversation and the new prompt; a hint rides the prompt.
  on('prompt.submit', async ($, e, next) => {
    // A prompt delivered into a running turn is not a new turn's.
    if (e.turnId || !tracked()) return next(e)
    const arm = armFor((await read($, status)).paused === true)
    const o: NonNullable<typeof opening> = { arm, jev: emptyJevTurn() }
    opening = o
    if ((arm !== 'hint' && arm !== 'shadow') || e.text.trimStart().startsWith('/')) return next(e)
    const rows: MessageRow[] = [...(await conversationRows($)), { role: 'user', text: e.text, toolUses: [] }]
    const d = await consult($, o.jev, arm, rows)
    if (d.mode !== 'hint' || !d.tool) return next(e)
    o.pending = d.tool
    return arm === 'hint' ? next({ ...e, context: [...(e.context ?? []), hintText(d.tool)] }) : next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (tracked()) {
      const o = opening ?? { arm: armFor((await read($, status)).paused === true), jev: emptyJevTurn() }
      opening = undefined
      turns.set(e.turnId, { prompt: e.text, arm: o.arm, steps: 0, tools: 0, jev: o.jev, ...(o.pending ? { pending: o.pending } : {}), before: await usageNow($) })
      current = e.turnId
    }
    return next(e)
  })

  // Each of Claude's requests: Claude thinks while Jev holds still.
  on('turn.step', async function* ($, e, next) {
    const turn = e.agentId ? undefined : turns.get(e.turnId)
    if (!turn) return yield* next(e)
    turn.steps++
    let settle: (calls: number) => void = () => undefined
    const step: Step = { done: new Promise<number>(r => (settle = r)), finished: 0, results: {} }
    turn.step = step
    if (turn.arm !== 'excluded') await enter($, 'thinking', turn.arm)
    let calls = -1
    try {
      const result = yield* next(e)
      calls = result.toolUses.length
      // Did Claude call the tool Jev pointed at (hinted, or would have in shadow)?
      if (turn.pending && result.toolUses.some(u => u.name === turn.pending)) turn.jev.followed++
      turn.pending = undefined
      return result
    } finally {
      settle(calls)
    }
  })

  // Claude's tools: Claude works; after the last call of a response, Jev is asked about the next request.
  on('tool.call', async ($, e, next) => {
    const turn = !e.agentId && current ? turns.get(current) : undefined
    if (!turn) return next(e)
    // Every call carries both; the generated MCP typings leave one member of the union without them.
    const call = e as unknown as { tool: string; tool_use_id: string }
    turn.tools++
    lastToolAt = await $.clock.now()
    if (turn.arm !== 'excluded') await enter($, 'working', turn.arm, call.tool)
    const result = await next(e)
    const step = turn.step
    if (!step || result.deny !== undefined) return result
    const mine = ++step.finished
    if (result.text !== undefined) step.results[call.tool_use_id] = result.text
    const calls = (await within($, step.done, STEP_WAIT_MS)) ?? mine
    // The response's other calls are still running, or it never ended: not this one's to ask.
    if (calls < 0 || mine < calls || turn.step !== step) return result
    turn.step = undefined
    if (turn.arm !== 'hint' && turn.arm !== 'shadow') return result
    const d = await consult($, turn.jev, turn.arm, await conversationRows($), step.results)
    if (d.mode !== 'hint' || !d.tool) return result
    turn.pending = d.tool
    return turn.arm === 'hint' ? { ...result, context: [...(result.context ?? []), hintText(d.tool)] } : result
  })

  // Claude's stop: a promise of more work with nothing running sends it back to work (or, in shadow, is recorded).
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    const turn = current ? turns.get(current) : undefined
    // The main loop only, Jev's turns only, and never a stop that a push already caused.
    if (doneMode === 'off' || e.agent_id || e.stop_hook_active || !turn || (turn.arm !== 'hint' && turn.arm !== 'shadow' && turn.arm !== 'control') || result.block) return result
    const done = checkStop($, e)
    turn.done = done
    const d = await done
    if (!d.pushed) return result
    $.ui.toast('Jev: Claude stopped on a promise with nothing running, so it was sent back to work.')
    return { ...result, block: DONE_NUDGE }
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId) return next(e)
    const turn = turns.get(e.turnId)
    turns.delete(e.turnId)
    if (current === e.turnId) current = undefined
    if (turn) void finish($, e.turnId, turn, e).catch(error => $.ui.log(`jev: ${message(error)}`, { to: 'debug' }))
    else void enter($, null).catch(() => undefined)
    return next(e)
  })

  // ------------------------------------------------------------ commands and drawing

  on('command.run', { command: 'jev' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Jev' })
    return { text: opened.isPlaced ? 'Jev pane opened.' : 'Jev pane: widen the terminal to see it.' }
  })

  on('command.run', { command: 'jev-setup' }, async $ => ({ text: await setup($, cwd) }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => drawBand($, e, () => next(e)))
}
