// Experiment (idea 14): a narrow done check. When Claude stops, can Jev tell that work the user
// asked for is unfinished, Claude could go on by itself, and nothing blocks it?
//
// Ground truth: turns whose next user message pushed Claude to finish ("continue", "do it
// yourself", "why did we stop?"), labelled by hand in data/done-positives.json (indexes into
// data/turns-all.jsonl); everything else is the comparison group. Results: research/results/08-done-check.md
//
//   python3 extract.py --sample 0 --out data/turns-all.jsonl
//   node done-check.mts            # asks Jev about every positive and 400 other turns (cents)
import { readFileSync } from 'node:fs'
import { DATA, decide, pct, pool, readJsonl, turnState } from './lib.mts'
import type { Turn } from './lib.mts'

const turns = readJsonl<Turn>(DATA + 'turns-all.jsonl')
const positives = new Set<number>(JSON.parse(readFileSync(DATA + 'done-positives.json', 'utf8')))
const others = turns.map((t, i) => ({ t, i })).filter(({ t, i }) => !positives.has(i) && t.reason !== 'aborted' && t.next.trim() !== '')
// A fixed shuffle, so a rerun asks about the same turns.
let seed = 7
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const sample = others.sort(() => rand() - 0.5).slice(0, 400)
const cases = [...[...positives].map(i => ({ t: turns[i]!, i })), ...sample]

const QUESTIONS = {
  requested: "Did the user's LATEST message ask the assistant to do work (make changes, run commands, deploy, investigate, build or produce something), rather than only ask a question or chat?",
  unfinished: "At the end of this turn, is part of the work the user asked for in their LATEST message still not done?",
  canContinue: 'Could the assistant carry on with that remaining work right now by itself, with its tools, without needing anything from the user?',
  blocked:
    'Is the assistant genuinely waiting on the user: it needs a decision between options, approval for a risky or irreversible step, a credential, an action only the user can take, or information only the user has?',
  promised: "Does the assistant's FINAL message say it will do something next, or that work is still under way, instead of reporting the work as finished?",
}

type Row = { i: number; positive: boolean; a: Partial<Record<keyof typeof QUESTIONS, number>>; cost: number; ms: number }

const rows = await pool(cases, DATA + 'done-check.jsonl', async ({ t, i }): Promise<Row> => {
  const tools = t.tools.slice(-15).map(x => `- ${x.tool}${x.summary ? `: ${x.summary}` : ''}${x.isError ? ' (error)' : ''}`)
  const state = [
    turnState(t),
    `Tool calls the assistant made this turn: ${t.tools.length}${tools.length ? ` (last ${tools.length}):\n${tools.join('\n')}` : ''}`,
    `Assistant's FINAL message:\n${t.answer.trim().slice(-3000)}`,
  ].join('\n\n')
  const d = await decide(state, Object.fromEntries(Object.entries(QUESTIONS).map(([k, q]) => [k, { type: 'noul', instructions: q }])))
  const a: Row['a'] = {}
  for (const k of Object.keys(QUESTIONS) as (keyof typeof QUESTIONS)[]) {
    const x = d.answers?.[k]
    if (x?.type === 'noul') a[k] = x.noul
  }
  return { i, positive: positives.has(i), a, cost: d.cost, ms: d.ms }
})

const pos = rows.filter(r => r.positive)
const neg = rows.filter(r => !r.positive)
console.log(`${rows.length} turns asked (${pos.length} half-done, ${neg.length} others) · cost $${rows.reduce((s, r) => s + r.cost, 0).toFixed(4)} · Jev p50 ${[...rows.map(r => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)]}ms`)

const v = (r: Row, k: keyof typeof QUESTIONS) => r.a[k] ?? 0
const rules: [string, (r: Row, at: number) => boolean][] = [
  ['unfinished', (r, at) => v(r, 'unfinished') >= at],
  ['unfinished · can continue', (r, at) => v(r, 'unfinished') >= at && v(r, 'canContinue') >= at],
  ['requested · unfinished · can continue · not blocked', (r, at) => v(r, 'requested') >= 0.5 && v(r, 'unfinished') >= at && v(r, 'canContinue') >= at && v(r, 'blocked') < 1 - at],
  ['… or promised and not blocked', (r, at) => v(r, 'requested') >= 0.5 && v(r, 'blocked') < 1 - at && ((v(r, 'unfinished') >= at && v(r, 'canContinue') >= at) || v(r, 'promised') >= at)],
]
for (const [name, rule] of rules) {
  console.log(`\n${name}`)
  for (const at of [0.5, 0.7, 0.8, 0.9]) {
    const tp = pos.filter(r => rule(r, at)).length
    const fp = neg.filter(r => rule(r, at)).length
    console.log(`  ≥ ${at}: caught ${tp}/${pos.length} (${pct(tp, pos.length)}) · pushed ${fp}/${neg.length} others (${pct(fp, neg.length)}) · precision ${pct(tp, tp + fp)}`)
  }
}
const mean = (g: Row[], k: keyof typeof QUESTIONS) => (g.reduce((s, r) => s + v(r, k), 0) / Math.max(1, g.length)).toFixed(2)
console.log('\nmean answer, half-done vs others:')
for (const k of Object.keys(QUESTIONS) as (keyof typeof QUESTIONS)[]) console.log(`  ${k.padEnd(12)} ${mean(pos, k)} vs ${mean(neg, k)}`)
