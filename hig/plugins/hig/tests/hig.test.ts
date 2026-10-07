import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BAD_APP } from './fixtures'

const ROOT = '/home/t/demo'
const UNCUT = { isStdoutTruncated: false, isStderrTruncated: false }
const PANE_PROPS = { title: 'HIG audit', isFocused: true, bodyColumns: 72, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} }

type World = { files: Record<string, string>; written: Record<string, string>; prompts: string[]; status: (string | undefined)[] }

function world(on: On): World {
  const w: World = { files: { ...BAD_APP, 'README.md': '# Demo\n' }, written: {}, prompts: [], status: [] }
  mock.store(on)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__hig__${e.name}` } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'git' && argv.includes('ls-files')) return { value: { exitCode: 0, stdout: Object.keys(w.files).join('\n'), stderr: '', ...UNCUT } }
    return { value: { exitCode: 1, stdout: '', stderr: '', ...UNCUT } }
  })
  on('fs.read', (_$, e) => {
    const text = w.files[e.path.slice(ROOT.length + 1)]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_$, e) => {
    w.written[e.path] = e.text
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', (_$, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('tool.call', () => ({ result: 'done', text: 'ok' }) as never)
  return w
}

async function start($: Engine) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

function hig($: Engine, args: string) {
  return $.command.run({ command: 'hig', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
}

test('/hig scan reports the gaps and leaves the status line alone; Claude reads the guidelines in its system prompt', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)
  await start($)
  const out = await hig($, 'scan')
  expect(out.text).toMatch(/HIG audit: \d+ of \d+ guidelines covered \(\d+%\), \d+ gaps/)
  expect(w.status.filter(Boolean)).toEqual([])

  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const section = composed.sections.find(s => s.id === 'hig:guidelines')
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('Dynamic Type')
  expect(section?.text).toContain('mcp__hig__audit')
})

test('the audit and verdict tools: Claude reads the gaps and records a judgment', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  world(on)
  await start($)
  const read = await $.tool.call({ tool: 'mcp__hig__audit', which: 'open' } as never)
  const text = String(read.result)
  expect(text).toContain('## Gaps')
  expect(text).toContain('[purpose-strings]')
  expect(text).toContain('Demo/DemoApp.swift:')
  expect(text).toContain('[onboarding]')

  const verdict = await $.tool.call({ tool: 'mcp__hig__verdict', id: 'onboarding', status: 'pass', note: 'Opens straight into the list.' } as never)
  expect(String(verdict.result)).toContain('Recorded')
  const all = String((await $.tool.call({ tool: 'mcp__hig__audit', which: 'all', area: 'Patterns' } as never)).result)
  expect(all).toContain('Verdict (claude): pass, Opens straight into the list.')
})

test('an edit that breaks a guideline comes back to Claude with the line and the link', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)
  await start($)
  await hig($, 'scan')
  const path = 'Demo/ContentView.swift'
  w.files[path] = w.files[path]!.replace('Image("logo")', 'Image("logo")\n            Text("Tiny").font(.system(size: 7))')
  const result = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${path}`, old_string: 'a', new_string: 'b', replace_all: false })
  const note = (result.context ?? []).join('\n')
  expect(note).toContain('HIG check of your edit to Demo/ContentView.swift')
  expect(note).toContain('Text is legible')
  expect(note).toContain('https://developer.apple.com/design/human-interface-guidelines/typography')
  expect(note).toContain('.font(.system(size: 7))')

  // An edit to a file outside the UI is left alone.
  const other = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/README.md`, old_string: 'a', new_string: 'b', replace_all: false })
  expect(other.context ?? []).toEqual([])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane on ${surface}: gaps listed, a guideline opened, fix sent to Claude, waived, exported`, async ($, on) => {
    mock.clock(on, { now: 1_000 })
    const w = world(on)
    await start($)
    expect((await hig($, '')).text).toContain('pane opened')
    await hig($, 'scan')

    const pane = await $.ui.mount({ plugin: 'hig', surface, component: 'Pane', requestId: 'hig', props: PANE_PROPS })
    expect(await pane.find({ type: 'Button', key: 'r:dark-mode' })).toBeDefined()
    // Only gaps are listed at first.
    expect(await pane.find({ type: 'Button', key: 'r:voiceover' })).toBeUndefined()
    await pane.press({ key: 'f:review' })
    expect(await pane.find({ type: 'Button', key: 'r:voiceover' })).toBeDefined()
    await pane.press({ key: 'f:gap' })

    await pane.press({ key: 'r:dark-mode' })
    expect(await pane.find({ type: 'Link' })).toBeDefined()
    await pane.press({ key: 'fix' })
    expect(w.prompts.at(-1)).toContain('Dark Mode is supported')
    expect(w.prompts.at(-1)).toContain('preferredColorScheme(.light)')

    await pane.press({ key: 'waive' })
    await pane.press({ key: 'back' })
    expect(await pane.find({ type: 'Button', key: 'r:dark-mode' })).toBeUndefined()

    await pane.press({ key: 'export' })
    expect(w.written[`${ROOT}/HIG-AUDIT.md`]).toContain('# HIG audit')
    await pane.unmount()
  })
}
