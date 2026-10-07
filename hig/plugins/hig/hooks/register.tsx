import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { Filter, Finding, Report, Status, Verdict } from '../types'
import {
  auditText, bar, byArea, digest, editNote, fixPrompt, markdown, newHits, rejudge, reviewPrompt, stackLabel, tally, audit,
} from './audit'
import type { Judgments } from './audit'
import { RULES, ruleById, url } from './rules'
import { file, isRelevant } from './scan'
import type { SourceFile } from './scan'

type $ = EngineInterface
type PaneEvent = RenderInput<'Pane'>

const PANE = 'hig'
const MAX_FILES = 2500
const MAX_BYTES = 400 * 1024
const REPORT_FILE = 'HIG-AUDIT.md'

const reportA = atom({ plugin: 'hig', key: 'report' } as const, null)
const scanningA = atom({ plugin: 'hig', key: 'isScanning' } as const, false)
const filterA = atom({ plugin: 'hig', key: 'filter' } as const, 'gap')
const openA = atom({ plugin: 'hig', key: 'open' } as const, null)

/** The texts the last scan read, by path from the root: an edit re-checks against them without reading the project again. */
let cache = new Map<string, SourceFile>()
/** Every file the last scan listed, read or not. */
let allPaths: string[] = []
let pending: Promise<Report> | null = null

const ICON: Record<Status, string> = { gap: '✗', review: '?', pass: '✓', na: '–' }
const COLOR: Record<Status, string> = { gap: 'error', review: 'warning', pass: 'success', na: 'inactive' }
const WORD: Record<Status, string> = { gap: 'gap', review: 'to review', pass: 'covered', na: 'not applicable' }

// ---- the project's files ----

/** Every file of the project: git's list (ignored files left out), or a walk outside a repository. */
async function listFiles($: $, root: string): Promise<string[]> {
  const git = await $.process.run(['git', '-C', root, 'ls-files', '-co', '--exclude-standard'], { timeoutMs: 15000 }).catch(() => undefined)
  if (git && git.exitCode === 0) return git.stdout.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 50000)
  // Not a git repository: walk the folders.
  const out: string[] = []
  const queue = ['']
  let visited = 0
  while (queue.length && visited < 20000) {
    const rel = queue.shift()!
    const entries = await $.fs.list(rel ? `${root}/${rel}` : root).catch(() => [])
    for (const e of entries) {
      visited++
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.name.startsWith('.') && e.name !== '.well-known') continue
      if (e.kind === 'dir') {
        if (isRelevant(`${path}/x.swift`) || e.name.endsWith('.xcodeproj') || e.name.endsWith('.xcassets')) queue.push(path)
      } else if (e.kind === 'file') out.push(path)
    }
  }
  return out
}

async function readFiles($: $, root: string, paths: string[]): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  for (let i = 0; i < paths.length; i += 32) {
    const batch = await Promise.all(
      paths.slice(i, i + 32).map(async p => {
        const text = await $.fs.read(`${root}/${p}`).catch(() => undefined)
        return text === undefined || text.length > MAX_BYTES ? undefined : file(p, text)
      }),
    )
    for (const f of batch) if (f) out.push(f)
  }
  return out
}

// ---- judgments: Claude's verdicts and your waivers, kept per project across sessions ----

async function judgments($: $, root: string): Promise<Judgments> {
  const saved = (await $.store.get(`judgments:${root}`).catch(() => undefined)) as Partial<Judgments> | undefined
  return { verdicts: saved?.verdicts ?? {}, waived: saved?.waived ?? [] }
}

async function saveJudgments($: $, root: string, j: Judgments) {
  await $.store.set(`judgments:${root}`, j)
  const report = await read($, reportA)
  if (report && report.root === root) await setReport($, rejudge(report, j))
}

async function setReport($: $, report: Report) {
  await update($, reportA, () => report)
}

// ---- scanning ----

function scan($: $): Promise<Report> {
  if (pending) return pending
  pending = (async () => {
    await update($, scanningA, () => true)
    try {
      const root = await $.session.root()
      allPaths = await listFiles($, root)
      const files = await readFiles($, root, allPaths.filter(isRelevant).slice(0, MAX_FILES))
      cache = new Map(files.map(f => [f.path, f]))
      const report = audit(root, files, await judgments($, root), await $.clock.now(), allPaths)
      await setReport($, report)
      return report
    } finally {
      await update($, scanningA, () => false)
      pending = null
    }
  })()
  return pending
}

/** The last report, scanning first when there is none. */
async function current($: $): Promise<Report> {
  return (await read($, reportA)) ?? scan($)
}

/** Re-checks the project with one file's new text, from the cache; null before the first scan. */
async function recheck($: $, root: string, rel: string): Promise<{ before: Report; after: Report } | null> {
  const before = await read($, reportA)
  if (!before || before.root !== root || cache.size === 0) return null
  const text = await $.fs.read(`${root}/${rel}`).catch(() => undefined)
  if (text === undefined) return null
  cache.set(rel, file(rel, text))
  if (!allPaths.includes(rel)) allPaths.push(rel)
  const after = audit(root, [...cache.values()], await judgments($, root), await $.clock.now(), allPaths)
  await setReport($, after)
  return { before, after }
}

// ---- asking Claude ----

async function send($: $, text: string, what: string) {
  await $.prompt.submit({ text })
  $.ui.toast(`${what}: sent to Claude`)
}

async function exportReport($: $): Promise<string> {
  const report = await current($)
  const date = new Date(report.at).toISOString().slice(0, 10)
  const path = `${report.root}/${REPORT_FILE}`
  await $.fs.write(path, markdown(report, date))
  return path
}

async function setVerdict($: $, id: string, status: 'pass' | 'gap', note: string, by: Verdict['by']) {
  const root = await $.session.root()
  const j = await judgments($, root)
  j.verdicts = { ...j.verdicts, [id]: { status, note, at: await $.clock.now(), by } }
  await saveJudgments($, root, j)
}

async function toggleWaive($: $, id: string) {
  const root = await $.session.root()
  const j = await judgments($, root)
  j.waived = j.waived.includes(id) ? j.waived.filter(x => x !== id) : [...j.waived, id]
  await saveJudgments($, root, j)
}

// ---- drawing ----

function timeOf(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

async function drawPane($: $, e: PaneEvent) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const report = await read($, reportA)
  const isScanning = await read($, scanningA)
  if (!report) {
    return (
      <Box flexDirection="column">
        <Text bold>HIG audit</Text>
        <Text dimColor>{isScanning ? 'Reading the project…' : 'No audit yet.'}</Text>
        {!isScanning ? <Button key="scan" hotkey="r" label="scan the project" onPress={() => void scan($)} /> : null}
      </Box>
    )
  }
  const open = await read($, openA)
  const finding = open ? report.findings.find(f => f.id === open) : undefined
  if (finding) return drawDetail($, e, report, finding)
  return drawList($, e, report, isScanning)
}

async function drawList($: $, e: PaneEvent, report: Report, isScanning: boolean) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const filter = await read($, filterA)
  const t = tally(report.findings)
  const width = Math.max(30, e.props.bodyColumns)
  const isUi = report.stack.apple || report.stack.web
  const areas = byArea(report.findings)
  const areaWidth = Math.max(...areas.map(a => a.area.length), 8)
  const shown = report.findings
    .filter(f => filter === 'all' || f.status === filter)
    .sort((a, b) => order(a) - order(b))
  const pick = (f: Filter) => () => void update($, filterA, () => f)

  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-start">HIG audit · {baseName(report.root)}</Text>
      <Text dimColor wrap="truncate">{stackLabel(report.stack)} · {report.files} files · {isScanning ? 'scanning…' : `scanned ${timeOf(report.at)}`}</Text>
      <Text> </Text>
      {!isUi ? (
        <Text dimColor>No Apple or web interface code here, so no guideline applies. Open a project with Swift, HTML, JSX or CSS.</Text>
      ) : (
        <Box flexDirection="column">
          <Text>
            <Text color="success">{bar(t.percent, Math.min(30, width - 24))}</Text> <Text bold>{t.percent}%</Text> covered · {t.pass} of {t.applicable}
          </Text>
          <Text>
            <Text color="error">✗ {t.gap} gaps</Text>   <Text color="warning">? {t.review} to review</Text>   <Text color="success">✓ {t.pass} covered</Text>   <Text dimColor>– {t.na} n/a</Text>
          </Text>
          <Text> </Text>
          {areas.map(a => (
            <Text key={`a:${a.area}`} wrap="truncate">
              {a.area.padEnd(areaWidth)} <Text color={a.tally.gap ? 'warning' : 'success'}>{bar(a.tally.percent, 10)}</Text> {a.tally.pass}/{a.tally.applicable}
              <Text dimColor>{a.tally.gap ? ` · ${a.tally.gap} gap${a.tally.gap > 1 ? 's' : ''}` : ''}{a.tally.review ? ` · ${a.tally.review} to review` : ''}</Text>
            </Text>
          ))}
        </Box>
      )}
      <Text> </Text>
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        <Button key="f:gap" hotkey="g" plain label={`${filter === 'gap' ? '▸' : ''}gaps ${t.gap}`} onPress={pick('gap')} />
        <Button key="f:review" hotkey="v" plain label={`${filter === 'review' ? '▸' : ''}review ${t.review}`} onPress={pick('review')} />
        <Button key="f:pass" hotkey="p" plain label={`${filter === 'pass' ? '▸' : ''}covered ${t.pass}`} onPress={pick('pass')} />
        <Button key="f:all" hotkey="a" plain label={`${filter === 'all' ? '▸' : ''}all ${report.findings.length}`} onPress={pick('all')} />
      </Box>
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        <Button key="rescan" hotkey="r" plain label={isScanning ? 'scanning…' : 'rescan'} onPress={() => void scan($)} />
        {t.gap > 0 ? <Button key="fix-all" hotkey="f" plain label="fix all gaps" onPress={() => void current($).then(r => send($, fixPrompt(r, r.findings.filter(f => f.status === 'gap').map(f => f.id)), 'Fix all gaps'))} /> : null}
        {t.review > 0 ? <Button key="review-all" hotkey="d" plain label="review with Claude" onPress={() => void current($).then(r => send($, reviewPrompt(r, r.findings.filter(f => f.status === 'review').map(f => f.id)), 'Review'))} /> : null}
        <Button key="export" hotkey="x" plain label={`export ${REPORT_FILE}`} onPress={() => void exportReport($).then(p => $.ui.toast(`Wrote ${p}`), err => $.ui.toast(`Could not write the report: ${String(err)}`))} />
      </Box>
      <Text> </Text>
      {shown.length === 0 ? <Text dimColor>{filter === 'gap' ? 'No gaps found. ' : 'Nothing here. '}Press a to see every guideline.</Text> : null}
      {shown.map(f => {
        const r = ruleById(f.id)!
        const count = f.status === 'gap' && f.hits.length ? `  ${f.hits.length >= 40 ? '40+' : f.hits.length}` : ''
        const label = `${ICON[f.status]} ${r.title}${count}`
        return (
          <Box key={`row:${f.id}`} flexDirection="row">
            <Text color={COLOR[f.status]}> </Text>
            <Button key={`r:${f.id}`} plain label={label.length > width - 2 ? `${label.slice(0, width - 3)}…` : label} onPress={() => void update($, openA, () => f.id)} />
          </Box>
        )
      })}
    </Box>
  )
}

function order(f: Finding): number {
  const rank: Record<Status, number> = { gap: 0, review: 1, pass: 2, na: 3 }
  return rank[f.status] * 100 + RULES.findIndex(r => r.id === f.id)
}

async function drawDetail($: $, e: PaneEvent, report: Report, f: Finding) {
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  const r = ruleById(f.id)!
  const back = () => void update($, openA, () => null)
  return (
    <Box flexDirection="column">
      <Text bold color={COLOR[f.status]}>{ICON[f.status]} {r.title}</Text>
      <Text dimColor>{r.area} · {f.isWaived ? 'waived by you' : WORD[f.status]}{f.auto !== f.status && !f.isWaived ? ` (check: ${WORD[f.auto]})` : ''}</Text>
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        <Button key="back" hotkey="b" plain label="back" onPress={back} />
        {f.status === 'gap' ? <Button key="fix" hotkey="f" plain label="ask Claude to fix" onPress={() => void send($, fixPrompt(report, [f.id]), r.title)} /> : null}
        {f.auto === 'review' && !f.isWaived ? <Button key="review" hotkey="v" plain label="ask Claude to review" onPress={() => void send($, reviewPrompt(report, [f.id]), r.title)} /> : null}
        {f.auto === 'review' && !f.isWaived ? <Button key="yes" hotkey="y" plain label="mark covered" onPress={() => void setVerdict($, f.id, 'pass', 'Marked covered in the pane.', 'you')} /> : null}
        {f.auto === 'review' && !f.isWaived ? <Button key="no" hotkey="n" plain label="mark gap" onPress={() => void setVerdict($, f.id, 'gap', 'Marked as a gap in the pane.', 'you')} /> : null}
        {f.auto !== 'na' ? <Button key="waive" hotkey="w" plain label={f.isWaived ? 'stop waiving' : 'waive (not for this app)'} onPress={() => void toggleWaive($, f.id)} /> : null}
      </Box>
      <Text> </Text>
      <Text>{r.guidance}</Text>
      <Link href={url(r)} label={`HIG: ${r.slug.replace(/-/g, ' ')} ↗`} />
      <Text> </Text>
      <Text bold>What the check found</Text>
      <Text dimColor={f.status !== 'gap'}>{f.note}</Text>
      {r.ask && f.auto === 'review' ? <Text dimColor>To judge: {r.ask}</Text> : null}
      {f.verdict ? (
        <Box flexDirection="column">
          <Text> </Text>
          <Text bold>Verdict ({f.verdict.by === 'claude' ? 'Claude' : 'you'}, {new Date(f.verdict.at).toISOString().slice(0, 10)})</Text>
          <Text color={COLOR[f.verdict.status]}>{f.verdict.status === 'pass' ? 'covered' : 'gap'}: {f.verdict.note}</Text>
        </Box>
      ) : null}
      {f.hits.length ? (
        <Box flexDirection="column">
          <Text> </Text>
          <Text bold>Where ({f.hits.length >= 40 ? 'first 40' : f.hits.length})</Text>
          {f.hits.map((hit, i) => (
            <Text key={`h:${i}`} wrap="truncate">
              <Text color="suggestion">{hit.path}:{hit.line}</Text> <Text dimColor>{hit.text}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

// ---- hooks ----

export const register: Register = (on, options) => {
  const guide = options.guide !== 'off'
  const editCheck = options.editCheck !== 'off'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hig',
      description: "Audit the app against Apple's Human Interface Guidelines: open the pane, or scan, fix, review, report",
      argumentHint: '[scan | fix | review | report]',
    })
    await $.tool.register({
      name: 'audit',
      description:
        "The project's audit against Apple's Human Interface Guidelines: which guidelines are covered, which are gaps (with file:line places), and which need review, each with its HIG link. Read it before UI work or when asked about design quality, accessibility or HIG compliance.",
      inputSchema: {
        type: 'object',
        properties: {
          which: { type: 'string', enum: ['open', 'all'], description: 'open: gaps and review items (default); all: every guideline.' },
          area: { type: 'string', description: 'Only this area: Accessibility, Color, Typography, Layout, Icons, Writing, Privacy, Patterns, Components, Principles.' },
          rescan: { type: 'boolean', description: 'Read the project again first (after changes the edit check did not see).' },
        },
      },
    })
    await $.tool.register({
      name: 'verdict',
      description:
        'Records your judgment of a Human Interface Guidelines item the automatic checks cannot settle (status "review" in the audit), after you have read the relevant UI code. It shows in the HIG audit pane and is kept for this project.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', enum: RULES.map(r => r.id), description: 'The guideline id from the audit, in brackets.' },
          status: { type: 'string', enum: ['pass', 'gap'], description: 'pass: the app follows it; gap: it does not.' },
          note: { type: 'string', description: 'One or two sentences: what you looked at and what you found.' },
        },
        required: ['id', 'status', 'note'],
      },
    })
    // Clears the status line entry earlier versions set.
    $.ui.status(undefined)
    $.clock.after(50, () => void scan($).catch(() => undefined))
    return next(e)
  })

  on('command.run', { command: 'hig' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'scan') {
      const r = await scan($)
      const t = tally(r.findings)
      return { text: `HIG audit: ${t.pass} of ${t.applicable} guidelines covered (${t.percent}%), ${t.gap} gaps, ${t.review} to review.` }
    }
    if (arg === 'fix' || arg === 'review') {
      const r = await current($)
      const ids = r.findings.filter(f => f.status === (arg === 'fix' ? 'gap' : 'review')).map(f => f.id)
      if (ids.length === 0) return { text: arg === 'fix' ? 'HIG audit: no gaps to fix.' : 'HIG audit: nothing to review.' }
      await $.prompt.submit({ text: arg === 'fix' ? fixPrompt(r, ids) : reviewPrompt(r, ids) })
      return { text: `HIG audit: asked Claude to ${arg} ${ids.length} guideline${ids.length > 1 ? 's' : ''}.` }
    }
    if (arg === 'report') return { text: `HIG audit written to ${await exportReport($)}.` }
    if (!(await read($, reportA))) void scan($).catch(() => undefined)
    await update($, openA, () => null)
    const opened = await $.ui.open({ id: PANE, title: 'HIG audit', focus: true, columns: 72 })
    if (!opened.isPlaced) return { text: 'HIG: widen the terminal to see the pane, or run /hig report for a Markdown report.' }
    return { text: 'HIG audit pane opened.' }
  })

  on('tool.call', { tool: 'mcp__hig__audit' }, async ($, e) => {
    const input = e as unknown as { which?: 'open' | 'all'; area?: string; rescan?: boolean }
    const report = input.rescan ? await scan($) : await current($)
    if (!(report.stack.apple || report.stack.web)) return { result: 'HIG audit: no Apple or web interface code in this project, so no guideline applies.' }
    return { result: auditText(report, input.which ?? 'open', input.area) }
  })

  on('tool.call', { tool: 'mcp__hig__verdict' }, async ($, e) => {
    const input = e as unknown as { id?: string; status?: string; note?: string }
    const rule = input.id ? ruleById(input.id) : undefined
    if (!rule) return { result: `No guideline "${input.id}". Ids: ${RULES.map(r => r.id).join(', ')}.` }
    if (input.status !== 'pass' && input.status !== 'gap') return { result: 'status must be pass or gap.' }
    await setVerdict($, rule.id, input.status, (input.note ?? '').trim() || '(no note)', 'claude')
    const report = await current($)
    const f = report.findings.find(x => x.id === rule.id)
    const decides = f?.auto === 'review'
    return {
      result: decides
        ? `Recorded: ${rule.title} is ${input.status === 'pass' ? 'covered' : 'a gap'}.`
        : `Recorded your note on ${rule.title}; its automatic check (${f ? WORD[f.auto] : 'n/a'}) still decides its status.`,
    }
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!editCheck || (e.tool !== 'Write' && e.tool !== 'Edit') || result.deny !== undefined || result.isError) return result
    try {
      const root = await $.session.root()
      const abs = e.file_path
      if (!abs.startsWith(`${root}/`)) return result
      const rel = abs.slice(root.length + 1)
      if (!isRelevant(rel)) return result
      const checked = await recheck($, root, rel)
      if (!checked) return result
      const found = newHits(checked.before, checked.after, rel)
      if (found.length === 0) return result
      return { ...result, context: [...(result.context ?? []), editNote(rel, found)] }
    } catch {
      // The check is advice; the edit stands either way.
      return result
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (!guide) return out
    let report = await read($, reportA)
    if (!report && pending) report = await Promise.race([pending, $.clock.sleep(3000).then(() => null)]).catch(() => null)
    if (!report || !(report.stack.apple || report.stack.web)) return out
    return { sections: [...out.sections, { id: 'hig:guidelines', text: digest(report.stack), scope: 'session' as const }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))
}
