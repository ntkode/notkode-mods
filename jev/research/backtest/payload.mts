// Experiment 10: does a smaller payload change Jev's tool picks?
//
// Replays real decision points (right after a batch of tool results, before Claude's next request)
// from the last 14 days of transcripts, and asks Jev the hint questions twice:
//   old: up to 60k characters of conversation, every tool (descriptions up to 1024), shortlisted
//        first when over 120 tools — what v0.9.0 sent;
//   new: up to 15k characters with the latest request pinned, deferred MCP tools the conversation
//        never named left out, descriptions up to 300 — what v0.9.1 sends.
// Scores both against the tool Claude actually called next. Runs on OpenCode's free model.
//
//   node payload.mts [points=80]      (needs tools.json: the session's $.tool.list(), see results/10)
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { buildState, decide as decideRule, reachableTools, shortlistQuestions, shortlisted, toolQuestions, turnsFrom, truncate, MAX_TOOLS, MIN_CONFIDENCE } from '../../plugins/jev/hooks/logic.ts'
import type { Answer, MessageRow, StateTurn, Tool } from '../../plugins/jev/hooks/logic.ts'
import { DATA, median, pct, pool } from './lib.mts'

const POINTS = Number(process.argv[2] ?? 80)
const OUT = `${DATA}payload.jsonl`
const TOOLS: Tool[] = JSON.parse(readFileSync(`${DATA}tools.json`, 'utf8'))
const EXCLUDE = (process.env.JEVMOD_EXCLUDE ?? '').split(',').map(s => s.trim()).filter(Boolean)
const KEY = Object.fromEntries(
  readFileSync(join(homedir(), '.jev-gateway/.env'), 'utf8').split('\n').filter(l => l.includes('=')).map(l => l.replace(/^export\s+/, '').split(/=(.*)/s).slice(0, 2)),
).OPENCODE_API_KEY!

// ---------------------------------------------------------------- what v0.9.0 sent

const OLD_STATE_CHARS = 60_000
function oldState(turns: readonly StateTurn[]) {
  let budget = OLD_STATE_CHARS
  const conversation: StateTurn[] = []
  for (let i = turns.length - 1; i >= 0; i--) {
    budget -= JSON.stringify(turns[i]).length
    if (budget < 0 && conversation.length > 0) break
    conversation.unshift(turns[i]!)
  }
  const omitted = turns.length - conversation.length
  return { ...(omitted ? { earlier_turns_omitted: omitted } : {}), conversation }
}
/** v0.9.0's descriptions: up to 1024 characters (toolQuestions now cuts at 300, so pad nothing: cut here, rebuild criteria). */
function withLimit(questions: Record<string, any>, tools: readonly Tool[], limit: number) {
  const byName = new Map(tools.map(t => [t.name, t.description.trim().slice(0, limit) || null]))
  for (const q of Object.values(questions)) if (q.type === 'choice') for (const k of Object.keys(q.criteria)) if (byName.has(k)) q.criteria[k] = byName.get(k)
  return questions
}

// ---------------------------------------------------------------- one call

type Reply = { answers?: Record<string, Answer>; tokens?: number; chars: number; error?: string }
async function ask(state: unknown, questions: unknown): Promise<Reply> {
  const body = JSON.stringify({ model: 'jev-1.13-free', state, questions })
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://opencode.ai/zen/v1/systemone', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body })
    if (res.status === 429 || res.status >= 500) {
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)))
      continue
    }
    const json = (await res.json()) as { answers?: Record<string, Answer>; usage?: Record<string, number> }
    if (!res.ok) return { chars: body.length, error: `HTTP ${res.status}: ${JSON.stringify(json).slice(0, 160)}` }
    const u = json.usage ?? {}
    return { answers: json.answers, chars: body.length, tokens: u.input_tokens ?? u.prompt_tokens ?? u.inputTokens }
  }
  return { chars: body.length, error: 'retries exhausted' }
}

type Pick = { tool?: string; confidence?: number; hint?: string; calls: number; chars: number; tokens: number; offered: number; error?: string }
async function pick(state: unknown, tools: readonly Tool[], limit: number): Promise<Pick> {
  let offered = [...tools]
  let calls = 0
  let chars = 0
  let tokens = 0
  if (tools.length > MAX_TOOLS) {
    const { questions, shards } = shortlistQuestions(tools)
    const r = await ask(state, withLimit(questions, tools, limit))
    calls++, (chars += r.chars), (tokens += r.tokens ?? 0)
    if (!r.answers) return { calls, chars, tokens, offered: 0, error: r.error }
    offered = shortlisted(shards, r.answers)
  }
  const r = await ask(state, withLimit(toolQuestions(offered), offered, limit))
  calls++, (chars += r.chars), (tokens += r.tokens ?? 0)
  if (!r.answers) return { calls, chars, tokens, offered: offered.length, error: r.error }
  const t = r.answers.tool
  const d = decideRule(offered, r.answers)
  return { calls, chars, tokens, offered: offered.length, ...(t?.type === 'choice' ? { tool: t.choice, confidence: t.confidence } : {}), ...(d.mode === 'hint' && d.tool ? { hint: d.tool } : {}) }
}

// ---------------------------------------------------------------- decision points from transcripts

type Point = { project: string; rows: MessageRow[]; next: string }

/** The main-loop transcripts of the last 14 days, private repos left out. */
function transcripts(): { project: string; path: string }[] {
  const root = join(homedir(), '.claude/projects')
  const since = Date.now() - 14 * 86_400_000
  return readdirSync(root)
    .filter(dir => dir.startsWith('-Users-') && !EXCLUDE.includes(dir.split('-').at(-1)!))
    .flatMap(dir => readdirSync(join(root, dir)).map(f => ({ project: dir.split('-').at(-1)!, path: join(root, dir, f) })))
    .filter(t => t.path.endsWith('.jsonl') && statSync(t.path).mtimeMs >= since)
}

/**
 * Walks one transcript and calls `found` at each decision point: tool results just came back and
 * Claude's next response starts. Copies the conversation only when `found` asks for it.
 */
function walk(path: string, found: (next: string, rows: () => MessageRow[]) => void): void {
  const rows: MessageRow[] = []
  const uses = new Map<string, MessageRow['toolUses'][number]>()
  let lastId = ''
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let r: any
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (r.isSidechain || (r.type !== 'user' && r.type !== 'assistant')) continue
    const content = typeof r.message?.content === 'string' ? [{ type: 'text', text: r.message.content }] : (r.message?.content ?? [])
    if (r.type === 'assistant') {
      const prev = rows.at(-1)
      const first = content.find((c: any) => c.type === 'tool_use' || c.type === 'text')
      if (r.message.id !== lastId && prev?.role === 'user' && prev.text === '' && first && rows.length > 2)
        found(first.type === 'tool_use' ? first.name : 'no_tool_needed', () => structuredClone(rows))
      let row = rows.at(-1)
      if (!row || row.role !== 'assistant' || r.message.id !== lastId) rows.push((row = { role: 'assistant', text: '', toolUses: [] }))
      lastId = r.message.id
      for (const c of content) {
        if (c.type === 'text') row.text += c.text
        if (c.type === 'tool_use') {
          const use = { tool_use_id: c.id, tool: c.name, input: c.input }
          ;(row.toolUses as any[]).push(use)
          uses.set(c.id, use)
        }
      }
    } else {
      const results = content.filter((c: any) => c.type === 'tool_result')
      for (const c of results) {
        const use = uses.get(c.tool_use_id) as any
        if (!use) continue
        use.text = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x: any) => x.text ?? (x.tool_name ? `tool_reference ${x.tool_name}` : '')).join('\n')
      }
      const text = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      if (results.length) rows.push({ role: 'user', text: '', toolUses: [] })
      else if (text.trim()) rows.push({ role: 'user', text, toolUses: [] })
    }
  }
}

/** Rows as the mod reads them: an empty user row stands for a tool-results message, which $.session.messages folds into the uses. */
const asSession = (rows: MessageRow[]) => rows.filter(r => r.role === 'assistant' || r.text !== '')

// A fixed sample: every 1 in N points, so a rerun resumes on the same ones.
const files = transcripts()
let total = 0
for (const f of files) walk(f.path, () => total++)
const every = Math.max(1, Math.floor(total / POINTS))
const sample: Point[] = []
let n = 0
for (const f of files)
  walk(f.path, (next, rows) => {
    if (n++ % every === 0 && sample.length < POINTS) sample.push({ project: f.project, rows: rows(), next })
  })
console.log(`${total} decision points; sampling ${sample.length}`)

type Row = { i: number; project: string; next: string; old: Pick; new: Pick }
const rows = await pool(
  sample,
  OUT,
  async (p, i): Promise<Row> => {
    const session = asSession(p.rows)
    const turns = turnsFrom(session)
    const [o, n] = await Promise.all([pick(oldState(turns), TOOLS, 1024), pick(buildState(turns), reachableTools(TOOLS, session), 300)])
    process.stdout.write('.')
    return { i, project: p.project, next: p.next, old: o, new: n }
  },
  1,
)

// ---------------------------------------------------------------- the comparison

const ok = rows.filter(r => !r.old.error && !r.new.error)
const same = ok.filter(r => r.old.tool === r.new.tool).length
const right = (k: 'old' | 'new') => ok.filter(r => r[k].tool === r.next).length
const hints = (k: 'old' | 'new') => ok.filter(r => r[k].hint)
const hintRight = (k: 'old' | 'new') => hints(k).filter(r => r[k].hint === r.next).length
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
console.log(`\n${ok.length} points scored (${rows.length - ok.length} errors)`)
for (const k of ['old', 'new'] as const) {
  const g = ok.map(r => r[k])
  console.log(
    `${k}: calls/ask ${(sum(g.map(x => x.calls)) / g.length).toFixed(2)} · median chars ${median(g.map(x => x.chars))} · median input tokens ${median(g.map(x => x.tokens))} · tools offered (median) ${median(g.map(x => x.offered))}`,
  )
  console.log(`   pick = Claude's next tool ${pct(right(k), ok.length)} · hints ${hints(k).length} (${pct(hints(k).length, ok.length)}) · hint = Claude's next ${pct(hintRight(k), hints(k).length)}`)
}
console.log(`same pick old vs new: ${pct(same, ok.length)}`)
console.log(`Claude's next tool was deferred-and-unnamed (out of reach for new): ${ok.filter(r => !reachableTools(TOOLS, []).some(t => t.name === r.next) && r.next !== 'no_tool_needed' && TOOLS.some(t => t.name === r.next)).length}`)
if (!existsSync(OUT)) console.log('no output')
