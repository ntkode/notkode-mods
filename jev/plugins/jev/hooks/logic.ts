import type { JevBoard, JevEconomy } from '../types'

// Pure parts of the mod: what Jev is asked, how its answer becomes a hint, the key file, the log
// and the report. Nothing here touches `$`, so tests run it as is.
//
// Before each of Claude's requests the mod asks Jev, TypeSafe's fast decision model, which tool
// fits next. When Jev is confident and its two answers agree, the mod adds one line for Claude:
// a hint, which Claude is free to ignore. The questions, the rule and the hint's wording are
// ported from jev-gateway (github.com/vinilana/jev-gateway, MIT), whose Claude Code path only
// ever hints: with thinking on, the API refuses a forced tool.

// ---------------------------------------------------------------- where Jev runs

/** Where Jev can be reached; the table jev-gateway uses (its providers.json). */
export const PROVIDERS = {
  typesafe: { label: 'TypeSafe', keyEnv: 'TYPESAFE_API_KEY', keyUrl: 'https://typesafe.ai', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' },
  openrouter: { label: 'OpenRouter', keyEnv: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/settings/keys', url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' },
  vercel: { label: 'Vercel AI Gateway', keyEnv: 'AI_GATEWAY_API_KEY', keyUrl: 'https://vercel.com/dashboard/ai-gateway/api-keys', url: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', model: 'typesafe-ai/jev' },
  opencode: { label: 'OpenCode (free model)', keyEnv: 'OPENCODE_API_KEY', keyUrl: 'https://opencode.ai/auth', url: 'https://opencode.ai/zen/v1/systemone', model: 'jev-1.13-free', paidModel: 'jev-1.13' },
} as const
export type Provider = keyof typeof PROVIDERS
const PROVIDER_IDS = Object.keys(PROVIDERS) as Provider[]

/** How long one Jev call may take before the request goes on without a hint. */
export const JEV_TIMEOUT_MS = 4000
/** Jev must be at least this sure before Claude gets a hint (jev-gateway's default). */
export const MIN_CONFIDENCE = 0.7

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

/** Sets `values` in a `.env` file's text, replacing lines that exist and keeping everything else. */
export function upsertEnv(text: string, values: Record<string, string>): string {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  for (const [name, value] of Object.entries(values)) {
    const line = `${name}=${value}`
    const at = lines.findIndex(existing => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(existing))
    if (at >= 0) lines[at] = line
    else lines.push(line)
  }
  return lines.join('\n') + '\n'
}

/** The key, endpoint and model the mod calls Jev with. */
export type JevAccess = { provider: Provider; key: string; url: string; model: string }

/**
 * Which provider and key to use, by jev-gateway's rule: an explicit JEV_PROVIDER, else whichever
 * key is there. The process environment wins over the key file.
 */
export function jevAccess(file: Record<string, string>, env: Record<string, string | undefined>): JevAccess | undefined {
  const merged: Record<string, string | undefined> = { ...file }
  for (const [name, value] of Object.entries(env)) if (value?.trim()) merged[name] = value
  const keyOf = (id: Provider) => merged[PROVIDERS[id].keyEnv]?.trim()
  const chosen = merged.JEV_PROVIDER?.trim().toLowerCase()
  const provider = PROVIDER_IDS.find(p => p === chosen) ?? PROVIDER_IDS.find(p => keyOf(p))
  const key = provider && keyOf(provider)
  if (!provider || !key) return undefined
  const p = PROVIDERS[provider]
  const requested = merged.JEV_MODEL?.trim()
  // A model id belongs to one provider's namespace: TypeSafe's have no slash, the resellers' do.
  const fits = requested
    ? provider === 'opencode'
      ? requested === PROVIDERS.opencode.model || requested === PROVIDERS.opencode.paidModel
      : requested.includes('/') === (provider !== 'typesafe')
    : false
  const base = provider === 'typesafe' ? merged.TYPESAFE_BASE_URL?.trim() : undefined
  const url = merged.JEV_URL?.trim() || (base ? `${base.replace(/\/+$/, '')}/v1/systemone` : p.url)
  return { provider, key, url, model: fits ? requested! : p.model }
}

export function isValidKey(key: string): boolean {
  return /^[A-Za-z0-9._\-]{20,300}$/.test(key)
}

// ---------------------------------------------------------------- what Jev reads

/** One turn as Jev reads it: prose, a tool call, or a tool's result. */
export type StateTurn =
  | { role: 'user' | 'assistant'; text: string }
  | { role: 'assistant'; tool_calls: { tool: string; arguments: string }[] }
  | { role: 'tool_result'; tool: string; content: string }

export type JevState = { assistant_instructions?: string; earlier_turns_omitted?: number; conversation: StateTurn[] }

/** The parts of a conversation row the state is built from (`$.session.messages()` rows). */
export type MessageRow = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool_use_id: string; tool: string; input: unknown; text?: string }[]
}

export const MAX_STATE_CHARS = 60_000
export const MAX_MESSAGE_CHARS = 4_000

/** Keeps the head and tail of long text; the middle matters least for picking a tool. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const marker = ' …[truncated]… '
  const keep = Math.max(0, max - marker.length)
  const head = Math.ceil(keep * 0.6)
  return text.slice(0, head) + marker + text.slice(text.length - (keep - head))
}

/**
 * The conversation as Jev reads it: prose, then each tool call and its result, in order. `results`
 * holds results the conversation has not stored yet (the call whose hook is asking).
 */
export function turnsFrom(rows: readonly MessageRow[], results: Readonly<Record<string, string>> = {}): StateTurn[] {
  const clip = (text: string) => truncate(text, MAX_MESSAGE_CHARS)
  const turns: StateTurn[] = []
  for (const row of rows) {
    if (row.text.trim()) turns.push({ role: row.role, text: clip(row.text) })
    if (row.role !== 'assistant') continue
    for (const use of row.toolUses) {
      turns.push({ role: 'assistant', tool_calls: [{ tool: use.tool, arguments: clip(JSON.stringify(use.input ?? {})) }] })
      const text = use.text ?? results[use.tool_use_id]
      if (text !== undefined) turns.push({ role: 'tool_result', tool: use.tool, content: clip(text) })
    }
  }
  return turns
}

/** The newest turns that fit the budget, after the system prompt's head and tail. */
export function buildState(turns: readonly StateTurn[], system?: string): JevState {
  const instructions = system ? truncate(system, MAX_MESSAGE_CHARS) : ''
  let budget = MAX_STATE_CHARS - instructions.length
  const conversation: StateTurn[] = []
  for (let i = turns.length - 1; i >= 0; i--) {
    budget -= JSON.stringify(turns[i]).length
    if (budget < 0 && conversation.length > 0) break
    conversation.unshift(turns[i]!)
  }
  const omitted = turns.length - conversation.length
  return { ...(instructions ? { assistant_instructions: instructions } : {}), ...(omitted ? { earlier_turns_omitted: omitted } : {}), conversation }
}

// ---------------------------------------------------------------- what Jev is asked

export type Tool = { name: string; description: string }

export const NO_TOOL = 'no_tool_needed'
const NONE_OF_THESE = 'none_of_these'
export const TOOL_KEY = 'tool'
export const NEEDS_TOOL_KEY = 'needs_tool'
/** Most tools one question may offer; a bigger roster is shortlisted first. */
export const MAX_TOOLS = 120
const SHORTLIST_PER_SHARD = 3
const MAX_DESCRIPTION_CHARS = 1024
const QUESTION_CHAR_BUDGET = 48_000
/** A tool name goes into text the model reads, so it must stay one inert token. */
const SAFE_TOOL_NAME = /^[\p{L}\p{N}_.:/-]{1,128}$/u

export type Question = { type: 'choice'; instructions: string; criteria: Record<string, string | null> } | { type: 'noul'; instructions: string }
export type Answer = { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> } | { type: 'noul'; noul: number }

/** Why a request is not Jev's to decide, or undefined when it is. */
export function skipReason(tools: readonly Tool[], turns: readonly StateTurn[]): string | undefined {
  if (turns.length === 0) return 'no_messages'
  if (tools.length === 0) return 'no_tools'
  if (tools.length > MAX_TOOLS * 255) return 'too_many_tools'
  if (tools.some(t => !SAFE_TOOL_NAME.test(t.name))) return 'unsafe_tool_name'
  if (new Set(tools.map(t => t.name)).size !== tools.length) return 'duplicate_tool_names'
  if (tools.some(t => t.name === NO_TOOL)) return 'reserved_tool_name'
  return undefined
}

function toolCriteria(tools: readonly Tool[]): Record<string, string | null> {
  const limit = Math.min(MAX_DESCRIPTION_CHARS, Math.floor(QUESTION_CHAR_BUDGET / tools.length))
  return Object.fromEntries(tools.map(t => [t.name, t.description.trim().slice(0, limit) || null]))
}

/** The two questions: which tool, and whether a tool is needed at all. */
export function toolQuestions(tools: readonly Tool[]): Record<string, Question> {
  return {
    [TOOL_KEY]: {
      type: 'choice',
      instructions: "Given the conversation, what should the assistant do next? Pick the single tool whose call best advances the user's latest request.",
      criteria: {
        ...toolCriteria(tools),
        [NO_TOOL]:
          'No tool call is needed right now: the assistant should reply to the user in plain text (answer directly, ask a clarifying question, or report results that tools already returned).',
      },
    },
    [NEEDS_TOOL_KEY]: {
      type: 'noul',
      instructions: 'Does the assistant need to call one of its tools now, rather than reply to the user in plain text?',
    },
  }
}

/** A first pass over a roster too big for one question: every shard ranked in the same call. */
export function shortlistQuestions(tools: readonly Tool[]): { questions: Record<string, Question>; shards: Tool[][] } {
  const count = Math.ceil(tools.length / MAX_TOOLS)
  const size = Math.ceil(tools.length / count)
  const shards = Array.from({ length: count }, (_, i) => tools.slice(i * size, (i + 1) * size))
  const questions: Record<string, Question> = {}
  shards.forEach((shard, i) => {
    questions[`shard:${i}`] = {
      type: 'choice',
      instructions: "Given the conversation, which of these tools would best advance the user's latest request if the assistant called it next?",
      criteria: { ...toolCriteria(shard), [NONE_OF_THESE]: 'None of the tools in this list fits the next step.' },
    }
  })
  return { questions, shards }
}

/** The strongest few tools of every shard. */
export function shortlisted(shards: readonly Tool[][], answers: Readonly<Record<string, Answer>>): Tool[] {
  return shards.flatMap((shard, i) => {
    const answer = answers[`shard:${i}`]
    if (answer?.type !== 'choice') return []
    const ranked = Object.entries(answer.probabilities)
      .filter(([name]) => name !== NONE_OF_THESE)
      .sort(([, a], [, b]) => b - a)
      .slice(0, SHORTLIST_PER_SHARD)
      .map(([name]) => name)
    return shard.filter(t => ranked.includes(t.name))
  })
}

/** Jev's answers, checked; a choice without a confidence takes its winning probability. */
export function normalizeAnswers(raw: unknown): Record<string, Answer> {
  const out: Record<string, Answer> = {}
  for (const [name, a] of Object.entries((raw ?? {}) as Record<string, Record<string, unknown> | undefined>)) {
    if (a?.type === 'noul' && typeof a.noul === 'number') out[name] = { type: 'noul', noul: a.noul }
    else if (a?.type === 'choice' && typeof a.choice === 'string') {
      const probabilities = (a.probabilities ?? {}) as Record<string, number>
      const values = Object.values(probabilities)
      const confidence = typeof a.confidence === 'number' ? a.confidence : values.length ? Math.max(...values) : 0
      out[name] = { type: 'choice', choice: a.choice, confidence, probabilities }
    }
  }
  return out
}

/** What the mod does with Jev's answer: hint a tool, or leave the choice to Claude (and why). */
export type Decision = { mode: 'hint' | 'pass'; tool?: string; confidence?: number; reason?: string }

/** jev-gateway's rule: confident, and the two answers agree; "no tool" is never hinted. */
export function decide(tools: readonly Tool[], answers: Readonly<Record<string, Answer>>, minConfidence = MIN_CONFIDENCE): Decision {
  const picked = answers[TOOL_KEY]
  const needs = answers[NEEDS_TOOL_KEY]
  if (picked?.type !== 'choice' || needs?.type !== 'noul') return { mode: 'pass', reason: 'jev_unexpected_answer' }
  const confidence = picked.confidence
  if (confidence < minConfidence) return { mode: 'pass', reason: 'low_confidence', confidence }
  const wantsTool = picked.choice !== NO_TOOL
  if (wantsTool ? needs.noul < 0.3 : needs.noul > 0.7) return { mode: 'pass', reason: 'jev_answers_disagree', confidence }
  // A hint can suggest a tool; suggesting silence would only risk ending a turn early.
  if (!wantsTool) return { mode: 'pass', reason: 'no_tool_needed', confidence }
  if (!tools.some(t => t.name === picked.choice)) return { mode: 'pass', reason: 'jev_unknown_tool', confidence }
  return { mode: 'hint', tool: picked.choice, confidence }
}

/** The line Claude reads: jev-gateway's wording, free to disagree. */
export function hintText(tool: string): string {
  return `A tool-routing model suggests the "${tool}" tool is the most relevant next step. Ignore this if it does not fit what the user actually asked for.`
}

// ---------------------------------------------------------------- saying it

/** Why Jev left the choice to Claude, in plain words. */
export const REASON_TEXT: Record<string, string> = {
  low_confidence: 'Jev was unsure',
  jev_answers_disagree: "Jev's two checks disagreed",
  no_tool_needed: 'no tool needed',
  no_tools: 'no tools in the request',
  no_messages: 'empty conversation',
  jev_unknown_tool: 'Jev named an unknown tool',
  jev_unexpected_answer: 'unexpected Jev answer',
  jev_error: 'Jev failed',
  jev_timeout: 'Jev too slow',
  too_many_tools: 'too many tools',
  unsafe_tool_name: 'a tool name it cannot use',
  duplicate_tool_names: 'duplicate tool names',
}

export function reasonText(reason: string | undefined): string {
  if (!reason) return 'passed'
  const key = reason.split(':')[0]!
  return REASON_TEXT[key] ?? key.replace(/_/g, ' ')
}

/** One decision as the band says it. */
export function decisionText(d: Decision, shadow = false): string {
  const sure = d.confidence !== undefined ? ` ${d.confidence.toFixed(2)}` : ''
  if (d.mode === 'hint') return shadow ? `Jev would hint ${d.tool}${sure} (shadow)` : `Jev hinted ${d.tool}${sure}`
  return `Jev left it to Claude · ${reasonText(d.reason)}`
}

/** The card the decision runs to Claude as: a hint, the choice left to Claude, or Jev failing. */
export type DecisionCard = 'pick' | 'pass' | 'fail'

export function cardFor(d: Pick<Decision, 'mode' | 'reason'>): DecisionCard {
  if (d.mode === 'hint') return 'pick'
  return /^jev_(error|timeout)\b/.test(d.reason ?? '') ? 'fail' : 'pass'
}

// ---------------------------------------------------------------- one turn's decisions

/**
 * How a turn is run: `hint` (Jev is asked, Claude gets its hints), `control` (Jev sits it out:
 * the comparison group), `shadow` (Jev is asked, nothing reaches Claude).
 */
export type Arm = 'hint' | 'control' | 'shadow'

export function pickArm(mode: 'on' | 'shadow', controlPercent: number, roll: number): Arm {
  if (mode === 'shadow') return 'shadow'
  return roll * 100 < controlPercent ? 'control' : 'hint'
}

/** Jev's decisions during one turn. */
export type JevTurn = {
  asked: number
  hinted: number
  /** Hints Claude acted on: it called the hinted tool before Jev was asked again. */
  followed: number
  picks: { tool: string; confidence: number }[]
  reasons: Record<string, number>
  ms: number[]
  /** Who decided each request, in order. */
  cards: DecisionCard[]
  /** What the calls to Jev cost, in US dollars, as the provider reported it. */
  usd: number
  /** Calls whose provider reported no price (they count in `asked`, not in `usd`). */
  unpriced: number
}

/** What one ask's calls to Jev cost; `usd` stays undefined while no call reported a price. */
export type Spend = { usd?: number; calls: number; priced: number }

export function emptyJevTurn(): JevTurn {
  return { asked: 0, hinted: 0, followed: 0, picks: [], reasons: {}, ms: [], cards: [], usd: 0, unpriced: 0 }
}

export function tally(turn: JevTurn, d: Decision, ms: number, spend?: Spend): void {
  turn.asked++
  if (spend) {
    turn.usd += spend.usd ?? 0
    turn.unpriced += spend.calls - spend.priced
  }
  if (turn.ms.length < 200) turn.ms.push(Math.round(ms))
  if (turn.cards.length < 200) turn.cards.push(cardFor(d))
  if (d.mode === 'hint' && d.tool) {
    turn.hinted++
    if (turn.picks.length < 50) turn.picks.push({ tool: d.tool, confidence: d.confidence ?? 0 })
  } else {
    const reason = (d.reason ?? 'passed').split(':')[0]!
    turn.reasons[reason] = (turn.reasons[reason] ?? 0) + 1
  }
}

// ---------------------------------------------------------------- the done check

/**
 * When Claude stops, Jev reads whether its final message promises more work. If it does, the user
 * asked for work, Claude is not waiting on the user, and nothing it started is still running, the
 * stop is a broken promise. Backtested on 14 days of turns (research/results/08-done-check.md):
 * these three questions at 0.9 pushed none of 400 normal turns; "is it finished?" fails.
 */
export const DONE_QUESTIONS: Record<'requested' | 'waiting' | 'promised', Question> = {
  requested: {
    type: 'noul',
    instructions: "Did the user's LATEST message ask the assistant to do work (make changes, run commands, deploy, investigate, build or produce something), rather than only ask a question or chat?",
  },
  waiting: {
    type: 'noul',
    instructions:
      'Is the assistant genuinely waiting on the user: it needs a decision between options, approval for a risky or irreversible step, a credential, an action only the user can take, or information only the user has?',
  },
  promised: {
    type: 'noul',
    instructions: "Does the assistant's FINAL message say it will do something next, or that work is still under way, instead of reporting the work as finished?",
  },
}

/** How sure Jev must be that more work was promised (and not that Claude is waiting on the user). */
export const DONE_CONFIDENCE = 0.9

/**
 * What the done check made of a stop: `push` (a broken promise: Claude should carry on), `ok`,
 * `running` (background work or a scheduled wake-up keeps the promise, so Jev was not asked),
 * or `error` (Jev failed or was too slow: the stop goes through).
 */
export type DoneVerdict = 'push' | 'ok' | 'running' | 'error'

export type DoneCheck = {
  verdict: DoneVerdict
  /** Whether the stop was really refused (mode on), or only recorded (shadow). */
  pushed: boolean
  requested?: number
  waiting?: number
  promised?: number
  ms?: number
  usd?: number
  reason?: string
}

export function doneVerdict(answers: Readonly<Record<string, Answer>>, at = DONE_CONFIDENCE): Omit<DoneCheck, 'pushed' | 'ms' | 'usd'> {
  const noul = (k: string) => {
    const a = answers[k]
    return a?.type === 'noul' ? a.noul : undefined
  }
  const requested = noul('requested')
  const waiting = noul('waiting')
  const promised = noul('promised')
  if (requested === undefined || waiting === undefined || promised === undefined) return { verdict: 'error', reason: 'jev_unexpected_answer' }
  const push = requested >= 0.5 && waiting < 1 - at && promised >= at
  return { verdict: push ? 'push' : 'ok', requested, waiting, promised }
}

/** What Claude reads when a stop is refused: the promise, and a way out when something does block it. */
export const DONE_NUDGE =
  "Your last message says more work is coming, but nothing you started is still running and you are not waiting on the user. Carry on with the remaining work now. If something does block you, say plainly what it is and what you need."

/** The done check in plain words, for the pane. */
export function doneText(d: Pick<DoneCheck, 'verdict' | 'pushed'>, shadow: boolean): string {
  switch (d.verdict) {
    case 'push':
      return d.pushed ? 'Claude stopped on a promise; Jev sent it back to work' : `Claude stopped on a promise; Jev would send it back to work${shadow ? ' (shadow)' : ''}`
    case 'running':
      return 'Claude left work running; no check needed'
    case 'ok':
      return 'Claude stopped with nothing promised'
    case 'error':
      return 'Jev could not check the stop'
  }
}

// ---------------------------------------------------------------- triage: effort and topic switches

/** The effort classes Jev chooses from (as backtested in research/results/02-fast-lane-cross-check.md). */
export const EFFORT_CRITERIA: Record<string, string> = {
  status: 'A quick question about state or status that needs a short lookup and a short answer, little reasoning: "is it in prod?", "are we done?", "what is next?", "did it work?".',
  routine: 'Small, mechanical work with an obvious approach: run a known command, commit or push, a tiny edit, rename, or approving a step whose remaining work is small. Read the conversation: "yes" that approves a big build is NOT routine.',
  standard: 'Normal engineering or writing work with some investigation: implement or change a feature, fix a specific bug, write a document, analyze data.',
  hard: 'Needs deep, careful reasoning: architecture or design decisions, subtle or multi-system bugs, large refactors, ambiguous requirements, security, or analysis where a wrong call is costly.',
}

/** One call per prompt: how much reasoning it needs, and whether it opens a new, unrelated task. */
export const TRIAGE_QUESTIONS: Record<'effort' | 'quick' | 'newTopic' | 'needsEarlier', Question> = {
  effort: {
    type: 'choice',
    instructions: "How much reasoning will the coding assistant need to answer the user's LATEST message well? Judge by the work it triggers, using the conversation for context, not by how long the message is.",
    criteria: EFFORT_CRITERIA,
  },
  quick: {
    type: 'noul',
    instructions:
      "Is the user's latest message a quick question about status or state (is it deployed, did it work, are we done, what is next) that the assistant can answer with a short look-up, WITHOUT doing new work such as building, fixing, writing, running a process, or opening something?",
  },
  newTopic: { type: 'noul', instructions: "Does the user's LATEST message start a new task, unrelated to what the earlier conversation was about?" },
  needsEarlier: {
    type: 'noul',
    instructions: "To do what the LATEST message asks, does the assistant need anything from the earlier conversation: something said, done, decided or found there, or a reference to it ('that', 'the same', 'as before')?",
  },
}

/** Both checks must clear this before a turn runs at low effort (the backtested rule: 3.7% turned out heavy). */
export const QUICK_CONFIDENCE = 0.7
/** A low-effort turn that grows past this many requests goes back to the session's effort. */
export const LOW_EFFORT_STEPS = 8
/** Jev must be this sure of a new, self-contained task before a fresh start is offered. */
export const TOPIC_CONFIDENCE = 0.9
/** A fresh start is offered only when the context holds at least this many tokens (the fixed base alone is 30–55k). */
export const TOPIC_MIN_TOKENS = 100_000

export type Triage = {
  /** A quick status question: run the turn at low effort. */
  quick: boolean
  /** A new task that needs nothing from the conversation so far. */
  newTopic: boolean
  effort?: string
  effortConfidence?: number
  quickP?: number
  newTopicP?: number
  needsEarlierP?: number
}

export function triage(answers: Readonly<Record<string, Answer>>): Triage {
  const noul = (k: string) => {
    const a = answers[k]
    return a?.type === 'noul' ? a.noul : undefined
  }
  const e = answers.effort?.type === 'choice' ? answers.effort : undefined
  const quickP = noul('quick')
  const newTopicP = noul('newTopic')
  const needsEarlierP = noul('needsEarlier')
  return {
    quick: e?.choice === 'status' && e.confidence >= QUICK_CONFIDENCE && (quickP ?? 0) >= QUICK_CONFIDENCE,
    newTopic: (newTopicP ?? 0) >= TOPIC_CONFIDENCE && (needsEarlierP ?? 1) <= 1 - TOPIC_CONFIDENCE,
    ...(e ? { effort: e.choice, effortConfidence: e.confidence } : {}),
    ...(quickP !== undefined ? { quickP } : {}),
    ...(newTopicP !== undefined ? { newTopicP } : {}),
    ...(needsEarlierP !== undefined ? { needsEarlierP } : {}),
  }
}

// ---------------------------------------------------------------- the skill gate

/** One skill of the listing Claude reads: its name and the whole entry as the engine wrote it. */
export type SkillEntry = { name: string; entry: string }

/** The listing's entries (`- name: description`, descriptions may span lines); undefined when it is not that shape. */
export function parseSkillListing(text: string): { head: string; entries: SkillEntry[] } | undefined {
  const lines = text.split('\n')
  const head: string[] = []
  const entries: SkillEntry[] = []
  for (const line of lines) {
    // A skill's name has no spaces and may carry one plugin prefix (`codex:rescue`).
    const m = /^- ([\w.-]+(?::[\w.-]+)?): /.exec(line)
    if (m) entries.push({ name: m[1]!, entry: line })
    else if (entries.length > 0) entries[entries.length - 1]!.entry += `\n${line}`
    else head.push(line)
  }
  return entries.length >= 3 ? { head: head.join('\n'), entries } : undefined
}

/** A skill must be at least this likely to matter to keep its description; the rest keep their name. */
export const SKILL_KEEP = 0.5

/** One question per skill: will this project's work use it? */
export function skillQuestions(entries: readonly SkillEntry[]): Record<string, Question> {
  return Object.fromEntries(
    entries.map((e, i) => [
      `skill:${i}`,
      {
        type: 'noul',
        instructions: `Is the assistant likely to need this skill for work in this project? ${truncate(e.entry.replace(/^- /, ''), 600)}`,
      },
    ]),
  )
}

/** The names of the skills Jev judged unlikely to matter; any skill Jev did not answer for stays. */
export function skillsToTrim(entries: readonly SkillEntry[], answers: Readonly<Record<string, Answer>>, keep = SKILL_KEEP): string[] {
  return entries.filter((e, i) => {
    const a = answers[`skill:${i}`]
    return a?.type === 'noul' && a.noul < keep
  }).map(e => e.name)
}

/** The listing with the trimmed skills reduced to their names: still listed, still callable. */
export function gateListing(listing: { head: string; entries: readonly SkillEntry[] }, trim: ReadonlySet<string>): string {
  const body = listing.entries.map(e => (trim.has(e.name) ? `- ${e.name}` : e.entry))
  return [...(listing.head ? [listing.head] : []), ...body].join('\n')
}

/** Tokens in a text, roughly (for the pane's before/after). */
export function approxTokens(text: string): number {
  return Math.round(text.length / 4)
}

// ---------------------------------------------------------------- the log

export type TurnRecord = {
  type: 'turn'
  v: 4
  at: number
  session: string
  project: string
  turnId: string
  prompt: string
  arm: Arm | 'excluded' | 'off'
  actual: {
    steps: number
    durationMs: number
    reason: string
    tools: number
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
    /** What Claude's requests this turn cost, in US dollars at API prices (the session's cost before and after). */
    usd?: number
    /** Points of the weekly quota the session's account used during the turn (other sessions' use included). */
    weekPct?: number
    /** The weekly quota used at the end of the turn, in percent. */
    weekUsed?: number
  }
  jev?: JevTurn
  /** The done check at the turn's last stop. */
  done?: DoneCheck
  /** What Jev made of the prompt, and what the mod did with it. */
  triage?: Triage & { lowEffort?: 'applied' | 'shadow' | 'exited' | 'control'; fresh?: 'clear' | 'compact' | 'kept' | 'dismissed' }
  /** Tokens per request each feature took off the context Claude re-reads (skill gate, an earlier fresh start). */
  saved?: { skills?: number; fresh?: number }
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

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '0%')

export const MIN_GROUP = 5

export function report(records: readonly LogRecord[], days: number): string {
  const turns = records.filter(r => r.type === 'turn' && r.v === 4)
  if (turns.length === 0) return `Last ${days} days: no turns logged yet.`
  const by = (arm: TurnRecord['arm']) => turns.filter(t => t.arm === arm)
  const hint = by('hint')
  const control = by('control')
  const shadow = by('shadow')
  const rest = turns.length - hint.length - control.length - shadow.length
  const lines = [
    `Last ${days} days: ${turns.length} turns · ${hint.length} with hints · ${control.length} control · ${shadow.length} shadow${rest > 0 ? ` · ${rest} excluded or off` : ''}.`,
  ]

  const asked = [...hint, ...shadow].filter(t => t.jev && t.jev.asked > 0)
  if (asked.length > 0) {
    const all = asked.map(t => t.jev!)
    const sum = (f: (j: JevTurn) => number) => all.reduce((s, j) => s + f(j), 0)
    const tools = new Map<string, number>()
    for (const j of all) for (const p of j.picks) tools.set(p.tool, (tools.get(p.tool) ?? 0) + 1)
    const reasons = new Map<string, number>()
    for (const j of all) for (const [r, n] of Object.entries(j.reasons)) reasons.set(r, (reasons.get(r) ?? 0) + n)
    const top = (m: Map<string, number>, label = (k: string) => k) =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => `${label(k)} ${v}`)
        .join(', ')
    const ms = all.flatMap(j => j.ms)
    const hinted = hint.reduce((s, t) => s + (t.jev?.hinted ?? 0), 0)
    const followed = hint.reduce((s, t) => s + (t.jev?.followed ?? 0), 0)
    lines.push('', `Jev was asked ${sum(j => j.asked)} times and was confident on ${sum(j => j.hinted)} (${pct(sum(j => j.hinted), sum(j => j.asked))}).`)
    if (hinted > 0) lines.push(`  Claude followed ${followed} of ${hinted} hints (${pct(followed, hinted)}).`)
    if (tools.size > 0) lines.push(`  Tools Jev picked: ${top(tools)}.`)
    if (reasons.size > 0) lines.push(`  Left to Claude because: ${top(reasons, reasonText)}.`)
    if (ms.length > 0) lines.push(`  Jev's latency: p50 ${median(ms)}ms, worst ${Math.max(...ms)}ms (added before each request it is asked about).`)
    const would = shadow.reduce((s, t) => s + (t.jev?.hinted ?? 0), 0)
    if (would > 0) {
      const same = shadow.reduce((s, t) => s + (t.jev?.followed ?? 0), 0)
      lines.push(`  Shadow: Claude called the tool Jev would have hinted ${same} of ${would} times on its own (${pct(same, would)}).`)
    }
  }

  lines.push('', 'Hints vs control (no hints), per turn:')
  if (hint.length >= MIN_GROUP && control.length >= MIN_GROUP) {
    const steps = (g: readonly TurnRecord[]) => median(g.map(t => t.actual.steps))
    const output = (g: readonly TurnRecord[]) => median(g.map(t => t.actual.usage?.output ?? 0))
    const time = (g: readonly TurnRecord[]) => median(g.map(t => t.actual.durationMs))
    lines.push(`  requests per turn ${steps(hint)} vs ${steps(control)} (${change(steps(hint), steps(control))})`)
    lines.push(`  output tokens per turn ${output(hint)} vs ${output(control)} (${change(output(hint), output(control))})`)
    lines.push(`  turn time ${Math.round(time(hint) / 1000)}s vs ${Math.round(time(control) / 1000)}s (${change(time(hint), time(control))})`)
    lines.push(`  over ${hint.length} hinted and ${control.length} control turns; medians, so compare similar work.`)
  } else {
    lines.push(`  ${hint.length} turns with hints, ${control.length} control: need ${MIN_GROUP} of each. Control turns come up on their own ("Jev: control group" in /config).`)
  }
  const checked = turns.filter(t => t.done && t.done.verdict !== 'error')
  if (checked.length > 0) {
    const would = checked.filter(t => t.done!.verdict === 'push')
    const pushed = would.filter(t => t.done!.pushed)
    const running = checked.filter(t => t.done!.verdict === 'running')
    lines.push(
      '',
      `Done check: ${checked.length} stops checked · ${would.length} broken promises (${pct(would.length, checked.length)})${pushed.length < would.length ? `, ${would.length - pushed.length} only recorded (shadow)` : ''} · ${running.length} left work running.`,
    )
  }
  const low = turns.filter(t => t.triage?.lowEffort)
  const offered = turns.filter(t => t.triage?.fresh && t.triage.fresh !== 'clear' && t.triage.fresh !== 'compact')
  const fresh = turns.filter(t => t.triage?.fresh === 'clear' || t.triage?.fresh === 'compact')
  if (low.length > 0 || offered.length + fresh.length > 0) {
    const exited = low.filter(t => t.triage!.lowEffort === 'exited').length
    const shadowed = low.filter(t => t.triage!.lowEffort === 'shadow').length
    lines.push('')
    if (low.length > 0)
      lines.push(`Effort: ${low.length} quick status questions${shadowed ? ` (${shadowed} only recorded)` : ' ran at low effort'} · ${exited} grew and went back to your effort · median ${median(low.map(t => t.actual.steps))} requests.`)
    if (offered.length + fresh.length > 0) lines.push(`Fresh start: offered ${offered.length + fresh.length} times on a new task · taken ${fresh.length}.`)
  }
  lines.push('', ...economyLines(economy(records, days)))
  return lines.join('\n')
}

// ---------------------------------------------------------------- spend and savings

/**
 * What the last days cost, and what hints saved against control turns. The saving is an estimate:
 * median turn with hints vs median control turn, times the turns with hints, converted into
 * weekly quota at the rate the account's turns have used it (quota points per dollar).
 */
export type Economy = JevEconomy

export function economy(records: readonly LogRecord[], days: number): Economy {
  const turns = records.filter(r => r.type === 'turn' && r.v === 4)
  const hint = turns.filter(t => t.arm === 'hint')
  const control = turns.filter(t => t.arm === 'control')
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
  const rated = turns.filter(t => t.actual.usd !== undefined && t.actual.weekPct !== undefined)
  const ratedUsd = sum(rated.map(t => t.actual.usd!))
  const e: Economy = {
    days,
    turns: turns.length,
    pricedTurns: turns.filter(t => t.actual.usd !== undefined).length,
    claudeUsd: sum(turns.map(t => t.actual.usd ?? 0)),
    jevUsd: sum(turns.map(t => t.jev?.usd ?? 0)),
    jevUnpriced: sum(turns.map(t => t.jev?.unpriced ?? 0)),
    asks: sum(turns.map(t => t.jev?.asked ?? 0)),
    hintTurns: hint.length,
    controlTurns: control.length,
    ...(ratedUsd > 0 ? { weekPctPerUsd: sum(rated.map(t => t.actual.weekPct!)) / ratedUsd } : {}),
  }
  const priced = (g: readonly TurnRecord[]) => g.filter(t => t.actual.usd !== undefined)
  const h = priced(hint)
  const c = priced(control)
  if (h.length >= MIN_GROUP && c.length >= MIN_GROUP) {
    const usdPerTurn = median(c.map(t => t.actual.usd!)) - median(h.map(t => t.actual.usd!))
    const outputPerTurn = median(c.map(t => t.actual.usage?.output ?? 0)) - median(h.map(t => t.actual.usage?.output ?? 0))
    const usd = usdPerTurn * hint.length
    e.saved = {
      usdPerTurn,
      outputPerTurn,
      usd,
      output: outputPerTurn * hint.length,
      ...(e.weekPctPerUsd !== undefined ? { weekPct: usd * e.weekPctPerUsd } : {}),
      netUsd: usd - sum(hint.map(t => t.jev?.usd ?? 0)),
    }
  }
  return e
}

/** `$0.0042`, `$1.27`, `$214`. */
export function dollars(usd: number): string {
  const a = Math.round(Math.abs(usd) * 1e6) / 1e6
  const text = a >= 100 ? a.toFixed(0) : a >= 1 ? a.toFixed(2) : a >= 0.01 ? a.toFixed(3) : a.toFixed(4)
  return `${usd < 0 ? '-' : ''}$${text}`
}

/** What Jev cost: `$0.0042`, or that its provider prices nothing (a free model). */
export function jevCost(usd: number, unpriced: number): string {
  if (usd === 0 && unpriced > 0) return 'not priced by the provider'
  return `${dollars(usd)}${unpriced > 0 ? ` + ${unpriced} unpriced calls` : ''}`
}

/** The spend and savings lines of the report and the pane. */
export function economyLines(e: Economy): string[] {
  const lines = [
    `Spent over ${e.pricedTurns} tracked turns: Claude ${dollars(e.claudeUsd)} at API prices · Jev ${jevCost(e.jevUsd, e.jevUnpriced)} over ${e.asks} asks.`,
  ]
  if (e.weekPctPerUsd !== undefined && e.weekPctPerUsd > 0) lines.push(`  At your account's rate, 1% of the weekly quota ≈ ${dollars(1 / e.weekPctPerUsd)} of Claude.`)
  const s = e.saved
  if (!s) {
    lines.push(`  Savings: need ${MIN_GROUP} priced turns with hints and ${MIN_GROUP} control turns (have ${e.hintTurns} and ${e.controlTurns}).`)
    return lines
  }
  const word = s.usd >= 0 ? 'saved' : 'cost'
  const quota = s.weekPct !== undefined ? `, ${Math.abs(s.weekPct).toFixed(1)}% of the weekly quota` : ''
  lines.push(
    `  Hints ${word} ≈ ${dollars(Math.abs(s.usdPerTurn))} and ${tokens(Math.abs(Math.round(s.outputPerTurn)))} output tokens per turn → ${dollars(Math.abs(s.usd))}${quota} over ${e.hintTurns} turns.`,
    `  Net of Jev: ${dollars(s.netUsd)}. An estimate: median turn with hints vs median control turn.`,
  )
  return lines
}

// ---------------------------------------------------------------- the board

/**
 * Relative weights of token types (their API price ratios), so turns of different shapes compare.
 * The account's own quota rate turns them into weekly-quota percent.
 */
export const UNIT_WEIGHTS = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 } as const

export function turnUnits(u: NonNullable<TurnRecord['actual']['usage']>): number {
  return u.input * UNIT_WEIGHTS.input + u.cacheRead * UNIT_WEIGHTS.cacheRead + u.cacheWrite * UNIT_WEIGHTS.cacheWrite + u.output * UNIT_WEIGHTS.output
}

export type FeatureKey = 'hints' | 'effort' | 'skillGate' | 'freshStart' | 'doneCheck'

/** What one feature did over the window: its share of the weekly quota saved (negative: it cost), and a few words. */
export type FeatureStat = { savedPct?: number; detail: string }

/** What the features saved together, as a share of the weekly quota; undefined while none has a figure yet. */
export function totalSaved(features: Record<string, FeatureStat>): number | undefined {
  const figures = Object.values(features).flatMap(f => (f.savedPct === undefined ? [] : [f.savedPct]))
  return figures.length > 0 ? figures.reduce((a, b) => a + b, 0) : undefined
}

export function board(records: readonly LogRecord[], days: number): JevBoard {
  const turns = records.filter(r => r.type === 'turn' && r.v === 4)
  const metered = turns.filter(t => t.actual.usage)
  const units = (t: TurnRecord) => turnUnits(t.actual.usage!)
  const rated = metered.filter(t => t.actual.weekPct !== undefined)
  const ratedUnits = rated.reduce((s, t) => s + units(t), 0)
  const rate = ratedUnits > 0 ? rated.reduce((s, t) => s + t.actual.weekPct!, 0) / ratedUnits : undefined
  const pctOf = (u: number) => (rate !== undefined ? u * rate : undefined)
  // Tokens a feature took off every request were cache reads the turn did not make.
  const readSaved = (key: 'skills' | 'fresh') => metered.reduce((s, t) => s + (t.saved?.[key] ?? 0) * t.actual.steps * UNIT_WEIGHTS.cacheRead, 0)
  /** Median turn with the feature vs median turn without it, times the turns with it. */
  const compare = (on: readonly TurnRecord[], off: readonly TurnRecord[]): number | undefined =>
    on.length >= MIN_GROUP && off.length >= MIN_GROUP ? (median(off.map(units)) - median(on.map(units))) * on.length : undefined
  const measuring = (on: number, off: number) => `measuring: ${Math.min(on, MIN_GROUP)}/${MIN_GROUP} with, ${Math.min(off, MIN_GROUP)}/${MIN_GROUP} control`

  const hint = metered.filter(t => t.arm === 'hint')
  const control = metered.filter(t => t.arm === 'control')
  const hintUnits = compare(hint, control)
  const asked = turns.reduce((s, t) => s + (t.jev?.asked ?? 0), 0)
  const hinted = turns.reduce((s, t) => s + (t.jev?.hinted ?? 0), 0)

  const quickOn = metered.filter(t => t.triage?.lowEffort === 'applied' || t.triage?.lowEffort === 'exited')
  const quickOff = metered.filter(t => t.triage?.lowEffort === 'control')
  const effortUnits = compare(quickOn, quickOff)

  const gated = metered.filter(t => (t.saved?.skills ?? 0) > 0)
  const lastGate = gated.at(-1)?.saved?.skills
  const freshTurns = turns.filter(t => t.triage?.fresh === 'clear' || t.triage?.fresh === 'compact')

  const done = turns.filter(t => t.done)
  const pushed = done.filter(t => t.done!.verdict === 'push').length

  const ms = turns.flatMap(t => t.jev?.ms ?? [])
  const failed = turns.reduce((s, t) => s + Object.entries(t.jev?.reasons ?? {}).filter(([k]) => k === 'jev_error' || k === 'jev_timeout').reduce((a, [, n]) => a + n, 0), 0)

  return {
    days,
    turns: turns.length,
    ...(rate !== undefined ? { pctPerUnit: rate } : {}),
    features: {
      hints: {
        ...(hintUnits !== undefined && rate !== undefined ? { savedPct: hintUnits * rate } : {}),
        detail: hintUnits === undefined ? `${hinted} hints · ${measuring(hint.length, control.length)}` : `${hinted} hints in ${hint.length} turns, vs ${control.length} control turns`,
      },
      effort: {
        ...(effortUnits !== undefined && rate !== undefined ? { savedPct: effortUnits * rate } : {}),
        detail: effortUnits === undefined ? `${quickOn.length} quick questions at low effort · ${measuring(quickOn.length, quickOff.length)}` : `${quickOn.length} quick questions at low effort`,
      },
      skillGate: {
        ...(gated.length > 0 ? { savedPct: pctOf(readSaved('skills')) } : {}),
        detail: gated.length > 0 ? `${tokens(lastGate ?? 0)} fewer tokens on every request` : 'no gated session yet',
      },
      freshStart: {
        ...(freshTurns.length > 0 ? { savedPct: pctOf(readSaved('fresh')) } : {}),
        detail: `${freshTurns.length} fresh starts`,
      },
      doneCheck: { detail: `${done.length} stops checked · ${pushed} broken promises` },
    },
    usage: {
      asks: asked,
      ...(ms.length > 0 ? { p50Ms: median(ms) } : {}),
      usd: turns.reduce((s, t) => s + (t.jev?.usd ?? 0), 0),
      unpriced: turns.reduce((s, t) => s + (t.jev?.unpriced ?? 0), 0),
      failed,
    },
  }
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

/** The last folder name of a path, on any platform. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** `http://127.0.0.1:8789` from a base URL that points at a gateway on this machine, else undefined. */
export function localGatewayOrigin(baseUrl: string | null | undefined): string | undefined {
  const m = /^(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+)(?:\/|$)/.exec(baseUrl?.trim() ?? '')
  return m ? m[1] : undefined
}

/** The port mod versions up to 0.4 ran jev-gateway on; a session may still point at it. */
export const OLD_GATEWAY_PORT = 8794

/** Whether a base URL points at a local gateway on `port`. */
export function isGatewayOn(baseUrl: string | null | undefined, port: number): boolean {
  const origin = localGatewayOrigin(baseUrl)
  return origin !== undefined && Number(origin.split(':').pop()) === port
}

// ---------------------------------------------------------------- formatting for the pane

/** A prompt as one clean line: pasted-image markers and runs of whitespace gone. */
export function cleanPrompt(text: string): string {
  return text
    .replace(/\[(?:Image|Pasted text) #\d+[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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
