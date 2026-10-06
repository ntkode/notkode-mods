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
  JEV_TIMEOUT_MS as ASK_TIMEOUT_MS,
  LOW_EFFORT_STEPS,
  TOPIC_MIN_TOKENS,
  TRIAGE_QUESTIONS,
  approxTokens,
  gateListing,
  parseSkillListing,
  skillQuestions,
  skillsToTrim,
  triage as triageOf,
  DONE_QUESTIONS,
  decide,
  doneText,
  doneVerdict,
  newTrail,
  noteCall,
  verifyNeed,
  verifyNudge,
  verifyRole,
  decisionText,
  dollars,
  columnChart,
  totalSaved,
  jevCost,
  duration,
  emptyJevTurn,
  folderName,
  hintText,
  isExcluded,
  isGatewayOn,
  isValidKey,
  jevAccess,
  localGatewayOrigin,
  median,
  normalizeAnswers,
  parseEnvFile,
  parseLog,
  reasonText,
  board as boardOf,
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
import type { Answer, Arm, Decision, DoneCheck, Spend, VerifyCheck, VerifyTrail, Triage, JevAccess, JevState, JevTurn, LogRecord, MessageRow, Provider, Question, Tool, TurnRecord } from './logic'
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
const boardView = atom({ plugin: 'jev', key: 'board' } as const, null)
const skillView = atom({ plugin: 'jev', key: 'skills' } as const, null)
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
  /** The files Claude changed this turn and what it ran or looked at after. */
  trail: VerifyTrail
  /** Set once the turn was sent back to check its changes: once per turn. */
  verifyPushed?: VerifyCheck['need']
  /** What Jev made of the prompt (effort, topic) and what the mod did with it. */
  triage?: NonNullable<TurnRecord['triage']>
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
let doneMode: 'shadow' | 'on' | 'off' = 'off'
let verifyMode: 'on' | 'off' = 'on'
let effortMode: 'on' | 'shadow' | 'off' = 'on'
let skillMode: 'on' | 'shadow' | 'off' = 'on'
let topicMode: 'ask' | 'off' = 'ask'
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
let opening: { arm: Turn['arm']; jev: JevTurn; pending?: string; triage?: NonNullable<TurnRecord['triage']> } | undefined
/** A fresh start the person chose: recorded on the turn their re-sent prompt opens. */
let freshChosen: 'clear' | 'compact' | undefined
/** The context's size when a fresh start was chosen, and what it dropped (tokens every later request no longer re-reads). */
let freshFrom = 0
let freshDropped = 0
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

// ------------------------------------------------------------ the session's facts

/** The folder the session runs in. */
let sessionCwd = ''
/** The session's facts, worked out once per load of the module. */
let sessionReady: Promise<void> | undefined

/**
 * Works out the session's facts (home, log, key, routing leftovers) once per load. A reload
 * (/reload-plugins, a plugin update) starts the module over without firing session.start, so every
 * hook that needs them calls this first.
 */
function ensureSession($: $, cwd?: string): Promise<void> {
  sessionReady ??= startSession($, cwd).catch(error => $.ui.log(`jev: ${message(error)}`, { to: 'debug' }))
  return sessionReady
}

async function startSession($: $, cwd?: string): Promise<void> {
  freshDropped = 0
  sessionCwd = cwd ?? (await $.session.cwd())
  project = folderName(sessionCwd)
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

  await undoGatewayRouting($)
  await configure($, sessionCwd)
  await refreshWeek($)
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

/** The features' switches as the status records them. */
function switchStatus(): { doneCheck: 'on' | 'off'; verify: 'on' | 'off'; effort: 'on' | 'off'; skillGate: 'on' | 'off'; freshStart: 'on' | 'off' } {
  const v = (on: boolean) => (on ? 'on' : 'off') as 'on' | 'off'
  return { doneCheck: v(doneMode === 'on'), verify: v(verifyMode === 'on'), effort: v(effortMode !== 'off'), skillGate: v(skillMode !== 'off'), freshStart: v(topicMode !== 'off') }
}

/** Works out whether Jev can be asked here, from the options, the folder and the key. */
async function configure($: $, cwd: string): Promise<void> {
  excluded = isExcluded(cwd, excludedRepos)
  access = excluded ? undefined : await loadAccess($)
  const gateway = localGatewayOrigin(await $.env.get('ANTHROPIC_BASE_URL'))
  const state: JevReadiness = excluded ? 'excluded' : access ? 'ready' : 'no_key'
  await update($, status, before => ({
    state,
    mode,
    ...(access ? { provider: PROVIDERS[access.provider].label } : {}),
    ...(gateway ? { gateway } : {}),
    ...(before.paused ? { paused: true } : {}),
    ...switchStatus(),
  }))
}

/** Turns are followed (logged, counted) when Jev can be asked, and in excluded repos for the record. */
function tracked(): boolean {
  return excluded || access !== undefined
}

/**
 * How the next turn is run. Control turns (a random share) run with no Jev feature at all, the
 * baseline every feature's saving is measured against; the rest get hints when hints are on.
 */
function armFor(paused: boolean): Turn['arm'] {
  if (excluded) return 'excluded'
  if (paused || !access) return 'off'
  if (roll() * 100 < controlPercent) return 'control'
  return mode === 'on' ? 'hint' : mode === 'shadow' ? 'shadow' : 'off'
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

// ------------------------------------------------------------ triage: effort and fresh starts

/** One Jev call about the prompt: how much reasoning it needs, and whether it opens a new task. */
async function runTriage($: $, rows: readonly MessageRow[]): Promise<Triage | undefined> {
  const a = access
  if (!a) return undefined
  const work = askJev($, a, buildState(turnsFrom(rows)), TRIAGE_QUESTIONS).then(triageOf, () => undefined)
  return within($, work, ASK_TIMEOUT_MS)
}

/** How big the conversation is now, in tokens (what every request re-reads). */
async function contextTokens($: $): Promise<number> {
  try {
    return (await $.session.usage()).context.tokens ?? 0
  } catch {
    return 0
  }
}

/**
 * Runs /clear or /compact, then sends the person's prompt again, as theirs. A command cannot run
 * from inside the prompt's own hook (it would wait on the prompt being held), so it starts from a
 * timer once that hook has returned.
 */
function freshStart($: $, how: 'clear' | 'compact', text: string): void {
  const timer = $.clock.every(50, async () => {
    timer.cancel()
    try {
      freshChosen = how
      await $.command.run({ command: how, args: '' })
      await $.prompt.submit({ text, asUser: true })
    } catch (error) {
      freshChosen = undefined
      $.ui.toast(`Jev: could not ${how} (${message(error)}); your prompt was not sent, so send it again.`)
    }
  })
}

const FRESH_OPTIONS = { clear: 'Start fresh (/clear), then send it', compact: 'Compact first (/compact), then send it', keep: 'Keep the conversation' } as const

// ------------------------------------------------------------ the skill gate

type SkillGate = { session: string; mode: 'on' | 'shadow'; trim: string[]; count: number; before: number; after: number }

/** What the session's project is about, for Jev to judge which skills it needs. */
async function projectSignals($: $): Promise<string> {
  const head = async (file: string) => {
    try {
      return (await $.fs.read(`${sessionCwd}/${file}`)).slice(0, 1500)
    } catch {
      return ''
    }
  }
  let names = ''
  try {
    names = (await $.fs.list(sessionCwd)).map(e => e.name).filter(n => !n.startsWith('.')).slice(0, 40).join(', ')
  } catch {
    // an unreadable folder: the name and the files below say enough
  }
  const claude = await head('CLAUDE.md')
  const readme = await head('README.md')
  return [`Project folder: ${project}`, names ? `Files: ${names}` : '', claude ? `CLAUDE.md:\n${claude}` : '', readme ? `README.md:\n${readme}` : ''].filter(Boolean).join('\n\n')
}

/**
 * Decides, once per session, which skills keep their description in the listing Claude reads on
 * every request. Kept in state so the listing stays the same for the whole session (the prompt
 * cache depends on it), across reloads too. Undefined when Jev could not judge: the listing stays whole.
 */
async function decideSkills($: $, listing: NonNullable<ReturnType<typeof parseSkillListing>>): Promise<SkillGate | undefined> {
  const known = await read($, skillView)
  if (known && known.session === sessionId) return known
  const a = access
  if (!a || skillMode === 'off') return undefined
  const state: JevState = { conversation: [{ role: 'user', text: await projectSignals($) }] }
  const answers = await within($, askJev($, a, state, skillQuestions(listing.entries)).catch(() => undefined), ASK_TIMEOUT_MS + 2000)
  if (!answers) return undefined
  const trim = skillsToTrim(listing.entries, answers)
  const whole = gateListing(listing, new Set())
  const gated = gateListing(listing, new Set(trim))
  const gate: SkillGate = { session: sessionId, mode: skillMode === 'on' ? 'on' : 'shadow', trim, count: listing.entries.length, before: approxTokens(whole), after: approxTokens(gated) }
  await update($, skillView, () => gate)
  return gate
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

/** One speech balloon's words, and the color they take. */
type Line = { text: string; color?: string; dim?: boolean }

/** Jev's words for an answer: the decision as the pane says it, Jev being the one who speaks. */
function answerLine(d: { mode: 'hint' | 'pass'; reason?: string; tool?: string; confidence?: number }, shadow: boolean): Line {
  const card = cardFor(d)
  return { text: decisionText(d, shadow).replace(/^Jev /, ''), ...(card === 'pick' ? { color: 'cyan' } : card === 'fail' ? { color: 'red' } : { dim: true }) }
}

/**
 * What each one says this moment: Claude in the balloon on its left, Jev in the one on its right.
 * A balloon shows only while its one is on the task: Jev's while it decides and its answer
 * travels back, none while it rests (idle, or Claude thinking and working). Claude's shows always,
 * in color while it works.
 */
function speech(scene: Scene, d: { mode: 'hint' | 'pass'; reason?: string; tool?: string; confidence?: number } | null, shadow: boolean, step: { tool?: string } | null): { claude: Line; jev: Line | null } {
  const deciding: Line = { text: 'hmm… deciding', color: 'yellow' }
  switch (scene) {
    case 'unset':
      return { claude: { text: 'no Jev yet', dim: true }, jev: { text: 'not set up · run /jev-setup', dim: true } }
    case 'idle':
      return { claude: { text: 'ready when you are', dim: true }, jev: null }
    case 'asking':
      return { claude: { text: 'Jev, what next?', dim: true }, jev: deciding }
    case 'answering':
      return { claude: { text: '…', dim: true }, jev: d ? answerLine(d, shadow) : deciding }
    case 'thinking':
      return { claude: { text: 'thinking…', color: '#d97757' }, jev: null }
    case 'working':
      return { claude: { text: step?.tool ? `running ${step.tool}` : 'working…', color: '#d97757' }, jev: null }
  }
}

/** A speech balloon `width` cells wide at most, its tail pointing at the one speaking. */
function balloon($: $, e: Parameters<$['ui']['resolve']>[0], line: Line | null, width: number, border: string, tail: 'left' | 'right'): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  // No words: the room stays, so the scene does not move when a balloon comes and goes.
  if (!line) return <Box width={width} />
  const fit = Math.min(width - 1, line.text.length + 4)
  const body = (
    <Box borderStyle="round" borderColor={border} paddingX={1} width={fit}>
      <Text wrap="truncate-end" color={line.color} dimColor={line.dim}>{line.text}</Text>
    </Box>
  )
  const point = <Text key={`tail-${tail}`} color={border}>{tail === 'left' ? '◂' : '▸'}</Text>
  return (
    <Box width={width} flexDirection="row" alignItems="center" justifyContent={tail === 'right' ? 'flex-end' : 'flex-start'}>
      {tail === 'left' ? point : null}
      {body}
      {tail === 'right' ? point : null}
    </Box>
  )
}

/** Narrowest balloon worth drawing. */
const BALLOON_MIN = 12
const BALLOON_MAX = 36

async function drawBand($: $, e: Parameters<$['ui']['resolve']>[0] & { requestId?: string; props: { hasSurvey: boolean; maxRows: number; bodyColumns: number } }, next: () => RenderElement | Promise<RenderElement>): Promise<RenderElement> {
  const s = await read($, status)
  if (e.props.hasSurvey || s.state === 'off' || s.state === 'excluded') return next()
  const now = await sceneOf($)
  drawnScene = now.scene
  const step = await read($, phase)
  const d = await read($, decision)
  const { Box, Text } = $.ui.resolve(e)
  const says = speech(now.scene, d, now.shadow, step)
  const said = (line: Line) => (
    <Text color={line.color} dimColor={line.dim}>
      {line.text}
    </Text>
  )

  // The scene between the two balloons, with an empty line above it to set it apart from the transcript.
  if (e.surface === 'terminal' && e.props.maxRows >= SCENE_ROWS + 1) {
    const { Raster } = $.ui.resolve(e)
    bandSite = e.requestId
    const art = rasterCells(scenePixels(now))
    const width = Math.min(BALLOON_MAX, Math.floor((e.props.bodyColumns - art.columns - 2) / 2))
    const scene = <Raster key="jev-scene" columns={art.columns} rows={art.rows} cells={art.cells} />
    if (width < BALLOON_MIN) {
      return (
        <Box flexDirection="row" marginTop={1} alignItems="center">
          {scene}
          <Box marginLeft={2}>{said(says.jev ?? says.claude)}</Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="row" marginTop={1} alignItems="center">
        {balloon($, e, says.claude, width, '#d97757', 'right')}
        <Box marginX={1}>{scene}</Box>
        {balloon($, e, says.jev, width, '#2bb3a3', 'left')}
      </Box>
    )
  }

  return (
    <Box>
      <Text color={ANIMATED.has(now.scene) ? 'yellow' : 'cyan'}>◆ </Text>
      <Text dimColor>Claude: </Text>
      {said(says.claude)}
      {says.jev ? <Text dimColor> · Jev: </Text> : null}
      {says.jev ? said(says.jev) : null}
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
  // What the features took off every request: the skill gate's trim, and an earlier fresh start.
  if (turn.triage?.fresh === 'clear' || turn.triage?.fresh === 'compact') freshDropped = Math.max(0, freshFrom - (await contextTokens($)))
  const gate = await read($, skillView)
  const skillsSaved = gate && gate.session === sessionId && gate.mode === 'on' ? gate.before - gate.after : 0
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
    ...(turn.trail.changed.length > 0 ? { verify: { ...(turn.verifyPushed ? { need: turn.verifyPushed } : {}), pushed: turn.verifyPushed !== undefined, files: turn.trail.changed.length } } : {}),
    ...(turn.triage ? { triage: turn.triage } : {}),
    ...(skillsSaved > 0 || freshDropped > 0 ? { saved: { ...(skillsSaved > 0 ? { skills: skillsSaved } : {}), ...(freshDropped > 0 ? { fresh: freshDropped } : {}) } } : {}),
  }
  await log($, record)
  await publish($, record)
  await refreshWeek($)
}

/** The last days from the log, for the pane: what Jev answered, hints vs control, spend, savings. */
async function refreshWeek($: $): Promise<void> {
  const b = boardOf(await readLogs($, WEEK_DAYS), WEEK_DAYS, await $.clock.now())
  await update($, boardView, () => b)
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
  no_key: { text: 'needs a key', color: 'yellow' },
  ready: { text: 'ready', color: 'green' },
  excluded: { text: 'off in this repo', color: 'gray' },
}

/** The pane's switches: each feature on or off, saved in /config, in board order. */
const SWITCHES = {
  hints: { config: 'mode', label: 'hints', hotkey: 'h' },
  effort: { config: 'effort', label: 'effort', hotkey: 'e' },
  skillGate: { config: 'skillGate', label: 'skill gate', hotkey: 'k' },
  freshStart: { config: 'freshStart', label: 'fresh start', hotkey: 't' },
  doneCheck: { config: 'doneCheck', label: 'done check', hotkey: 'd' },
  verify: { config: 'verify', label: 'verify', hotkey: 'v' },
} as const
type SwitchKey = keyof typeof SWITCHES

function isOn(key: SwitchKey): boolean {
  return { hints: mode !== 'off', effort: effortMode !== 'off', skillGate: skillMode !== 'off', freshStart: topicMode !== 'off', doneCheck: doneMode === 'on', verify: verifyMode === 'on' }[key]
}

function setSwitch(key: SwitchKey, on: boolean): void {
  if (key === 'hints') mode = on ? 'on' : 'off'
  else if (key === 'effort') effortMode = on ? 'on' : 'off'
  else if (key === 'skillGate') skillMode = on ? 'on' : 'off'
  else if (key === 'freshStart') topicMode = on ? 'ask' : 'off'
  else if (key === 'verify') verifyMode = on ? 'on' : 'off'
  else doneMode = on ? 'on' : 'off'
}

/** Turns a feature on or off, saved in /config like the menu would. */
async function toggle($: $, key: SwitchKey): Promise<void> {
  const on = !isOn(key)
  const { config, label } = SWITCHES[key]
  try {
    const row = (await $.config.list()).find(r => r.key.endsWith(`.${config}`) && r.key.startsWith('jev'))
    const written = row ? await $.config.set({ key: row.key, value: on ? 'on' : 'off' }) : { deny: 'the option is not in /config' }
    if (written.deny !== undefined) {
      $.ui.toast(`Jev: ${label} stays ${on ? 'off' : 'on'} (${written.deny}).`)
      return
    }
  } catch (error) {
    $.ui.toast(`Jev: ${label} stays ${on ? 'off' : 'on'} (${message(error)}).`)
    return
  }
  setSwitch(key, on)
  // Rearm the turn drawing: hints on or off changes how the next turn is run.
  await update($, status, s => ({ ...s, mode, ...switchStatus() }))
}

/** `+1.2%`, `-0.4%`, `<0.1%`. */
function quotaPct(p: number): string {
  if (Math.abs(p) < 0.05) return p >= 0 ? '<0.1%' : '>-0.1%'
  return `${p > 0 ? '+' : ''}${p.toFixed(1)}%`
}

const CHART_ROWS = 3
/** Cells per day in a chart: a column and a gap. */
const DAY_WIDTH = 4

/** One feature's chart: its name and the window's figure, its columns, and the days under them. */
function featureChart($: $, e: Parameters<$['ui']['resolve']>[0], label: string, f: { savedPct?: number; daily: readonly (number | undefined)[] }, starts: readonly number[], unit: 'pct' | 'count'): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const daily = f.daily
  const known = daily.filter((v): v is number => v !== undefined)
  // The window's figure is the table's, so the two never disagree.
  const total = unit === 'count' ? known.reduce((a, v) => a + v, 0) : f.savedPct
  const figure = total === undefined || known.length === 0 ? 'measuring…' : unit === 'count' ? `${total} stops checked` : `${quotaPct(total)} over the ${starts.length} days`
  const rows = columnChart(daily, CHART_ROWS)
  const color = (v: number | undefined) => (v === undefined ? undefined : unit === 'count' ? 'cyan' : v >= 0 ? 'green' : 'yellow')
  return (
    <Box key={`chart-${label}`} marginTop={1} flexDirection="column">
      <Text>
        <Text>{label.padEnd(12)}</Text>
        <Text bold color={known.length === 0 ? undefined : color(total)} dimColor={known.length === 0}>{figure}</Text>
      </Text>
      {rows.map((row, r) => (
        <Text key={`row-${r}`}>
          {[...row].map((ch, i) => (
            <Text key={`c-${i}`} color={color(daily[i])} dimColor={daily[i] === undefined}>
              {ch.repeat(DAY_WIDTH - 1)}{' '}
            </Text>
          ))}
        </Text>
      ))}
      <Text dimColor>{starts.map(t => DAY_NAMES[new Date(t).getDay()]!.padEnd(DAY_WIDTH)).join('')}</Text>
    </Box>
  )
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

async function drawPane($: $, e: Parameters<$['ui']['resolve']>[0]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const s = await read($, status)
  const b = await read($, boardView)
  const state = STATE_TEXT[s.state] ?? { text: s.state, color: 'gray' }
  const ready = s.state === 'ready'
  const keys = Object.keys(SWITCHES) as SwitchKey[]
  const saved = b ? totalSaved(b.features) : undefined

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text bold>Jev</Text>
          <Text color={state.color}>  ● {state.text}</Text>
        </Text>
        <Text dimColor>{s.provider ?? ''}</Text>
      </Box>
      {s.state === 'no_key' ? <Text color="yellow">Run /jev-setup (or press s) to add a key for Jev.</Text> : null}

      {/* the options first: each feature on or off */}
      <Box marginTop={1} flexDirection="row" flexWrap="wrap" columnGap={2}>
        {s.state === 'no_key' ? <Button key="setup" hotkey="s" plain variant="primary" label="set up" onPress={() => void $.command.run({ command: 'jev-setup', args: '' })} /> : null}
        {ready ? keys.map(key => <Button key={key === 'doneCheck' ? 'done' : key} hotkey={SWITCHES[key].hotkey} plain label={`${SWITCHES[key].label} ${isOn(key) ? 'off' : 'on'}`} onPress={() => toggle($, key)} />) : null}
        {/* the terminal's pane has its own ✕ */}
        {e.surface !== 'terminal' ? <Button key="close" role="dismiss" plain label="close" onPress={() => $.ui.close({ id: PANE })} /> : null}
      </Box>

      {/* the two figures that matter: what Jev cost, and what it saved */}
      <Box marginTop={1} flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>{'Spent on Jev'.padEnd(15)}</Text>
          <Text>{b ? jevCost(b.usage.usd, b.usage.unpriced) : dollars(0)}</Text>
          <Text dimColor>  last {b?.days ?? WEEK_DAYS} days</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text bold>{'Quota saved'.padEnd(15)}</Text>
          {saved === undefined ? <Text dimColor>measuring…</Text> : <Text bold color={saved >= 0 ? 'green' : 'yellow'}>{quotaPct(saved)}</Text>}
          <Text dimColor>  of the weekly quota</Text>
        </Text>
      </Box>

      {/* each feature: on or off, and what it saved of the weekly quota */}
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Features</Text>
          <Text dimColor>  saved of the weekly quota, last {b?.days ?? WEEK_DAYS} days</Text>
        </Text>
        {keys.map(key => {
          const on = isOn(key)
          const f = b?.features[key]
          const featureSaved = f?.savedPct
          return (
            <Text key={`feature-${key}`} wrap="truncate-end">
              <Text dimColor>{SWITCHES[key].hotkey} </Text>
              <Text>{SWITCHES[key].label.padEnd(12)}</Text>
              <Text color={on ? 'green' : undefined} dimColor={!on}>{(on ? 'on' : 'off').padEnd(5)}</Text>
              <Text bold color={featureSaved === undefined ? undefined : featureSaved >= 0 ? 'green' : 'yellow'} dimColor={featureSaved === undefined}>
                {(featureSaved === undefined ? '—' : quotaPct(featureSaved)).padStart(7)}
              </Text>
              <Text dimColor>  {f?.detail ?? ''}</Text>
            </Text>
          )
        })}
      </Box>

      {/* a chart per feature: what it did each day of the window */}
      {b ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text bold>By day</Text>
            <Text dimColor>  share of the weekly quota saved each day; done check and verify, how often they acted</Text>
          </Text>
          {keys.map(key => featureChart($, e, SWITCHES[key].label, b.features[key], b.dayStarts, key === 'doneCheck' || key === 'verify' ? 'count' : 'pct'))}
        </Box>
      ) : null}

      {(b && b.pctPerUnit === undefined) || s.gateway ? (
        <Box marginTop={1} flexDirection="column">
        {b && b.pctPerUnit === undefined ? <Text dimColor>Savings show once a few turns have recorded the quota they used.</Text> : null}
        {s.gateway ? <Text color="yellow" wrap="wrap">This session goes through a local proxy ({s.gateway}); if it is jev-gateway, it hints too.</Text> : null}
        </Box>
      ) : null}

    </Box>
  )
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
  // A model id belongs to one provider: a new key without one drops the old provider's.
  const kept = model ? text : text.replace(/^\s*(export\s+)?JEV_MODEL\s*=.*\n?/gm, '')
  await $.fs.write(path, upsertEnv(kept, { JEV_PROVIDER: provider, [PROVIDERS[provider].keyEnv]: key, ...(model ? { JEV_MODEL: model } : {}) }))
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
  // Every feature is a plain on/off; values from older versions (shadow) count as their nearest.
  mode = options.mode === 'off' ? 'off' : 'on'
  doneMode = options.doneCheck === 'on' ? 'on' : 'off'
  verifyMode = options.verify === 'off' ? 'off' : 'on'
  effortMode = options.effort === 'off' ? 'off' : 'on'
  skillMode = options.skillGate === 'off' ? 'off' : 'on'
  topicMode = options.freshStart === 'off' ? 'off' : 'ask'
  controlPercent = typeof options.controlPercent === 'number' && options.controlPercent >= 0 && options.controlPercent <= 100 ? options.controlPercent : 20
  excludedRepos = typeof options.excludedRepos === 'string' ? options.excludedRepos : ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A new session (or /clear) starts over, from the folder it names.
    sessionReady = undefined
    await ensureSession($, e.cwd)
    return started
  })

  // ------------------------------------------------------------ during a turn

  // Before Claude's first request: Jev reads the conversation and the new prompt; a hint rides the prompt.
  on('prompt.submit', async ($, e, next) => {
    await ensureSession($)
    // A prompt delivered into a running turn is not a new turn's.
    if (e.turnId || !tracked()) return next(e)
    const paused = (await read($, status)).paused === true
    const arm = armFor(paused)
    const o: NonNullable<typeof opening> = { arm, jev: emptyJevTurn() }
    opening = o
    const fresh = freshChosen
    freshChosen = undefined
    if (e.text.trimStart().startsWith('/') || excluded || paused || !access) return next(e)
    const rows: MessageRow[] = [...(await conversationRows($)), { role: 'user', text: e.text, toolUses: [] }]
    // The prompt's triage runs beside the hint ask, so it adds no wait of its own.
    const triaged = effortMode !== 'off' || topicMode !== 'off' ? runTriage($, rows) : Promise.resolve(undefined)
    const hinted = arm === 'hint' || arm === 'shadow' ? consult($, o.jev, arm, rows) : Promise.resolve(undefined)
    const [t, d] = await Promise.all([triaged, hinted])
    if (!t && fresh) o.triage = { quick: false, newTopic: false, fresh }
    if (t) {
      const lowEffort = !t.quick || effortMode === 'off' ? undefined : arm === 'control' ? 'control' : effortMode === 'on' ? 'applied' : 'shadow'
      o.triage = { ...t, ...(lowEffort ? { lowEffort } : {}), ...(fresh ? { fresh } : {}) }
      // A new, self-contained task in a long conversation: offer to start fresh instead of re-reading it all.
      if (t.newTopic && !fresh && topicMode !== 'off' && !e.attachments?.length) {
        const size = await contextTokens($)
        if (size >= TOPIC_MIN_TOKENS) {
          const choice = await ask(
            $,
            `This looks like a new task that needs nothing from this conversation. Every request re-reads the ${tokens(size)} tokens it holds now. Start fresh?`,
            Object.values(FRESH_OPTIONS),
            'New task',
          )
          const how = choice === FRESH_OPTIONS.clear ? 'clear' : choice === FRESH_OPTIONS.compact ? 'compact' : undefined
          if (how) {
            opening = undefined
            freshFrom = size
            freshStart($, how, e.text)
            return { drop: `Jev: ${how === 'clear' ? 'clearing the conversation' : 'compacting the conversation'}, then sending your prompt again.` }
          }
          o.triage.fresh = choice === FRESH_OPTIONS.keep ? 'kept' : 'dismissed'
        }
      }
    }
    if (!d || d.mode !== 'hint' || !d.tool) return next(e)
    o.pending = d.tool
    return arm === 'hint' ? next({ ...e, context: [...(e.context ?? []), hintText(d.tool)] }) : next(e)
  })

  // The skill listing Claude reads on every request: skills the project is unlikely to need keep only their name.
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    await ensureSession($)
    if (skillMode === 'off' || excluded || !access) return next(e)
    const listing = parseSkillListing(e.text)
    if (!listing) return next(e)
    const gate = await decideSkills($, listing)
    if (!gate || gate.mode !== 'on' || gate.trim.length === 0) return next(e)
    return next({ ...e, text: gateListing(listing, new Set(gate.trim)) })
  })

  on('turn.start', async ($, e, next) => {
    await ensureSession($)
    if (tracked()) {
      const o = opening ?? { arm: armFor((await read($, status)).paused === true), jev: emptyJevTurn() }
      opening = undefined
      turns.set(e.turnId, { prompt: e.text, arm: o.arm, steps: 0, tools: 0, jev: o.jev, trail: newTrail(), ...(o.pending ? { pending: o.pending } : {}), ...(o.triage ? { triage: o.triage } : {}), before: await usageNow($) })
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
    // A quick status question runs at low effort; the same model, and back to the session's effort once it grows.
    let request = e
    if (turn.triage?.lowEffort === 'applied' && e.effort !== undefined) {
      if (turn.steps <= LOW_EFFORT_STEPS) request = { ...e, effort: 'low' }
      else turn.triage.lowEffort = 'exited'
    }
    let calls = -1
    try {
      const result = yield* next(request)
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
    // What the call did for verification: a change, a run, a look (a refused call did nothing).
    if (result.deny === undefined) noteCall(turn.trail, verifyRole(call.tool, e as unknown as Record<string, unknown>))
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

  // Claude's stop: a promise of more work with nothing running sends it back to work; then changes
  // nothing ran or looked at send it back once to check them.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    await ensureSession($)
    const turn = current ? turns.get(current) : undefined
    // The main loop only, Jev's turns only, and never a stop another hook already refused.
    if (e.agent_id || !turn || turn.arm === 'excluded' || result.block) return result
    // The done check: never on a stop that a push already caused.
    if (doneMode !== 'off' && !e.stop_hook_active) {
      const done = checkStop($, e)
      turn.done = done
      const d = await done
      if (d.pushed) {
        $.ui.toast('Jev: Claude stopped on a promise with nothing running, so it was sent back to work.')
        return { ...result, block: DONE_NUDGE }
      }
    }
    // Verify: once per turn, not while work runs on, nor when Claude ends on a question to the person.
    if (verifyMode === 'off' || turn.verifyPushed) return result
    const need = verifyNeed(turn.trail)
    const pending = (e.background_tasks ?? []).some(t => t.status === 'running' || t.status === 'pending')
    if (!need || pending || (e.last_assistant_message ?? '').trim().endsWith('?')) return result
    turn.verifyPushed = need
    $.ui.toast(need === 'look' ? 'Jev: Claude changed a screen without looking at it, so it was sent back to check.' : 'Jev: Claude changed files and nothing ran since, so it was sent back to check.')
    return { ...result, block: verifyNudge(need, turn.trail) }
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
    await ensureSession($)
    const opened = await $.ui.open({ id: PANE, title: 'Jev' })
    return { text: opened.isPlaced ? 'Jev pane opened.' : 'Jev pane: widen the terminal to see it.' }
  })

  on('command.run', { command: 'jev-setup' }, async $ => {
    await ensureSession($)
    return { text: await setup($, sessionCwd) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await ensureSession($)
    return drawPane($, e)
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await ensureSession($)
    return drawBand($, e, () => next(e))
  })
}
