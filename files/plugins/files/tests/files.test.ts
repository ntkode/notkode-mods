import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { arrange, decodeBmp, fromBase64, fitCells, parent, rasterCells, relative } from '../hooks/logic'

const ROOT = '/home/t/project'
const UNCUT = { isStdoutTruncated: false, isStderrTruncated: false }
const PANE_PROPS = { title: 'Files', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

type World = { files: Record<string, string>; dirs: Set<string>; ignored: string[]; prompt: string[]; panes: string[]; runs: string[][]; env: Record<string, string> }

/** A small project on a fake disk: folders, a README, a gitignored folder, and git's answers. */
function world(on: On): World {
  const w: World = {
    files: {
      [`${ROOT}/README.md`]: '# Hello\n\nSome **bold** words.\n',
      [`${ROOT}/guide.pdf`]: '%PDF-1.4\n',
      [`${ROOT}/src/main.ts`]: 'export const x = 1\n',
      [`${ROOT}/.env`]: 'SECRET=1\n',
      [`${ROOT}/dist/out.js`]: 'x\n',
      [`${ROOT}/node_modules/a/index.js`]: 'x\n',
    },
    dirs: new Set([ROOT, `${ROOT}/src`, `${ROOT}/dist`, `${ROOT}/node_modules`, `${ROOT}/node_modules/a`, `${ROOT}/.git`]),
    ignored: ['dist'],
    prompt: [],
    panes: [],
    runs: [],
    env: {},
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('env.get', (_$, e) => ({ value: w.env[e.name] }))
  on('fs.read', (_$, e) => (w.files[e.path] !== undefined ? { value: w.files[e.path]! } : { deny: 'ENOENT' }))
  on('fs.stat', (_$, e) => {
    if (w.dirs.has(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 1, isLink: false } }
    const text = w.files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file' as const, size: text.length, mtimeMs: 1, isLink: false } }
  })
  on('fs.list', (_$, e) => {
    const dir = e.path ?? ROOT
    const names = new Map<string, 'file' | 'dir'>()
    for (const d of w.dirs) if (parent(d) === dir && d !== dir) names.set(d.slice(dir.length + 1), 'dir')
    for (const f of Object.keys(w.files)) {
      if (!f.startsWith(`${dir}/`)) continue
      const rest = f.slice(dir.length + 1)
      if (!rest.includes('/')) names.set(rest, 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: w.files[`${dir}/${name}`]?.length ?? 0, mtimeMs: 1, isLink: false })) }
  })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    if (argv[0] === 'git' && argv.includes('check-ignore')) {
      const names = argv.slice(argv.indexOf('--') + 1).filter(n => w.ignored.includes(n))
      return { value: { exitCode: names.length ? 0 : 1, stdout: names.map(n => `${n}\n`).join(''), stderr: '', ...UNCUT } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', ...UNCUT } }
  })
  on('prompt.fill', (_$, e) => {
    w.prompt.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', (_$, e) => {
    w.panes.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('tool.call', () => ({ result: 'done', text: 'ok' }) as never)
  return w
}

async function start($: Engine) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

async function files($: Engine, args = '') {
  return $.command.run({ command: 'files', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/files on ${surface}: folders first, ignored and hidden left out, a folder opens, a Markdown file renders`, async ($, on) => {
    mock.clock(on, { now: 1_000 })
    const w = world(on)
    await start($)
    const out = await files($)
    expect(out.text).toContain('Files pane opened')
    expect(w.panes).toEqual(['files'])

    const pane = await $.ui.mount({ plugin: 'files', surface, component: 'Pane', requestId: 'files', props: PANE_PROPS })
    expect(await pane.find({ type: 'Button', key: 'e:src' })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'e:README.md' })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'e:dist' })).toBeUndefined()
    expect(await pane.find({ type: 'Button', key: 'e:node_modules' })).toBeUndefined()
    expect(await pane.find({ type: 'Button', key: 'e:.env' })).toBeUndefined()

    await pane.press({ key: 'hidden' })
    expect(await pane.find({ type: 'Button', key: 'e:dist' })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'e:.env' })).toBeDefined()
    await pane.press({ key: 'hidden' })

    await pane.press({ key: 'e:src' })
    expect(await pane.find({ type: 'Button', key: 'e:main.ts' })).toBeDefined()
    await pane.press({ key: 'up' })

    await pane.press({ key: 'e:README.md' })
    const doc = await pane.find({ type: 'Markdown', key: 'doc' })
    expect(doc?.text).toContain('# Hello')
    await pane.press({ key: 'raw' })
    expect(await pane.find({ type: 'Markdown', key: 'doc' })).toBeUndefined()
    expect(await pane.find({ type: 'Code' })).toBeDefined()

    await pane.press({ key: 'attach' })
    expect(w.prompt).toEqual(['@README.md '])
    await pane.press({ key: 'back' })
    expect(await pane.find({ type: 'Button', key: 'e:src' })).toBeDefined()
    await pane.unmount()
  })
}

test('/files <file> opens the pane on that file', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  world(on)
  await start($)
  const out = await files($, 'src/main.ts')
  expect(out.text).toContain('src/main.ts')
  const pane = await $.ui.mount({ plugin: 'files', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })
  const code = await pane.find({ type: 'Code' })
  expect(code).toBeDefined()
  await pane.unmount()
})

test('a file the pane cannot show opens in its default app when picked, once', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)
  await start($)
  await files($)
  const pane = await $.ui.mount({ plugin: 'files', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })
  await pane.press({ key: 'e:guide.pdf' })
  expect(await pane.find({ text: /Opened it in its default app/ })).toBeDefined()
  expect(w.runs.filter(r => r[0] === 'open')).toEqual([['open', `${ROOT}/guide.pdf`]])
  await pane.press({ key: 'reveal' })
  expect(w.runs.filter(r => r[0] === 'open').length).toBe(2)
  await pane.unmount()
})

test('e edits a Markdown file in a GUI editor, else the default text editor', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)
  await start($)
  await files($, 'README.md')
  const pane = await $.ui.mount({ plugin: 'files', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })
  expect(w.runs.some(r => r[0] === 'open')).toBe(false)
  await pane.press({ key: 'edit' })
  expect(w.runs.at(-1)).toEqual(['open', '-t', `${ROOT}/README.md`])
  w.env.VISUAL = 'code --wait'
  await pane.press({ key: 'edit' })
  expect(w.runs.at(-1)).toEqual(['code', '--wait', `${ROOT}/README.md`])
  w.env.VISUAL = 'vim'
  await pane.press({ key: 'edit' })
  expect(w.runs.at(-1)).toEqual(['open', '-t', `${ROOT}/README.md`])
  await pane.unmount()
})

test('files Claude reads and changes are listed under touched, an edit marked as one', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  world(on)
  await start($)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/README.md` })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/main.ts`, old_string: '1', new_string: '2' })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/main.ts` })
  await files($)
  const pane = await $.ui.mount({ plugin: 'files', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })
  await pane.press({ key: 'touched' })
  expect(await pane.find({ text: /2 files, 1 changed/ })).toBeDefined()
  const edited = await pane.find({ type: 'Button', key: `t:${ROOT}/src/main.ts` })
  expect(edited?.text).toContain('✎ src/main.ts')
  const readOnly = await pane.find({ type: 'Button', key: `t:${ROOT}/README.md` })
  expect(readOnly?.text).toContain('· README.md')
  await pane.unmount()
})

test('logic: sorting, paths, picture sizes', () => {
  const sorted = arrange(
    [
      { name: 'b.md', kind: 'file', size: 1 },
      { name: 'src', kind: 'dir', size: 0 },
      { name: '.git', kind: 'dir', size: 0 },
      { name: 'a10.md', kind: 'file', size: 1 },
      { name: 'a2.md', kind: 'file', size: 1 },
    ],
    { showHidden: false },
  ).map(e => e.name)
  expect(sorted).toEqual(['src', 'a2.md', 'a10.md', 'b.md'])
  expect(relative('/r', '/r/a/b')).toBe('a/b')
  expect(relative('/r', '/other')).toBe('/other')
  expect(parent('a/b/c')).toBe('a/b')
  expect(parent('a')).toBe('')
  // A wide picture keeps its aspect, cells being twice as tall as wide.
  expect(fitCells(200, 100, 80, 40)).toEqual({ columns: 80, rows: 20 })
  // A tall one is held to the rows and narrowed to match.
  expect(fitCells(100, 400, 80, 20)).toEqual({ columns: 10, rows: 20 })
})

test('logic: a 24-bit bottom-up BMP decodes and packs two pixels per cell', () => {
  // 2x2: bottom row stored first. Top row red, blue; bottom row green, white.
  const width = 2, height = 2, stride = 8
  const bytes = new Uint8Array(54 + stride * height)
  const v = new DataView(bytes.buffer)
  bytes[0] = 0x42; bytes[1] = 0x4d
  v.setUint32(10, 54, true)
  v.setInt32(18, width, true)
  v.setInt32(22, height, true)
  v.setUint16(28, 24, true)
  v.setUint32(30, 0, true)
  const put = (row: number, x: number, r: number, g: number, b: number) => bytes.set([b, g, r], 54 + row * stride + x * 3)
  put(0, 0, 0, 255, 0) // stored first: the bottom row
  put(0, 1, 255, 255, 255)
  put(1, 0, 255, 0, 0)
  put(1, 1, 0, 0, 255)
  const px = decodeBmp(bytes)
  expect([...px.rgb]).toEqual([0xff0000, 0x0000ff, 0x00ff00, 0xffffff])
  const packed = rasterCells(px)
  expect(packed.columns).toBe(2)
  expect(packed.rows).toBe(1)
  const words = new Uint32Array(fromBase64(packed.cells).buffer)
  expect([...words]).toEqual([0x2580, 0xff0000, 0x00ff00, 0x2580, 0x0000ff, 0xffffff])
})
