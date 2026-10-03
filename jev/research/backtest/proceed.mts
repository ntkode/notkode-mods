// Experiment (idea 9): can Jev tell when Claude's "should I proceed?" is a routine, reversible step
// the user would approve anyway, so the go-ahead could be given without a round trip?
//
// Picks the turns whose final answer ends by asking permission, then compares Jev's read of the
// proposed step with what the user really answered next. Results: research/results/05-proceed.md
//
//   python3 extract.py --sample 0         # every turn of the last 14 days
//   node proceed.mts --local              # the baseline from transcripts alone: nothing leaves the machine
//   node proceed.mts                      # asks Jev about each permission question (cents)
import { DATA, decide, median, pct, pool, readJsonl, turnState } from './lib.mts'
import type { Turn } from './lib.mts'

const LOCAL = process.argv.includes('--local')

/** The answer's last paragraph asks for a go-ahead (English and Portuguese, as people write them). */
const ASKS = /(should i|shall i|want me to|do you want|would you like me to|ok to|okay to|can i go ahead|proceed\?|go ahead\?|quer que eu|posso\b|devo\b|prossigo|sigo\b|fa[cç]o\b.*\?)/i
const asksPermission = (answer: string) => {
  const tail = answer.trim().split(/\n\s*\n/).pop() ?? ''
  return tail.includes('?') && ASKS.test(tail)
}

/** The user's next message approves, without new instructions. */
const GO = /^\s*(y|yes|yep|yeah|sure|ok|okay|go|go ahead|do it|proceed|please do|sim|pode|pode sim|manda|faz|fa[cç]a|vai|segue|prossiga|claro|isso)\b[\s.!,]*(please|por favor|pls)?[\s.!]*$/i
const approved = (next: string) => GO.test(next)

const turns = readJsonl<Turn>(DATA + 'turns.jsonl')
const asking = turns.filter(t => asksPermission(t.answer) && t.next.trim() !== '')
const go = asking.filter(t => approved(t.next))
console.log(`${turns.length} turns · ${asking.length} end by asking permission (${pct(asking.length, turns.length)}) · plain go-ahead next: ${go.length} (${pct(go.length, asking.length)})`)
console.log(`requests in the turn after a go-ahead: median ${median(go.map(t => t.steps))}`)

if (!LOCAL) {
  const ROUTINE =
    "The assistant's LAST message ends by asking the user for permission to take a next step. Is that step routine and easy to undo (run a known command, commit, a small edit, continue a plan the user already approved), so a careful user would simply say yes?"
  const NEW_INFO = "Does the assistant's question need information only the user has (a choice between options, a preference, a credential, an outside fact), rather than a yes or no?"
  type Row = { i: number; approved: boolean; routine?: number; newInfo?: number; cost: number }
  const rows = await pool(asking, DATA + 'proceed.jsonl', async (t, i): Promise<Row> => {
    const state = `${turnState(t)}\n\nAssistant's LAST message:\n${t.answer.trim().slice(-3000)}`
    const d = await decide(state, { routine: { type: 'noul', instructions: ROUTINE }, newInfo: { type: 'noul', instructions: NEW_INFO } })
    const noul = (k: string) => (d.answers?.[k]?.type === 'noul' ? (d.answers[k] as { noul: number }).noul : undefined)
    return { i, approved: approved(t.next), routine: noul('routine'), newInfo: noul('newInfo'), cost: d.cost }
  })
  console.log(`cost $${rows.reduce((s, r) => s + r.cost, 0).toFixed(4)}`)
  for (const at of [0.7, 0.8, 0.9]) {
    const sel = rows.filter(r => (r.routine ?? 0) >= at && (r.newInfo ?? 1) < 0.5)
    const yes = sel.filter(r => r.approved)
    // Auto-answering is only worth it if nearly every selected question really got a plain yes.
    console.log(`routine ≥ ${at} and no new info: ${sel.length} (${pct(sel.length, rows.length)} of questions) · user said yes ${yes.length} (${pct(yes.length, sel.length)})`)
  }
}
