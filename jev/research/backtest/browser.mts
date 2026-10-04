// Experiment: could Jev choose what Claude clicks in the browser? Finds the moments where the
// Claude in Chrome `find`/`read_page` tools listed several elements and Claude then acted on one,
// asks Jev to pick, and compares. Results: research/results/04-browser.md
//
//   node browser.mts            # reads ~/.claude/projects directly; last 14 days
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { DATA, decide, median, pct } from './lib.mts'

const EXCLUDE = (process.env.JEVMOD_EXCLUDE ?? '').split(',').map(s => s.trim()).filter(Boolean)
const since = Date.now() - 14 * 86_400_000
const REF = /^- (ref_\d+): (.+)$/gm
type Case = { prompt: string; query: string; candidates: { ref: string; label: string }[]; chosen?: string }

const cases: Case[] = []
const root = `${homedir()}/.claude/projects`
for (const dir of readdirSync(root)) {
  if (EXCLUDE.some(x => dir.includes(x))) continue
  let files: string[] = []
  try {
    files = readdirSync(`${root}/${dir}`).filter(f => f.endsWith('.jsonl'))
  } catch {
    continue
  }
  for (const f of files) {
    const path = `${root}/${dir}/${f}`
    if (statSync(path).mtimeMs < since) continue
    let prompt = ''
    const calls = new Map<string, { name: string; input: Record<string, unknown> }>()
    let open: Case | undefined
    let after = 0
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      let d: any
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      if (d.isSidechain) continue
      const c = d.message?.content
      if (d.type === 'user' && typeof c === 'string' && ['typed', 'queued'].includes(d.promptSource) && !c.startsWith('<')) prompt = c
      if (!Array.isArray(c)) continue
      for (const b of c) {
        if (b?.type === 'tool_use') {
          calls.set(b.id, { name: b.name, input: b.input ?? {} })
          if (!String(b.name).startsWith('mcp__claude-in-chrome__') || !open) continue
          const acts = b.name.endsWith('browser_batch') ? (b.input?.actions ?? []).map((a: any) => a.input ?? {}) : [b.input ?? {}]
          const ref = acts.find((a: any) => a.ref)?.ref
          if (ref) {
            open.chosen = ref
            cases.push(open)
            open = undefined
          } else if (++after > 3) open = undefined
        }
        if (b?.type === 'tool_result' && !b.is_error) {
          const call = calls.get(b.tool_use_id)
          const kind = call?.name.split('__')[2]
          if (kind !== 'find' && kind !== 'read_page') continue
          const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x: any) => x.text ?? '').join('\n')
          const candidates = [...text.matchAll(REF)].slice(0, 60).map(m => ({ ref: m[1]!, label: m[2]!.slice(0, 200) }))
          if (candidates.length > 0) {
            open = { prompt: prompt.slice(0, 1500), query: String(call!.input.query ?? ''), candidates }
            after = 0
          }
        }
      }
    }
  }
}

const choices = cases.filter(c => c.candidates.length > 1 && c.candidates.some(x => x.ref === c.chosen))
writeFileSync(DATA + 'browser-cases.json', JSON.stringify(choices))
console.log(`${cases.length} element choices found; ${choices.length} had several options`)

let chance = 0
const hits = { query: 0, goal: 0 }
const ms: number[] = []
for (const c of choices) {
  chance += 1 / c.candidates.length
  const criteria = Object.fromEntries(c.candidates.map(x => [x.ref, x.label]))
  const withQuery = await decide(`User's request:\n${c.prompt}\n\nThe assistant is looking for: ${c.query}`, { pick: { type: 'choice', instructions: 'Which page element matches what the assistant is looking for?', criteria } })
  const goalOnly = await decide(`User's request:\n${c.prompt}`, { pick: { type: 'choice', instructions: "Which page element should the browser assistant act on next to make progress on the user's request?", criteria } })
  for (const [k, d] of [['query', withQuery], ['goal', goalOnly]] as const) {
    ms.push(d.ms)
    const a = d.answers?.pick
    if (a?.type === 'choice' && a.choice === c.chosen) hits[k]++
  }
}
console.log(`random guessing: ${pct(Math.round(chance), choices.length)} · knowing Claude's search: ${pct(hits.query, choices.length)} · knowing only the request: ${pct(hits.goal, choices.length)} · Jev p50 ${median(ms)}ms`)
