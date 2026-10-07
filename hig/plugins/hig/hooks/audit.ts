import type { Finding, Hit, Platform, Report, Stack, Status, Verdict } from '../types'
import { AREAS, RULES, ruleById, url } from './rules'
import type { Area, Rule } from './rules'
import { detectStack } from './scan'
import type { Ctx, Outcome, SourceFile } from './scan'

/** Worst first: a gap anywhere is a gap, then something to judge, then a pass. */
const RANK: Record<Status, number> = { gap: 3, review: 2, pass: 1, na: 0 }

export function platformsOf(stack: Stack): Platform[] {
  return [...(stack.apple ? (['apple'] as const) : []), ...(stack.web ? (['web'] as const) : [])]
}

export function applies(rule: Rule, stack: Stack): boolean {
  return rule.platforms.some(p => platformsOf(stack).includes(p))
}

/** Runs one rule on every platform the project has, the worst outcome standing. */
export function runRule(rule: Rule, ctx: Ctx): Outcome {
  const outcomes: Outcome[] = []
  for (const p of platformsOf(ctx.stack)) {
    if (!rule.platforms.includes(p)) continue
    const check = rule.check?.[p]
    let out: Outcome
    try {
      out = check ? check(ctx) : { status: 'review', hits: [], note: rule.ask ?? 'Needs judgment.' }
    } catch (err) {
      out = { status: 'review', hits: [], note: `The check failed (${err instanceof Error ? err.message : String(err)}); judge it by hand.` }
    }
    outcomes.push(out)
  }
  if (outcomes.length === 0) return { status: 'na', hits: [], note: 'Not for this kind of project.' }
  const worst = outcomes.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a))
  return { status: worst.status, hits: outcomes.flatMap(o => o.hits).slice(0, 40), note: outcomes.filter(o => o.status === worst.status).map(o => o.note).join(' ') }
}

export type Judgments = { verdicts: Record<string, Verdict>; waived: string[] }

/** What counts for one guideline: a waiver, then a verdict where the check could not decide, then the check. */
export function settle(id: string, out: Outcome, j: Judgments): Finding {
  const isWaived = j.waived.includes(id)
  const verdict = j.verdicts[id]
  let status: Status = out.status
  if (isWaived) status = 'na'
  else if (verdict && out.status === 'review') status = verdict.status
  return { id, auto: out.status, status, hits: out.hits, note: out.note, isWaived, ...(verdict ? { verdict } : {}) }
}

export function audit(root: string, files: SourceFile[], j: Judgments, at: number, paths: string[] = files.map(f => f.path)): Report {
  const stack = detectStack(files)
  const ctx: Ctx = { files, stack, paths }
  const findings = RULES.map(rule => settle(rule.id, runRule(rule, ctx), j))
  return { root, at, files: files.length, stack, findings }
}

/** Applies new judgments to a report without scanning again. */
export function rejudge(report: Report, j: Judgments): Report {
  return { ...report, findings: report.findings.map(f => settle(f.id, { status: f.auto, hits: f.hits, note: f.note }, j)) }
}

export type Tally = { pass: number; gap: number; review: number; na: number; applicable: number; percent: number }

export function tally(findings: Finding[]): Tally {
  const t = { pass: 0, gap: 0, review: 0, na: 0 }
  for (const f of findings) t[f.status]++
  const applicable = t.pass + t.gap + t.review
  return { ...t, applicable, percent: applicable ? Math.round((t.pass / applicable) * 100) : 0 }
}

export function byArea(findings: Finding[]): { area: Area; tally: Tally }[] {
  return AREAS.map(area => ({ area, tally: tally(findings.filter(f => ruleById(f.id)?.area === area)) })).filter(a => a.tally.applicable > 0)
}

export function stackLabel(stack: Stack): string {
  const parts: string[] = []
  if (stack.swiftui) parts.push('SwiftUI')
  if (stack.uikit) parts.push('UIKit')
  if (stack.apple && !stack.swiftui && !stack.uikit) parts.push('Apple')
  if (stack.apple) parts.push(stack.ios && stack.mac ? 'iOS + macOS' : stack.mac ? 'macOS' : 'iOS')
  if (stack.web) parts.push('web')
  return parts.join(' · ') || 'no UI code found'
}

export function bar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

/** The guidelines, as Claude reads them in its system prompt: those that apply to this kind of project. */
export function digest(stack: Stack): string {
  const rules = RULES.filter(r => applies(r, stack))
  const lines = [
    "# Apple Human Interface Guidelines",
    `This project builds an interface (${stackLabel(stack)}). Design and write UI code that follows Apple's Human Interface Guidelines (${'https://developer.apple.com/design/human-interface-guidelines/'}). When you write or change UI, apply these:`,
  ]
  for (const area of AREAS) {
    const own = rules.filter(r => r.area === area)
    if (own.length === 0) continue
    lines.push('', `## ${area}`)
    for (const r of own) lines.push(`- ${r.title}: ${r.guidance}`)
  }
  lines.push(
    '',
    'The hig plugin audits the project against these. Call mcp__hig__audit to see which are not covered yet, with the places in the code, before UI work or when asked about design quality. Guidelines marked "review" need judgment: when you have looked at one, record what you found with mcp__hig__verdict. After you edit a UI file, the guidelines that edit breaks are reported back to you: fix them unless the person asked otherwise.',
  )
  return lines.join('\n')
}

function hitLine(h: Hit): string {
  return `${h.path}:${h.line}  ${h.text}`
}

/** The audit as Claude reads it from the tool: what is open first, with the places and links. */
export function auditText(report: Report, which: 'open' | 'all' = 'open', area?: string): string {
  const t = tally(report.findings)
  const out = [`HIG audit of ${report.root} (${stackLabel(report.stack)}, ${report.files} files): ${t.pass} of ${t.applicable} guidelines covered (${t.percent}%), ${t.gap} gaps, ${t.review} to review.`]
  const list = report.findings.filter(f => (which === 'all' || f.status === 'gap' || f.status === 'review') && (!area || ruleById(f.id)?.area.toLowerCase() === area.toLowerCase()))
  for (const status of ['gap', 'review', 'pass', 'na'] as const) {
    const group = list.filter(f => f.status === status)
    if (group.length === 0) continue
    out.push('', status === 'gap' ? '## Gaps' : status === 'review' ? '## To review (no check can settle these: look, then record a verdict)' : status === 'pass' ? '## Covered' : '## Not applicable')
    for (const f of group) {
      const r = ruleById(f.id)!
      out.push(`- [${f.id}] ${r.area} / ${r.title}: ${f.note}${f.isWaived ? ' (waived by the person)' : ''}`)
      if (status === 'gap' || status === 'review') {
        out.push(`  Guideline: ${r.guidance}`, `  ${url(r)}`)
        if (r.ask && status === 'review') out.push(`  To judge: ${r.ask}`)
      }
      if (f.verdict) out.push(`  Verdict (${f.verdict.by}): ${f.verdict.status}, ${f.verdict.note}`)
      for (const h of f.hits.slice(0, status === 'gap' ? 12 : 3)) out.push(`  ${hitLine(h)}`)
      if (f.hits.length > 12 && status === 'gap') out.push(`  …and ${f.hits.length - 12} more`)
    }
  }
  return out.join('\n')
}

/** What an edit added against the guidelines in one file: hits in `path` the report before did not have. */
export function newHits(before: Report | null, after: Report, path: string): { rule: Rule; hits: Hit[] }[] {
  const old = new Set((before?.findings ?? []).flatMap(f => f.hits.filter(h => h.path === path).map(h => `${f.id}|${h.text}`)))
  const out: { rule: Rule; hits: Hit[] }[] = []
  for (const f of after.findings) {
    if (f.status !== 'gap') continue
    const fresh = f.hits.filter(h => h.path === path && !old.has(`${f.id}|${h.text}`))
    if (fresh.length) out.push({ rule: ruleById(f.id)!, hits: fresh })
  }
  return out
}

export function editNote(path: string, found: { rule: Rule; hits: Hit[] }[]): string {
  const lines = [`HIG check of your edit to ${path}: it goes against ${found.length === 1 ? 'one guideline' : `${found.length} guidelines`}.`]
  for (const { rule, hits } of found.slice(0, 6)) {
    lines.push(`- ${rule.title} (${url(rule)}): ${rule.guidance}`)
    for (const h of hits.slice(0, 4)) lines.push(`  line ${h.line}: ${h.text}`)
  }
  lines.push('Fix these as part of this change unless the person asked for exactly this; if a hit is a false alarm, carry on.')
  return lines.join('\n')
}

/** The prompt the pane sends Claude to close gaps: one guideline, or all of them. */
export function fixPrompt(report: Report, ids: string[]): string {
  const findings = report.findings.filter(f => ids.includes(f.id))
  const lines = [
    `Bring this project closer to Apple's Human Interface Guidelines. Fix ${findings.length === 1 ? 'this gap' : `these ${findings.length} gaps`} the hig audit found:`,
  ]
  for (const f of findings) {
    const r = ruleById(f.id)!
    lines.push('', `## ${r.title} (${url(r)})`, r.guidance, f.note)
    for (const h of f.hits.slice(0, 15)) lines.push(`- ${hitLine(h)}`)
  }
  lines.push('', 'Some places may be false alarms: leave those as they are and say why. Afterwards call mcp__hig__audit to confirm the gaps are closed.')
  return lines.join('\n')
}

export function reviewPrompt(report: Report, ids: string[]): string {
  const findings = report.findings.filter(f => ids.includes(f.id))
  const lines = [
    `Review this project against ${findings.length === 1 ? 'a guideline' : `${findings.length} guidelines`} from Apple's Human Interface Guidelines that no automatic check can settle. Read the relevant UI code, judge each, and record each verdict with mcp__hig__verdict (pass or gap, with a short note naming the files you looked at). Do not change code in this pass.`,
  ]
  for (const f of findings) {
    const r = ruleById(f.id)!
    lines.push('', `## [${r.id}] ${r.title} (${url(r)})`, r.guidance)
    if (r.ask) lines.push(`To judge: ${r.ask}`)
    if (f.note && f.note !== r.ask) lines.push(f.note)
  }
  return lines.join('\n')
}

/** The audit as a Markdown report, for a file in the project. */
export function markdown(report: Report, date: string): string {
  const t = tally(report.findings)
  const out = [
    '# HIG audit',
    '',
    `${date} · ${stackLabel(report.stack)} · ${report.files} files scanned`,
    '',
    `**${t.pass} of ${t.applicable} guidelines covered (${t.percent}%)** · ${t.gap} gaps · ${t.review} to review · ${t.na} not applicable`,
    '',
    '| Area | Covered | Gaps | To review |',
    '|---|---|---|---|',
    ...byArea(report.findings).map(a => `| ${a.area} | ${a.tally.pass}/${a.tally.applicable} | ${a.tally.gap} | ${a.tally.review} |`),
  ]
  const icon: Record<Status, string> = { gap: '✗', review: '?', pass: '✓', na: '–' }
  for (const area of AREAS) {
    const own = report.findings.filter(f => ruleById(f.id)?.area === area)
    if (own.every(f => f.status === 'na')) continue
    out.push('', `## ${area}`, '')
    for (const f of own) {
      const r = ruleById(f.id)!
      out.push(`- ${icon[f.status]} **[${r.title}](${url(r)})**: ${f.isWaived ? 'waived' : f.note}`)
      if (f.verdict) out.push(`  - Verdict (${f.verdict.by}): ${f.verdict.note}`)
      if (f.status === 'gap') for (const h of f.hits.slice(0, 8)) out.push(`  - \`${h.path}:${h.line}\` ${h.text.replace(/`/g, "'")}`)
    }
  }
  return out.join('\n') + '\n'
}
