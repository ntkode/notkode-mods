import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginState, Register, RenderElement } from 'claude-code'

import type { JevSessionView, JevTurnView } from '../types'

import {
  ANTHROPIC_UPSTREAM,
  DEFAULT_PORT,
  GATEWAY_PROVIDERS,
  GATEWAY_VERSION,
  PICK_MODES,
  cardFor,
  decisionText,
  emptyGatewayTurn,
  folderName,
  isExcluded,
  isValidKey,
  keyProvider,
  localGatewayOrigin,
  median,
  nodeVersionOk,
  parseEnvFile,
  parseLog,
  reasonText,
  report,
  tallyGateway,
  upstreamFor,
} from './logic'
import type { GatewayEvent, GatewayProvider, GatewayTurn, LogRecord, Route, TurnRecord } from './logic'
import { ANIMATED, ANSWER_FRAMES, SCENE_ROWS, TRAVEL_FRAMES, rasterCells, scenePixels } from './sprites'
import type { Card, Scene } from './sprites'

type $ = EngineInterface
type GatewayView = PluginState['jev']['gateway']

const PANE = 'jev'
const EMPTY_SESSION: JevSessionView = { turns: 0, routed: 0, requests: 0, picked: 0, fallbacks: 0 }
const lastView = atom({ plugin: 'jev', key: 'last' } as const, null)
const sessionView = atom({ plugin: 'jev', key: 'session' } as const, EMPTY_SESSION)
const gateway = atom({ plugin: 'jev', key: 'gateway' } as const, { state: 'off', routed: false })
const original = atom({ plugin: 'jev', key: 'original' } as const, { saved: false, value: null })
const phase = atom({ plugin: 'jev', key: 'phase' } as const, null)
const decision = atom({ plugin: 'jev', key: 'decision' } as const, null)

const FRAME_MS = 180
/** Frames the request spends with Jev (the packet's trip, then the owl at work) before Claude takes over. */
const ASK_FRAMES = TRAVEL_FRAMES + 4
/**
 * How long a health answer stands before the guard asks the gateway again: short, since a request
 * sent to a gateway that died since the last answer fails (a local check costs about a millisecond).
 */
const HEALTH_TTL_MS = 1000
/** How long the guard waits for /health before it calls the gateway down. */
const HEALTH_TIMEOUT_MS = 800
/** How often the watchdog looks at the gateway between requests. */
const WATCH_MS = 5000

/** A turn of the main loop, from its start to its end. */
type Turn = {
  prompt: string
  steps: number
  tools: number
  /** Requests sent through the gateway. */
  routed: number
  /** Requests sent direct because the gateway was not answering. */
  fallbacks: number
  gateway: GatewayTurn
}

/** What the gateway's /dashboard/events says about itself. */
type Router = { routing?: boolean; minConfidence?: number; recorded?: number; startedAt?: string }
type Health = { status?: string; pid?: number; upstream?: string; jev?: string }

// The options, read at each load.
let enabled = true
let port = DEFAULT_PORT
let excludedRepos = ''

// The session's facts, worked out at session.start (which a reload fires again).
let home = ''
let sessionId = ''
let project = ''
let logPath = ''
let installDir = ''
let excluded = false
/** The mod runs this gateway (false: jev-claude started it, the mod only watches). */
let managed = true
/** The gateway's address, when there is one to route through or watch. */
let origin: string | undefined
/** ANTHROPIC_BASE_URL while routed, and while direct. */
let routeUrl: string | undefined
let directUrl: string | undefined
let upstream = ANTHROPIC_UPSTREAM
/** The guard routes this session: the gateway is set up (or external), not off, not excluded. */
let wanted = false

let health: { at: number; ok: boolean } | undefined
let checking: Promise<boolean> | undefined
let starting: Promise<void> | undefined
let watchdog: { cancel: () => void } | undefined

const turns = new Map<string, Turn>()
let current: string | undefined
let writing: Promise<void> = Promise.resolve()

// The gateway's event log: the newest sequence number read, and the process it came from.
let seq = 0
let startedAt: string | undefined
let polls: Promise<void> = Promise.resolve()

// The animation: when the last tool call started (for the spark), the band's site, the timer.
let lastToolAt = 0
let bandSite: string | undefined
let ticker: { cancel: () => void } | undefined

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function lastLine(text: string): string {
  return text.trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? ''
}

async function within<T>($: $, p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, $.clock.sleep(ms).then(() => undefined, () => undefined)])
}

/** Changes some of the gateway's facts in state; the rest stay. */
function setGateway($: $, patch: Partial<GatewayView>): Promise<unknown> {
  return update($, gateway, g => ({ ...g, ...patch }))
}

// ------------------------------------------------------------ the installed gateway

function packageDir(): string {
  return `${installDir}/node_modules/jev-gateway`
}

async function isInstalled($: $): Promise<boolean> {
  try {
    const pkg = JSON.parse(await $.fs.read(`${packageDir()}/package.json`)) as { version?: string }
    return pkg.version === GATEWAY_VERSION
  } catch {
    return false
  }
}

async function nodeReady($: $): Promise<boolean> {
  try {
    const r = await $.process.run(['node', '--version'], { timeoutMs: 10_000 })
    return r.exitCode === 0 && nodeVersionOk(r.stdout)
  } catch {
    return false
  }
}

/** Installs the pinned gateway into the mod's own folder: nothing global changes. */
async function npmInstall($: $): Promise<{ ok: boolean; error?: string }> {
  const args = ['install', '--prefix', installDir, '--no-audit', '--no-fund', '--omit=dev', `jev-gateway@${GATEWAY_VERSION}`]
  let error = 'npm was not found'
  // Windows names it `npm.cmd`, which some runtimes start only through `cmd`.
  for (const npm of [['npm'], ['npm.cmd'], ['cmd', '/c', 'npm']]) {
    try {
      const r = await $.process.run([...npm, ...args], { timeoutMs: 300_000 })
      return r.exitCode === 0 ? { ok: true } : { ok: false, error: lastLine(r.stderr || r.stdout) || `npm exited ${r.exitCode}` }
    } catch (e) {
      error = message(e)
    }
  }
  return { ok: false, error }
}

/** The provider whose key the gateway will find, in the environment or in its key file. */
async function configuredKey($: $): Promise<GatewayProvider | undefined> {
  let file: Record<string, string> = {}
  try {
    file = parseEnvFile(await $.fs.read(`${home}/.jev-gateway/.env`))
  } catch {
    // no key file yet
  }
  return keyProvider(file, {
    JEV_PROVIDER: await $.env.get('JEV_PROVIDER'),
    OPENROUTER_API_KEY: await $.env.get('OPENROUTER_API_KEY'),
    TYPESAFE_API_KEY: await $.env.get('TYPESAFE_API_KEY'),
    OPENCODE_API_KEY: await $.env.get('OPENCODE_API_KEY'),
    AI_GATEWAY_API_KEY: await $.env.get('AI_GATEWAY_API_KEY'),
  })
}

/**
 * Runs the gateway's own launcher (`jev-claude --start` or `--stop`): it detaches the gateway,
 * keeps its pid and log in ~/.jev-gateway, and reads the key from there, on every platform.
 */
async function launch($: $, flag: '--start' | '--stop'): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await $.process.run(['node', `${packageDir()}/bin/jev-claude.mjs`, flag], {
      env: { JEV_CLAUDE_PORT: String(port), JEV_CLAUDE_UPSTREAM_BASE_URL: upstream },
      timeoutMs: 20_000,
    })
    return r.exitCode === 0 ? { ok: true } : { ok: false, error: lastLine(r.stderr || r.stdout) || `the launcher exited ${r.exitCode}` }
  } catch (e) {
    return { ok: false, error: message(e) }
  }
}

async function fetchHealth($: $, at: string): Promise<Health | undefined> {
  try {
    const res = await within($, $.http.fetch(`${at}/health`), HEALTH_TIMEOUT_MS)
    if (!res?.ok) return undefined
    const body = JSON.parse(res.text) as Health
    return body.status === 'ok' ? body : undefined
  } catch {
    return undefined
  }
}

/** Starts the gateway unless it already answers; one start at a time. */
function ensureStarted($: $): Promise<void> {
  starting ??= startGateway($).finally(() => {
    starting = undefined
  })
  return starting
}

async function startGateway($: $): Promise<void> {
  if (!origin) return
  await setGateway($, { state: 'starting', note: undefined })
  const launched = await launch($, '--start')
  const h = await fetchHealth($, origin)
  health = { at: await $.clock.now(), ok: h !== undefined }
  if (!h) {
    await setGateway($, { state: 'down', note: launched.error ?? 'the gateway did not start' })
    return
  }
  await setGateway($, { state: 'up', note: undefined, ...(h.pid ? { pid: h.pid } : {}) })
  await readRouter($)
}

// ------------------------------------------------------------ routing the session

/** Whether the gateway answers, asked at most every few seconds and one question at a time. */
async function isHealthy($: $): Promise<boolean> {
  const at = origin
  if (!at) return false
  const now = await $.clock.now()
  if (health && now - health.at < HEALTH_TTL_MS) return health.ok
  checking ??= fetchHealth($, at)
    .then(async h => {
      health = { at: await $.clock.now(), ok: h !== undefined }
      return h !== undefined
    })
    .catch(() => false)
    .finally(() => {
      checking = undefined
    })
  return checking
}

/** Points this session's next model requests at the gateway, or back at the API. */
async function route($: $, through: boolean): Promise<void> {
  await $.env.set('ANTHROPIC_BASE_URL', through ? routeUrl : directUrl)
  await setGateway($, { routed: through })
}

/**
 * Runs before every model request, subagents' included: routes it through the gateway when the
 * gateway answers, and straight to the API when it does not, before the request goes out.
 */
async function guard($: $, turn: Turn | undefined): Promise<boolean> {
  const g = await read($, gateway)
  if (!wanted || g.paused) return false
  if (await isHealthy($)) {
    if (!g.routed || (g.state !== 'up' && g.state !== 'external')) {
      await route($, true)
      await setGateway($, { state: managed ? 'up' : 'external', note: undefined })
    }
    if (turn) turn.routed++
    return true
  }
  if (turn) turn.fallbacks++
  await fallBack($)
  return false
}

/** The gateway stopped answering: requests go straight to the API until it is back. */
async function fallBack($: $): Promise<void> {
  const g = await read($, gateway)
  if (g.routed) await route($, false)
  // Already said, or a restart is under way and will say how it went.
  if (g.state === 'down' || g.state === 'starting') return
  await setGateway($, { state: 'down', note: managed ? 'not answering; it restarts on the next turn' : "jev-claude's gateway is not answering" })
  $.ui.toast(`Jev: the gateway stopped answering, so requests go straight to the API.${managed ? ' It restarts on the next turn.' : ''}`)
}

/** Between requests too: a gateway that dies while the session is idle is let go of before the next one. */
function watch($: $): void {
  watchdog?.cancel()
  watchdog = $.clock.every(WATCH_MS, async () => {
    const g = await read($, gateway)
    if (!wanted || !g.routed) return
    if (!(await isHealthy($))) await fallBack($)
  })
}

/**
 * Works out how this session is routed, from the options, the folder and the environment it
 * started with, and starts the gateway when the mod runs it.
 */
async function configure($: $, cwd: string): Promise<void> {
  let saved = await read($, original)
  if (!saved.saved) {
    saved = { saved: true, value: (await $.env.get('ANTHROPIC_BASE_URL')) ?? null }
    const first = saved
    await update($, original, () => first)
  }
  const value = saved.value ?? undefined
  excluded = isExcluded(cwd, excludedRepos)
  const external = localGatewayOrigin(value)
  managed = external === undefined
  origin = external ?? `http://127.0.0.1:${port}`
  routeUrl = external ? value : origin
  // A session started through jev-claude has no API address of its own: direct is the default.
  directUrl = external ? undefined : value
  upstream = upstreamFor(external ? null : value)
  wanted = false
  health = undefined

  const stay = async (state: 'off' | 'excluded' | 'not_installed' | 'no_key', note?: string, keep?: string) => {
    await $.env.set('ANTHROPIC_BASE_URL', keep)
    await update($, gateway, (g): GatewayView => ({ state, routed: false, ...(g.paused ? { paused: true } : {}), ...(note ? { note } : {}) }))
  }
  // Off: the session goes as it started (through jev-claude, if that is how it started).
  if (!enabled) return stay('off', undefined, value)
  // Excluded: never through a gateway, so the conversation never reaches Jev.
  if (excluded) return stay('excluded', undefined, directUrl)
  if (external) {
    wanted = true
    await setGateway($, { state: 'external', origin, note: undefined })
    await readRouter($)
    watch($)
    return
  }
  if (!(await isInstalled($))) return stay('not_installed', 'run /jev-setup to install it', value)
  if (!(await configuredKey($))) return stay('no_key', 'run /jev-setup to add a key for Jev', value)
  wanted = true
  await setGateway($, { origin })
  await ensureStarted($)
  watch($)
}

// ------------------------------------------------------------ the gateway's decisions

async function readRouter($: $): Promise<void> {
  if (!origin) return
  try {
    const res = await within($, $.http.fetch(`${origin}/dashboard/events?since=${Number.MAX_SAFE_INTEGER}`), 1500)
    if (!res?.ok) return
    const router = (JSON.parse(res.text) as { router?: Router }).router ?? {}
    if (router.startedAt !== startedAt) seq = router.recorded ?? 0
    startedAt = router.startedAt
    await setGateway($, { routing: router.routing, minConfidence: router.minConfidence })
  } catch {
    // the guard finds out whether it answers
  }
}

/** Reads the gateway's newest requests into the running turn; serialized, so none is read twice or skipped. */
function pollGateway($: $, turn: Turn | undefined): Promise<void> {
  const at = origin
  if (!at) return Promise.resolve()
  polls = polls
    .then(async () => {
      const res = await within($, $.http.fetch(`${at}/dashboard/events?since=${seq}`), 1500)
      if (!res?.ok) return
      const body = JSON.parse(res.text) as { router?: Router; events?: GatewayEvent[] }
      const router = body.router ?? {}
      if ((router.startedAt && router.startedAt !== startedAt) || (router.recorded !== undefined && router.recorded < seq)) {
        // The gateway restarted: it numbers requests again, after the history it replayed.
        startedAt = router.startedAt
        seq = router.recorded ?? 0
        return
      }
      let newest: GatewayEvent | undefined
      for (const event of body.events ?? []) {
        seq = Math.max(seq, event.seq)
        if (turn) tallyGateway(turn.gateway, event)
        newest = event
      }
      await update($, gateway, g => ({ ...g, routing: router.routing ?? g.routing, minConfidence: router.minConfidence ?? g.minConfidence }))
      if (newest && turn) {
        const at = await $.clock.now()
        const { mode, tool, reason } = newest
        const confidence = newest.confidence ?? newest.jev?.confidence
        await update($, decision, () => ({ mode, at, ...(tool ? { tool } : {}), ...(confidence !== undefined ? { confidence } : {}), ...(reason ? { reason } : {}) }))
      }
    })
    .catch(() => undefined)
  return polls
}

/** Switches Jev routing inside the gateway: off makes it a metering proxy, the baseline. */
async function setRouting($: $, enabled: boolean): Promise<void> {
  if (!origin) return
  try {
    const res = await $.http.fetch(`${origin}/dashboard/routing?enabled=${enabled}`, { method: 'POST' })
    if (!res.ok) {
      $.ui.toast(`Jev: the gateway did not switch routing (HTTP ${res.status})`)
      return
    }
    const body = JSON.parse(res.text) as { routing?: boolean }
    await setGateway($, { routing: body.routing ?? enabled })
  } catch (e) {
    $.ui.toast(`Jev: the gateway did not answer (${message(e)})`)
  }
}

/** Pauses or resumes routing for this session alone; the gateway keeps running. */
async function setPaused($: $, paused: boolean): Promise<void> {
  await setGateway($, { paused })
  if (paused) await route($, false)
  else if (wanted && (await isHealthy($))) await route($, true)
}

async function restart($: $): Promise<void> {
  if (!managed || !wanted) return
  await launch($, '--stop')
  health = undefined
  await ensureStarted($)
  const g = await read($, gateway)
  if (g.state === 'up' && !g.paused) await route($, true)
  $.ui.toast(g.state === 'up' ? 'Jev: gateway restarted.' : `Jev: the gateway did not start (${g.note ?? 'no answer'}).`)
}

// ------------------------------------------------------------ the band above the prompt

type SceneState = { scene: Scene; frame: number; spark: boolean; card: Card }

/** What the band shows now, from the mod's state and the clock: the same answer for a redraw and for the animation. */
async function sceneOf($: $): Promise<SceneState> {
  const g = await read($, gateway)
  const still = (scene: Scene): SceneState => ({ scene, frame: 0, spark: false, card: 'none' })
  if (g.state === 'down') return still('error')
  if ((g.state !== 'up' && g.state !== 'external') || g.paused) return still('unset')
  const step = await read($, phase)
  if (!step) return still('idle')
  const now = await $.clock.now()
  const d = await read($, decision)
  // The newest decision runs across to Claude first, then rests beside it.
  if (d) {
    const since = Math.max(0, Math.floor((now - d.at) / FRAME_MS))
    if (since < ANSWER_FRAMES) return { scene: 'answering', frame: since, spark: false, card: cardFor(d.mode) }
  }
  const frame = Math.max(0, Math.floor((now - step.at) / FRAME_MS))
  if (step.name === 'asking' && frame < ASK_FRAMES && (!d || d.at < step.at)) return { scene: 'asking', frame, spark: false, card: 'none' }
  return { scene: 'working', frame, spark: now - lastToolAt < 2 * FRAME_MS, card: d ? cardFor(d.mode) : 'none' }
}

/** Repaints the scene's cells a few times a second while the turn moves; no redraw. */
function animate($: $): void {
  if (ticker) return
  ticker = $.clock.every(FRAME_MS, async () => {
    if (!bandSite) return
    const now = await sceneOf($)
    if (!ANIMATED.has(now.scene)) return
    const art = rasterCells(scenePixels(now.scene, now.card, now.frame, now.spark))
    await $.ui.blit({ requestId: bandSite, key: 'jev-scene', cells: art.cells }).catch(() => undefined)
  })
}

function stopAnimation(): void {
  ticker?.cancel()
  ticker = undefined
}

/** Moves the turn to its next phase, which redraws the band and keeps the animation running. */
async function enter($: $, name: 'asking' | 'working' | null): Promise<void> {
  const at = await $.clock.now()
  await update($, phase, () => (name ? { name, at } : null))
  if (name) animate($)
  else stopAnimation()
}

async function drawBand($: $, e: Parameters<$['ui']['resolve']>[0] & { requestId?: string; props: { hasSurvey: boolean; maxRows: number } }, next: () => RenderElement | Promise<RenderElement>): Promise<RenderElement> {
  const g = await read($, gateway)
  if (e.props.hasSurvey || g.state === 'off' || g.state === 'excluded') return next()
  const now = await sceneOf($)
  const d = await read($, decision)
  const { Box, Text } = $.ui.resolve(e)

  const decided = d ? decisionText(d) : undefined
  const during = decided ? (
    <Text color={cardFor(d!.mode) === 'pass' ? undefined : cardFor(d!.mode) === 'direct' ? 'green' : 'cyan'} dimColor={cardFor(d!.mode) === 'pass'}>{decided}</Text>
  ) : (
    <Text dimColor>Claude working</Text>
  )
  const unset =
    g.state === 'starting' ? 'Jev starting the gateway…' : g.paused ? 'Jev paused · this session goes direct' : `Jev not set up · ${g.note ?? 'run /jev-setup'}`
  const lines: Record<Scene, RenderElement> = {
    unset: <Text dimColor>{unset}</Text>,
    idle: <Text dimColor>Jev waiting · {g.routing === false ? 'routing off (baseline)' : 'routing tools'}</Text>,
    asking: <Text color="yellow">Jev deciding…</Text>,
    answering: during,
    working: during,
    error: <Text color="red">gateway down · direct</Text>,
  }

  if (e.surface === 'terminal' && e.props.maxRows >= SCENE_ROWS) {
    const { Raster } = $.ui.resolve(e)
    bandSite = e.requestId
    const art = rasterCells(scenePixels(now.scene, now.card, now.frame, now.spark))
    return (
      <Box flexDirection="row">
        <Raster key="jev-scene" columns={art.columns} rows={art.rows} cells={art.cells} />
        <Box marginLeft={2}>{lines[now.scene]}</Box>
      </Box>
    )
  }

  return (
    <Box>
      <Text color={now.scene === 'error' ? 'red' : ANIMATED.has(now.scene) ? 'yellow' : 'cyan'}>◆ </Text>
      {lines[now.scene]}
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
  // The gateway records a request when its reply ends: give the last one a moment to land.
  if (turn.routed > 0) await $.clock.sleep(300).then(() => pollGateway($, turn))
  const routeTaken: Route = excluded ? 'excluded' : turn.routed > 0 ? 'gateway' : turn.fallbacks > 0 ? 'down' : 'direct'
  const record: TurnRecord = {
    type: 'turn',
    v: 3,
    at: await $.clock.now(),
    session: sessionId,
    project,
    turnId,
    // An excluded repo's words stay out of the log too.
    prompt: excluded ? '' : turn.prompt.slice(0, 500),
    route: routeTaken,
    actual: {
      steps: turn.steps,
      durationMs: e.durationMs,
      reason: e.reason,
      tools: turn.tools,
      ...(e.usage
        ? { usage: { input: e.usage.input_tokens, output: e.usage.output_tokens, cacheRead: e.usage.cache_read_input_tokens, cacheWrite: e.usage.cache_creation_input_tokens } }
        : {}),
    },
    ...(turn.gateway.requests > 0 ? { gateway: turn.gateway } : {}),
    ...(turn.fallbacks > 0 ? { fallbacks: turn.fallbacks } : {}),
  }
  await log($, record)
  await publish($, record)
}

/** Feeds the pane (the turn just logged, the session's totals) and returns the band to rest. */
async function publish($: $, record: TurnRecord): Promise<void> {
  const g = record.gateway
  const view: JevTurnView = {
    prompt: record.prompt.slice(0, 160),
    route: record.route,
    steps: record.actual.steps,
    durationMs: record.actual.durationMs,
    ...(record.actual.usage ? { output: record.actual.usage.output } : {}),
    ...(record.fallbacks ? { fallbacks: record.fallbacks } : {}),
    ...(g
      ? {
          gateway: {
            requests: g.requests,
            modes: g.modes,
            reasons: g.reasons,
            picks: g.picks.map(p => p.tool),
            ...(g.jevMs.length > 0 ? { jevMs: median(g.jevMs) } : {}),
          },
        }
      : {}),
  }
  const picked = g ? [...PICK_MODES].reduce((s, m) => s + (g.modes[m] ?? 0), 0) : 0
  await update($, lastView, () => view)
  await update($, sessionView, before => {
    const s = { ...EMPTY_SESSION, ...before }
    return {
      turns: s.turns + 1,
      routed: s.routed + (record.route === 'gateway' ? 1 : 0),
      requests: s.requests + (g?.requests ?? 0),
      picked: s.picked + picked,
      fallbacks: s.fallbacks + (record.fallbacks ?? 0),
    }
  })
  await update($, decision, () => null)
  await enter($, null)
}

// ------------------------------------------------------------ the pane

function counts(m: Record<string, number>, label = (k: string) => k): string {
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${label(key)} ${n}`)
    .join(' · ')
}

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

const STATE_TEXT: Record<string, { text: string; color?: string }> = {
  off: { text: 'off in /config', color: 'gray' },
  not_installed: { text: 'not installed', color: 'yellow' },
  no_key: { text: 'no key for Jev', color: 'yellow' },
  starting: { text: 'starting', color: 'yellow' },
  up: { text: 'running', color: 'green' },
  down: { text: 'down · requests go direct', color: 'red' },
  excluded: { text: 'off in this repo (excluded)', color: 'gray' },
  external: { text: "jev-claude's gateway", color: 'green' },
}

async function drawPane($: $, e: Parameters<$['ui']['resolve']>[0]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const g = await read($, gateway)
  const last = await read($, lastView)
  const session = { ...EMPTY_SESSION, ...(await read($, sessionView)) }
  const state = STATE_TEXT[g.state] ?? { text: g.state }
  const reachable = g.state === 'up' || g.state === 'external'
  const setUp = g.state === 'not_installed' || g.state === 'no_key'

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>Jev</Text>
        <Text dimColor> · jev-gateway {managed ? GATEWAY_VERSION : ''} · </Text>
        <Text color={state.color}>{state.text}</Text>
      </Text>
      {g.note ? <Text dimColor wrap="wrap">{g.note}</Text> : null}
      {origin && g.state !== 'off' && g.state !== 'excluded' && !setUp ? (
        <Text wrap="wrap">
          <Text dimColor>{origin} · this session </Text>
          <Text color={g.routed ? 'green' : 'yellow'}>{g.paused ? 'paused (direct)' : g.routed ? 'through the gateway' : 'direct'}</Text>
          {g.routing !== undefined ? (
            <Text>
              <Text dimColor> · Jev routing </Text>
              <Text color={g.routing ? 'green' : 'yellow'}>{g.routing ? 'on' : 'off (baseline)'}</Text>
            </Text>
          ) : null}
          {g.minConfidence !== undefined ? <Text dimColor> · acts at ≥ {g.minConfidence}</Text> : null}
        </Text>
      ) : null}

      <Text> </Text>
      <Text bold>Last turn</Text>
      {last === null ? (
        <Text dimColor>No turn yet.</Text>
      ) : (
        <Box flexDirection="column">
          {last.prompt ? <Text dimColor wrap="truncate-end">"{last.prompt}"</Text> : null}
          <Text dimColor wrap="truncate-end">
            {last.route === 'gateway' ? 'through the gateway' : last.route === 'down' ? 'direct (gateway down)' : last.route === 'excluded' ? 'excluded repo' : 'direct'} · {last.steps} requests ·{' '}
            {last.output !== undefined ? `${k(last.output)} output tokens · ` : ''}
            {Math.round(last.durationMs / 1000)}s{last.fallbacks ? ` · ${last.fallbacks} went direct` : ''}
          </Text>
          {last.gateway ? (
            <Box flexDirection="column">
              <Text wrap="wrap">
                <Text dimColor>modes: </Text>
                {counts(last.gateway.modes)}
                {last.gateway.jevMs !== undefined ? <Text dimColor> · Jev p50 {last.gateway.jevMs}ms</Text> : null}
              </Text>
              {Object.keys(last.gateway.reasons).length > 0 ? (
                <Text wrap="wrap">
                  <Text dimColor>left to Claude: </Text>
                  {counts(last.gateway.reasons, reasonText)}
                </Text>
              ) : null}
              {last.gateway.picks.length > 0 ? (
                <Text wrap="wrap">
                  <Text dimColor>Jev picked: </Text>
                  <Text color="cyan">{last.gateway.picks.slice(0, 10).join(', ')}</Text>
                </Text>
              ) : null}
            </Box>
          ) : null}
        </Box>
      )}

      <Text> </Text>
      <Text bold>This session</Text>
      <Text dimColor wrap="wrap">
        {session.turns} turns · {session.routed} through the gateway · {session.requests} requests seen · Jev chose the tool on {session.picked}
        {session.fallbacks > 0 ? ` · ${session.fallbacks} went direct while it was down` : ''}
      </Text>

      <Text> </Text>
      <Text dimColor wrap="wrap">
        The gateway asks Jev on every request and steers Claude only when Jev is confident. With thinking on (Claude Code's default for Opus) it can only send hints. Results depend on the model and the task: switch Jev routing off for some similar work, then compare with /jev-report.
      </Text>

      <Text> </Text>
      <Box flexDirection="row" flexWrap="wrap">
        {setUp ? (
          <Box marginRight={1}>
            <Button key="setup" hotkey="s" variant="primary" label="set up" onPress={() => void $.command.run({ command: 'jev-setup', args: '' })} />
          </Box>
        ) : null}
        {wanted ? (
          <Box marginRight={1}>
            <Button key="route" hotkey="p" label={g.paused ? 'resume routing' : 'pause routing'} onPress={() => setPaused($, !g.paused)} />
          </Box>
        ) : null}
        {reachable ? (
          <Box marginRight={1}>
            <Button key="routing" hotkey="g" label={`Jev routing: ${g.routing === false ? 'off' : 'on'}`} onPress={() => setRouting($, g.routing === false)} />
          </Box>
        ) : null}
        {wanted && managed ? (
          <Box marginRight={1}>
            <Button key="restart" hotkey="x" label="restart gateway" onPress={() => restart($)} />
          </Box>
        ) : null}
        {reachable ? (
          <Box marginRight={1}>
            <Button key="dashboard" hotkey="d" label="copy dashboard URL" onPress={press => void $.ui.copy({ text: `${origin}/dashboard`, surface: press.surface })} />
          </Box>
        ) : null}
        <Box marginRight={1}>
          <Button key="report" hotkey="r" label="report (7 days)" onPress={() => void $.command.run({ command: 'jev-report', args: '' })} />
        </Box>
        <Button key="close" role="dismiss" label="close" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    </Box>
  )
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

type Saved = { ok: boolean; ms?: number; reason?: string; refused?: boolean; freeUnavailable?: boolean }

/** Checks the key with one call to Jev and saves it to the gateway's key file, through the gateway's own code. */
async function saveKey($: $, provider: GatewayProvider, key: string, paid: boolean): Promise<Saved> {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/save-key.mjs`], {
      stdin: JSON.stringify({ root: packageDir(), provider, key, paid }),
      timeoutMs: 30_000,
    })
    try {
      return JSON.parse(lastLine(r.stdout)) as Saved
    } catch {
      return { ok: false, reason: lastLine(r.stderr) || `exit ${r.exitCode}` }
    }
  } catch (e) {
    return { ok: false, reason: message(e) }
  }
}

/** Asks for a key for Jev and saves it; undefined when the person stopped. */
async function setUpKey($: $): Promise<{ text: string; ok: boolean }> {
  const ids = Object.keys(GATEWAY_PROVIDERS) as GatewayProvider[]
  const chosen = await ask($, 'Where should the gateway reach Jev?', ids.map(id => GATEWAY_PROVIDERS[id].label), 'Jev')
  const id = ids.find(p => GATEWAY_PROVIDERS[p].label === chosen)
  if (!id) return { ok: false, text: 'Jev setup cancelled.' }
  const p = GATEWAY_PROVIDERS[id]
  const how = await ask(
    $,
    `Copy your ${p.label} API key (get one at ${p.keyUrl}), then choose "Read the clipboard". It is read once, checked with one call to Jev, saved to ~/.jev-gateway/.env (readable only by you, shared with every jev-* launcher), never shown, and the clipboard is cleared.`,
    ['Read the clipboard', 'Cancel'],
    'API key',
  )
  if (how !== 'Read the clipboard') return { ok: false, text: 'Jev setup cancelled.' }
  const clip = await readClipboard($)
  if (!clip) return { ok: false, text: `Jev setup stopped: no clipboard tool found. Run this in a terminal instead: node "${packageDir()}/bin/jev-claude.mjs" --setup` }
  if (!isValidKey(clip.text)) return { ok: false, text: 'Jev setup stopped: the clipboard does not hold an API key (one line of letters, digits, dots, dashes or underscores). Copy the key and run /jev-setup again.' }

  let saved = await saveKey($, id, clip.text, false)
  if (!saved.ok && saved.freeUnavailable) {
    const paid = await ask($, `The free Jev model is unavailable on ${p.label}. Use the paid one? Its key check may be billed.`, ['Use the paid model', 'Cancel'], 'Jev')
    if (paid !== 'Use the paid model') return { ok: false, text: 'Jev setup stopped: the free model is unavailable. Nothing was saved.' }
    saved = await saveKey($, id, clip.text, true)
  }
  if (!saved.ok) {
    return { ok: false, text: `Jev setup stopped: ${saved.refused ? `${p.label} refused that key` : 'the key check failed'} (${saved.reason ?? 'no answer'}). Nothing was saved.` }
  }
  await $.process.run(clip.clear, { stdin: '', timeoutMs: 5000 }).catch(() => undefined)
  return { ok: true, text: `Key checked (Jev answered in ${saved.ms ?? '?'}ms) and saved to ~/.jev-gateway/.env; clipboard cleared.` }
}

async function setup($: $, cwd: string): Promise<string> {
  if (!enabled) return 'Jev is off: turn on "Jev: route through jev-gateway" in /config first.'
  if (excluded) return 'This repo is in the excluded list (/config, "Jev: excluded repos"), so nothing here goes through the gateway.'
  if (!managed) return `This session runs through ${origin}, a gateway jev-claude started; the mod watches it and has nothing to set up.`
  if (!(await nodeReady($))) return 'Jev setup stopped: jev-gateway needs Node.js 22.15 or newer on your PATH (check with `node --version`).'
  const lines: string[] = []

  if (!(await isInstalled($))) {
    const yes = await ask($, `Install jev-gateway ${GATEWAY_VERSION} now? The mod runs npm install jev-gateway@${GATEWAY_VERSION} into ${installDir}; nothing global changes.`, ['Install', 'Cancel'])
    if (yes !== 'Install') return 'Jev setup cancelled: nothing was installed.'
    const installed = await npmInstall($)
    if (!installed.ok || !(await isInstalled($))) return `Jev setup stopped: npm install failed (${installed.error ?? 'the package is not where it should be'}).`
    lines.push(`Installed jev-gateway ${GATEWAY_VERSION} into ${installDir}.`)
  }

  const provider = await configuredKey($)
  const keep = provider ? await ask($, `A key for Jev is already set up (${GATEWAY_PROVIDERS[provider].label}). Keep it?`, ['Keep it', 'Set a new key']) : 'Set a new key'
  if (keep === undefined) return [...lines, 'Jev setup cancelled.'].join('\n')
  if (keep === 'Set a new key') {
    const key = await setUpKey($)
    lines.push(key.text)
    if (!key.ok) return lines.join('\n')
    // A gateway that is already running read the old key when it started.
    if (origin && (await fetchHealth($, origin))) await launch($, '--stop')
  }

  await configure($, cwd)
  const g = await read($, gateway)
  if (g.state !== 'up') return [...lines, `The gateway did not start: ${g.note ?? 'no answer'}. Try /jev-setup again, or the restart button in /jev.`].join('\n')
  if (!g.paused) await route($, true)
  lines.push(`jev-gateway is running on ${origin} → ${upstream}; this session's requests go through it from the next one. /jev shows its decisions.`)
  return lines.join('\n')
}

// ------------------------------------------------------------ hooks

export const register: Register = (on, options) => {
  enabled = options.gateway !== 'off'
  port = typeof options.port === 'number' && Number.isInteger(options.port) && options.port > 0 && options.port < 65536 ? options.port : DEFAULT_PORT
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
    installDir = `${home}/.claude/jev-mod/gateway/${GATEWAY_VERSION}`

    // A load or reload starts with no turn in flight: clear what a cut-short one left behind,
    // and a last-turn view an older version of the mod left in another shape.
    await update($, phase, () => null)
    await update($, decision, () => null)
    const last = (await read($, lastView)) as Record<string, unknown> | null
    if (last && !('route' in last)) await update($, lastView, () => null)

    await $.command.register({ name: 'jev', description: 'Open the Jev pane: jev-gateway, its decisions on the last turn, and the switches' })
    await $.command.register({ name: 'jev-setup', description: 'Install jev-gateway, add a key for Jev, and start routing this session through it' })
    await $.command.register({ name: 'jev-report', description: "What jev-gateway decided, and routing on vs off (the baseline)", argumentHint: '[days]' })

    try {
      await configure($, cwd)
    } catch (error) {
      $.ui.log(`jev: ${message(error)}`, { to: 'debug' })
    }
    return started
  })

  // ------------------------------------------------------------ during a turn

  on('turn.start', async ($, e, next) => {
    turns.set(e.turnId, { prompt: e.text, steps: 0, tools: 0, routed: 0, fallbacks: 0, gateway: emptyGatewayTurn() })
    current = e.turnId
    await update($, decision, () => null)
    // A gateway that went down gets one restart per turn; requests go direct until it answers.
    if (wanted && managed && (await read($, gateway)).state === 'down') void ensureStarted($).catch(() => undefined)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const turn = e.agentId ? undefined : turns.get(e.turnId)
    if (turn) turn.steps++
    const routed = await guard($, turn)
    if (turn && routed) await enter($, 'asking')
    const result = yield* next(e)
    if (turn && routed) {
      void pollGateway($, turn)
      void $.clock
        .sleep(400)
        .then(() => pollGateway($, turn))
        .catch(() => undefined)
    }
    return result
  })

  on('tool.call', ($, e, next) => {
    const turn = !e.agentId && current ? turns.get(current) : undefined
    if (turn) {
      turn.tools++
      void $.clock
        .now()
        .then(t => {
          lastToolAt = t
        })
        .catch(() => undefined)
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId) return next(e)
    const turn = turns.get(e.turnId)
    turns.delete(e.turnId)
    if (current === e.turnId) current = undefined
    if (turn && enabled) void finish($, e.turnId, turn, e).catch(error => $.ui.log(`jev: ${message(error)}`, { to: 'debug' }))
    else void enter($, null).catch(() => undefined)
    return next(e)
  })

  // ------------------------------------------------------------ commands and drawing

  on('command.run', { command: 'jev' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Jev' })
    return { text: opened.isPlaced ? 'Jev pane opened.' : 'Jev pane: widen the terminal to see it.' }
  })

  on('command.run', { command: 'jev-setup' }, async $ => ({ text: await setup($, cwd) }))

  on('command.run', { command: 'jev-report' }, async ($, e) => {
    const days = Math.max(1, Math.min(90, Number.parseInt(e.args.trim(), 10) || 7))
    return { text: report(await readLogs($, days), days) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => drawBand($, e, () => next(e)))
}
