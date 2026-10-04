// Experiment: can Jev spot quick status questions safely enough to answer them at low effort?
// Asks the effort class and an independent "quick question?" check in one call, then compares
// with how much work each turn really took. Results: research/results/03-fast-lane-cross-check.md
//
//   python3 extract.py && node fast-lane.mts
import { DATA, decide, median, pool, turnState, readJsonl } from './lib.mts'
import type { Turn } from './lib.mts'

const EFFORT = {
  status: 'A quick question about state or status that needs a short lookup and a short answer, little reasoning: "is it in prod?", "are we done?", "what is next?", "did it work?".',
  routine: 'Small, mechanical work with an obvious approach: run a known command, commit or push, a tiny edit, rename, or approving a step whose remaining work is small. Read the conversation: "yes" that approves a big build is NOT routine.',
  standard: 'Normal engineering or writing work with some investigation: implement or change a feature, fix a specific bug, write a document, analyze data.',
  hard: 'Needs deep, careful reasoning: architecture or design decisions, subtle or multi-system bugs, large refactors, ambiguous requirements, security, or analysis where a wrong call is costly.',
}
const QUICK =
  "Is the user's latest message a quick question about status or state (is it deployed, did it work, are we done, what is next) that the assistant can answer with a short look-up, WITHOUT doing new work such as building, fixing, writing, running a process, or opening something?"

type Row = { i: number; prompt: string; steps: number; output: number; effort?: { choice: string; confidence: number }; quick?: number; cost: number }

const turns = readJsonl<Turn>(DATA + 'turns.jsonl')
const rows = await pool(turns, DATA + 'fast-lane.jsonl', async (t, i): Promise<Row> => {
  const d = await decide(turnState(t), {
    effort: { type: 'choice', instructions: "How much reasoning will the coding assistant need to answer the user's LATEST message well? Judge by the work it triggers, using the conversation for context, not by how long the message is.", criteria: EFFORT },
    quick: { type: 'noul', instructions: QUICK },
  })
  const effort = d.answers?.effort?.type === 'choice' ? { choice: d.answers.effort.choice, confidence: d.answers.effort.confidence } : undefined
  const quick = d.answers?.quick?.type === 'noul' ? d.answers.quick.noul : undefined
  return { i, prompt: t.prompt.slice(0, 120), steps: t.steps, output: t.output, effort, quick, cost: d.cost }
})

const heavy = (r: Row) => r.steps > 25 || r.output > 20000
console.log(`${rows.length} turns · cost $${rows.reduce((s, r) => s + r.cost, 0).toFixed(4)}`)
const rules: [string, (r: Row) => boolean][] = [
  ['status ≥ 0.6', r => r.effort?.choice === 'status' && r.effort.confidence >= 0.6],
  ['status ≥ 0.7', r => r.effort?.choice === 'status' && r.effort.confidence >= 0.7],
  ['status ≥ 0.7 AND quick ≥ 0.7', r => r.effort?.choice === 'status' && r.effort.confidence >= 0.7 && (r.quick ?? 0) >= 0.7],
  ['status ≥ 0.7 AND quick ≥ 0.85', r => r.effort?.choice === 'status' && r.effort.confidence >= 0.7 && (r.quick ?? 0) >= 0.85],
]
for (const [name, rule] of rules) {
  const sel = rows.filter(rule)
  const bad = sel.filter(heavy)
  console.log(`${name.padEnd(32)} lowers ${String(sel.length).padStart(3)} (${Math.round((sel.length / rows.length) * 100)}%) · heavy ${bad.length} (${sel.length ? ((bad.length / sel.length) * 100).toFixed(1) : 0}%) · median requests ${median(sel.map(r => r.steps))}`)
}
