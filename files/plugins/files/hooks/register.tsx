import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { ImageMode, Touch } from '../types'
import {
  absolute, arrange, baseName, clip, decodeBmp, ext, fitCells, hasPixels, humanSize, join, kindOf,
  fromBase64, looksBinary, MAX_ENTRIES, parent, pngSize, rasterCells, relative,
} from './logic'
import type { Entry } from './logic'

type $ = EngineInterface
type PaneEvent = RenderInput<'Pane'>

const PANE = 'files'
/** Columns the dock asks for: room for a Markdown table drawn as the chat draws it. */
const WIDE = 100
const NARROW = 60
const MAX_READ = 4 * 1024 * 1024

const dirA = atom({ plugin: 'files', key: 'dir' } as const, '')
const openA = atom({ plugin: 'files', key: 'open' } as const, null)
const viewA = atom({ plugin: 'files', key: 'view' } as const, 'tree')
const rawA = atom({ plugin: 'files', key: 'isRaw' } as const, false)
const hiddenA = atom({ plugin: 'files', key: 'showHidden' } as const, false)
const imageA = atom({ plugin: 'files', key: 'imageMode' } as const, 'auto')
const filterA = atom({ plugin: 'files', key: 'filter' } as const, '')
const touchedA = atom({ plugin: 'files', key: 'touched' } as const, [])
const stampA = atom({ plugin: 'files', key: 'stamp' } as const, 0)

/** Pictures already turned into cells or a PNG, by path, mtime and size: drawing again costs nothing. */
const pictureCache = new Map<string, Picture>()
type Picture =
  | { kind: 'pixels'; file: string; columns: number; rows: number; generation: number }
  | { kind: 'blocks'; cells: string; columns: number; rows: number }
  | { kind: 'none'; why: string }

/** What the poll saw last for the open file or folder. */
let lastSeen = ''

/** The file just opened by the person, until it is drawn: one the pane cannot show then opens outside, once. */
let pendingOutside: string | null = null

/** Editors that open a window of their own; a terminal editor cannot take the pane's terminal. */
const GUI_EDITORS = /(^|\/)(code|code-insiders|cursor|windsurf|zed|subl|mate|bbedit|gedit|kate|idea|webstorm|nova)( |$)/

async function root($: $): Promise<string> {
  return $.session.root()
}

async function openFile($: $, abs: string) {
  pendingOutside = abs
  await update($, openA, () => abs)
  await update($, filterA, () => '')
}

async function openDir($: $, rel: string) {
  await update($, dirA, () => rel)
  await update($, openA, () => null)
  await update($, viewA, () => 'tree')
  await update($, filterA, () => '')
}

/** Names in `absDir` that git ignores; empty outside a repository or without git. */
async function ignoredNames($: $, absDir: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set()
  try {
    const run = await $.process.run(['git', '-C', absDir, 'check-ignore', '--', ...names], { timeoutMs: 3000 })
    return new Set(run.stdout.split('\n').map(s => s.trim()).filter(Boolean))
  } catch {
    return new Set()
  }
}

async function tmpDir($: $): Promise<string> {
  const base = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  const dir = `${base}/claude-files-mod`
  await $.process.run(['mkdir', '-p', dir]).catch(() => undefined)
  return dir
}

/** Opens `abs` in the computer's default app for it (macOS `open`, Linux `xdg-open`, Windows `start`). */
async function openOutside($: $, abs: string, opts: { asText?: boolean } = {}): Promise<boolean> {
  const tries: string[][] = (await $.env.get('OS')) === 'Windows_NT'
    ? [['cmd', '/c', 'start', '', abs]]
    : [opts.asText ? ['open', '-t', abs] : ['open', abs], ['xdg-open', abs]]
  for (const argv of tries) {
    const run = await $.process.run(argv, { timeoutMs: 10000 }).catch(() => undefined)
    if (run && run.exitCode === 0) return true
  }
  return false
}

/** Opens `abs` for editing: the person's GUI editor when `$VISUAL` or `$EDITOR` names one, else the default text editor. */
async function editOutside($: $, abs: string) {
  const editor = ((await $.env.get('VISUAL')) || (await $.env.get('EDITOR')) || '').trim()
  if (GUI_EDITORS.test(editor)) {
    const argv = [...editor.split(/\s+/), abs]
    const run = await $.process.run(argv, { timeoutMs: 10000 }).catch(() => undefined)
    if (run && run.exitCode === 0) return $.ui.toast(`${baseName(abs)} opened in ${baseName(argv[0]!)}; the pane follows your saves`)
  }
  if (await openOutside($, abs, { asText: true })) return $.ui.toast(`${baseName(abs)} opened for editing; the pane follows your saves`)
  $.ui.toast('could not open an editor')
}

function hash(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

/** The picture's size in pixels, from its PNG header or macOS `sips`. */
async function pictureSize($: $, abs: string): Promise<{ width: number; height: number } | undefined> {
  if (ext(abs) === 'png') {
    const { base64 } = await $.fs.read(abs, { as: 'bytes' })
    const size = pngSize(fromBase64(base64).subarray(0, 32))
    if (size) return size
  }
  const run = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', abs], { timeoutMs: 5000 }).catch(() => undefined)
  if (!run || run.exitCode !== 0) return undefined
  const width = Number(/pixelWidth:\s*(\d+)/.exec(run.stdout)?.[1])
  const height = Number(/pixelHeight:\s*(\d+)/.exec(run.stdout)?.[1])
  return width > 0 && height > 0 ? { width, height } : undefined
}

async function picture($: $, abs: string, mtime: number, mode: 'pixels' | 'blocks', maxColumns: number, maxRows: number): Promise<Picture> {
  const cacheKey = `${abs}|${mtime}|${mode}|${maxColumns}|${maxRows}`
  const cached = pictureCache.get(cacheKey)
  if (cached) return cached
  const made = await makePicture($, abs, mtime, mode, maxColumns, maxRows).catch((err: unknown): Picture => ({ kind: 'none', why: String(err instanceof Error ? err.message : err) }))
  if (pictureCache.size > 40) pictureCache.clear()
  pictureCache.set(cacheKey, made)
  return made
}

async function makePicture($: $, abs: string, mtime: number, mode: 'pixels' | 'blocks', maxColumns: number, maxRows: number): Promise<Picture> {
  const size = await pictureSize($, abs)
  if (!size) return { kind: 'none', why: "its size could not be read (pictures other than PNG need macOS's sips)" }
  const fit = fitCells(size.width, size.height, maxColumns, maxRows)
  const dir = await tmpDir($)
  const stem = `${dir}/${hash(`${abs}|${mtime}`)}`
  if (mode === 'pixels') {
    if (ext(abs) === 'png') return { kind: 'pixels', file: abs, ...fit, generation: Math.floor(mtime) }
    const out = `${stem}.png`
    const run = await $.process.run(['sips', '-s', 'format', 'png', abs, '--out', out], { timeoutMs: 15000 })
    if (run.exitCode !== 0) return { kind: 'none', why: 'sips could not convert it to PNG' }
    return { kind: 'pixels', file: out, ...fit, generation: Math.floor(mtime) }
  }
  const out = `${stem}-${fit.columns}x${fit.rows * 2}.bmp`
  const run = await $.process.run(['sips', '-s', 'format', 'bmp', '-z', String(fit.rows * 2), String(fit.columns), abs, '--out', out], { timeoutMs: 15000 })
  if (run.exitCode !== 0) return { kind: 'none', why: 'sips could not scale it' }
  const { base64 } = await $.fs.read(out, { as: 'bytes' })
  const packed = rasterCells(decodeBmp(fromBase64(base64)))
  return { kind: 'blocks', ...packed }
}

async function pickMode($: $, mode: ImageMode): Promise<'pixels' | 'blocks'> {
  if (mode !== 'auto') return mode
  const term = await $.env.get('TERM')
  const termProgram = await $.env.get('TERM_PROGRAM')
  const kitty = await $.env.get('KITTY_WINDOW_ID')
  const ghostty = await $.env.get('GHOSTTY_RESOURCES_DIR')
  return hasPixels({ term, termProgram, kitty, ghostty }) ? 'pixels' : 'blocks'
}

function nextImageMode(mode: ImageMode): ImageMode {
  return mode === 'auto' ? 'pixels' : mode === 'pixels' ? 'blocks' : 'auto'
}

async function addToPrompt($: $, abs: string) {
  const rel = relative(await root($), abs)
  await $.prompt.fill({ text: `@${rel.includes(' ') ? `"${rel}"` : rel} `, mode: 'insert' })
  $.ui.toast(`${rel} added to the prompt`)
}

async function recordTouch($: $, path: string, how: Touch['how']) {
  const at = await $.clock.now()
  await update($, touchedA, list => {
    const old = (list ?? []).find(t => t.path === path)
    const kept = (list ?? []).filter(t => t.path !== path)
    // An edit stays an edit when the file is read again afterwards.
    const mark: Touch['how'] = old?.how === 'edit' ? 'edit' : how
    return [{ path, how: mark, at }, ...kept].slice(0, 300)
  })
}

/** Docks the pane wide enough for tables, or back to narrow. */
async function toggleWide($: $, columns: number) {
  await $.ui.open({ id: PANE, title: 'Files', columns: columns >= WIDE ? NARROW : WIDE })
}

/** Whether the pane is on screen now. */
async function isShown($: $): Promise<boolean> {
  const panes = await $.ui.panes()
  return panes.some(p => p.id === PANE && p.isShown)
}

/** Raises `stamp` when the open file or the folder shown changed on disk. */
async function poll($: $) {
  if (!(await isShown($))) return
  const open = await read($, openA)
  let seen: string
  if (open) {
    const stat = await $.fs.stat(open).catch(() => undefined)
    seen = `f|${open}|${stat?.mtimeMs ?? 'gone'}|${stat?.size ?? 0}`
  } else {
    const view = await read($, viewA)
    if (view !== 'tree') return
    const abs = absolute(await root($), await read($, dirA))
    const entries = await $.fs.list(abs).catch(() => [])
    seen = `d|${abs}|${entries.length}|${hash(entries.map(e => `${e.name}:${e.kind}`).join('/'))}`
  }
  if (lastSeen !== '' && seen !== lastSeen) await update($, stampA, n => (n ?? 0) + 1)
  lastSeen = seen
}

// ---- drawing ----

async function drawPane($: $, e: PaneEvent) {
  const { Box, Text } = $.ui.resolve(e)
  await read($, stampA)
  const open = await read($, openA)
  const view = await read($, viewA)
  const body = (() => {
    if (open) return drawFile($, e, open)
    if (view === 'touched') return drawTouched($, e)
    return drawDir($, e)
  })()
  try {
    return await body
  } catch (err) {
    return (
      <Box flexDirection="column">
        <Text color="error">Could not draw this: {String(err instanceof Error ? err.message : err)}</Text>
      </Box>
    )
  }
}

function crumbs(rootAbs: string, rel: string): string {
  const name = baseName(rootAbs) || rootAbs
  if (rel === '') return `${name}/`
  return rel.startsWith('/') ? rel : `${name}/${rel}`
}

async function drawDir($: $, e: PaneEvent) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  // Mobile draws no text fields: the filter is left out there.
  const Input = 'Input' in els ? els.Input : undefined
  const rootAbs = await root($)
  const rel = await read($, dirA)
  const showHidden = await read($, hiddenA)
  const filter = await read($, filterA)
  const abs = absolute(rootAbs, rel)
  let raw: Entry[]
  try {
    raw = await $.fs.list(abs)
  } catch (err) {
    return (
      <Box flexDirection="column">
        <Text color="error">Cannot list {abs}: {String(err instanceof Error ? err.message : err)}</Text>
        <Button key="up" hotkey="u" plain label="up" onPress={() => void openDir($, parent(rel))} />
      </Box>
    )
  }
  const ignored = showHidden ? new Set<string>() : await ignoredNames($, abs, raw.filter(x => !x.name.startsWith('.')).map(x => x.name))
  const all = arrange(raw, { showHidden, ignored })
  const needle = filter.trim().toLowerCase()
  const entries = needle ? all.filter(x => x.name.toLowerCase().includes(needle)) : all
  const shown = entries.slice(0, MAX_ENTRIES)
  const width = Math.max(20, e.props.bodyColumns)
  const nameWidth = Math.max(10, width - 12)
  const go = (x: Entry) => (x.kind === 'dir' ? openDir($, join(rel, x.name)) : openFile($, absolute(rootAbs, join(rel, x.name))))

  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-start">{crumbs(rootAbs, rel)}</Text>
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        {rel !== '' ? <Button key="up" hotkey="u" plain label="up" onPress={() => void openDir($, parent(rel))} /> : null}
        <Button key="touched" hotkey="t" plain label="touched" onPress={() => void update($, viewA, () => 'touched')} />
        <Button key="hidden" hotkey="h" plain label={showHidden ? 'hide ignored' : 'show all'} onPress={() => void update($, hiddenA, v => !v)} />
      </Box>
      {Input ? (
        <Input
          key="filter"
          label="filter "
          placeholder="type to narrow, Enter opens the first"
          value={filter}
          onInput={value => void update($, filterA, () => value)}
          onSubmit={() => {
            const first = entries[0]
            if (first) void go(first)
          }}
        />
      ) : null}
      <Text> </Text>
      {shown.length === 0 ? <Text dimColor>{needle ? 'Nothing matches.' : 'Empty folder.'}</Text> : null}
      {shown.map(x => (
        <Button
          key={`e:${x.name}`}
          plain
          label={x.kind === 'dir' ? `▸ ${x.name}/` : `  ${x.name.length > nameWidth ? `${x.name.slice(0, nameWidth - 1)}…` : x.name.padEnd(nameWidth)} ${x.kind === 'file' ? humanSize(x.size) : ''}`}
          onPress={() => void go(x)}
        />
      ))}
      {entries.length > shown.length ? <Text dimColor>…and {entries.length - shown.length} more; type in the filter to narrow.</Text> : null}
    </Box>
  )
}

async function drawTouched($: $, e: PaneEvent) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const rootAbs = await root($)
  const list = await read($, touchedA)
  const edits = list.filter(t => t.how === 'edit').length

  return (
    <Box flexDirection="column">
      <Text bold>Touched this session · {list.length} files, {edits} changed</Text>
      <Box flexDirection="row" columnGap={2}>
        <Button key="tree" hotkey="t" plain label="folders" onPress={() => void update($, viewA, () => 'tree')} />
      </Box>
      <Text> </Text>
      {list.length === 0 ? <Text dimColor>Claude has not read or changed a file yet this session.</Text> : null}
      {list.map(t => (
        <Button
          key={`t:${t.path}`}
          plain
          label={`${t.how === 'edit' ? '✎' : '·'} ${relative(rootAbs, t.path)}`}
          onPress={() => void openFile($, t.path)}
        />
      ))}
      <Text> </Text>
      <Text dimColor>✎ changed · read only</Text>
    </Box>
  )
}

async function drawFile($: $, e: PaneEvent, abs: string) {
  const { Box, Text, Button, Markdown, Code } = $.ui.resolve(e)
  const rootAbs = await root($)
  const isRaw = await read($, rawA)
  const imageMode = await read($, imageA)
  const view = await read($, viewA)
  const kind = kindOf(abs)
  const stat = await $.fs.stat(abs).catch(() => undefined)

  const header = (
    <Box flexDirection="column">
      <Text bold wrap="truncate-start">{relative(rootAbs, abs)}{stat ? `  ·  ${humanSize(stat.size)}` : ''}</Text>
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        <Button key="back" hotkey="b" plain label={view === 'touched' ? 'back to touched' : 'back'} onPress={() => void update($, openA, () => null)} />
        <Button key="attach" hotkey="a" plain label="add to prompt" onPress={() => void addToPrompt($, abs)} />
        {kind === 'markdown' ? <Button key="raw" hotkey="r" plain label={isRaw ? 'rendered' : 'source'} onPress={() => void update($, rawA, v => !v)} /> : null}
        {kind === 'image' && e.surface === 'terminal' ? <Button key="image" hotkey="i" plain label={`pictures: ${imageMode}`} onPress={() => void update($, imageA, m => nextImageMode(m ?? 'auto'))} /> : null}
        {kind === 'markdown' || kind === 'text' ? <Button key="edit" hotkey="e" plain label="edit" onPress={() => void editOutside($, abs)} /> : null}
        {kind === 'markdown' && !isRaw && e.props.placement === 'dock' ? <Button key="wide" hotkey="w" plain label={e.props.bodyColumns >= WIDE ? 'narrow' : 'wide'} onPress={() => void toggleWide($, e.props.bodyColumns)} /> : null}
        <Button key="reveal" hotkey="o" plain label="open outside" onPress={() => void openOutside($, abs).then(ok => ok || $.ui.toast('could not open it'))} />
      </Box>
      <Text> </Text>
    </Box>
  )

  const isFresh = pendingOutside === abs
  pendingOutside = null
  /** For a file the pane cannot show: opened outside when the person just picked it, said either way. */
  const outside = (why: string) => {
    if (isFresh) void openOutside($, abs).then(ok => ok || $.ui.toast('could not open it outside'))
    return say(`${why} ${isFresh ? 'Opened it in its default app; o opens it again.' : 'Press o to open it outside.'}`)
  }

  const say = (text: string) => (
    <Box flexDirection="column">
      {header}
      <Text dimColor>{text}</Text>
    </Box>
  )

  if (!stat) return say('This file is gone.')
  if (stat.kind === 'dir') return say('This is a folder.')
  if (kind === 'binary') return outside(`A binary file (${ext(abs) || 'no extension'}): nothing to show here.`)

  if (kind === 'image') {
    if (e.surface !== 'terminal') return outside('Pictures are drawn in the terminal only.')
    const { Image, Raster } = $.ui.resolve(e)
    const maxColumns = Math.max(10, Math.min(e.props.bodyColumns - 1, 160))
    const maxRows = Math.max(6, Math.min((e.props.scroll.bodyRows || 30) - 5, 60))
    const mode = await pickMode($, imageMode)
    const pic = await picture($, abs, stat.mtimeMs, mode, maxColumns, maxRows)
    if (pic.kind === 'none') return outside(`Cannot draw this picture: ${pic.why}.`)
    return (
      <Box flexDirection="column">
        {header}
        {pic.kind === 'pixels' ? (
          <Image key="picture" source={{ file: pic.file, format: 'png', generation: pic.generation }} columns={pic.columns} rows={pic.rows} alt={`${baseName(abs)}: this terminal shows no pictures; press i for blocks`} />
        ) : (
          <Raster key="picture" columns={pic.columns} rows={pic.rows} cells={pic.cells} />
        )}
      </Box>
    )
  }

  if (stat.size > MAX_READ) return outside(`Too large to show here (${humanSize(stat.size)}).`)
  const text = await $.fs.read(abs)
  if (looksBinary(text)) return outside('This file is not text.')
  const { text: shown, isCut } = clip(text)
  const cutNote = isCut ? <Text dimColor>…cut here: the rest is {humanSize(text.length - shown.length)} more. Press o to open it outside.</Text> : null

  if (kind === 'markdown' && !isRaw) {
    return (
      <Box flexDirection="column">
        {header}
        <Markdown key="doc" text={shown} />
        {cutNote}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {header}
      <Code source={shown} path={abs} startLine={1} wrap="wrap" />
      {cutNote}
    </Box>
  )
}

// ---- hooks ----

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'files',
      description: 'Open the files pane: browse the project, read Markdown, see pictures, and the files Claude touched',
      argumentHint: '[folder or file]',
    })
    $.clock.every(1500, () => void poll($).catch(() => undefined))
    return next(e)
  })

  on('command.run', { command: 'files' }, async ($, e) => {
    const rootAbs = await root($)
    const arg = e.args.trim().replace(/^["']|["']$/g, '')
    let where = 'the project root'
    if (arg !== '') {
      const abs = arg.startsWith('/') ? arg : arg.startsWith('~/') ? `${(await $.env.get('HOME')) ?? ''}/${arg.slice(2)}` : absolute(await $.session.cwd(), arg)
      const stat = await $.fs.stat(abs).catch(() => undefined)
      if (!stat) return { text: `files: nothing at ${arg}.` }
      if (stat.kind === 'dir') {
        await openDir($, relative(rootAbs, abs))
      } else {
        await openDir($, relative(rootAbs, parent(abs) || '/'))
        await openFile($, abs)
      }
      where = relative(rootAbs, abs) || 'the project root'
    }
    const opened = await $.ui.open({ id: PANE, title: 'Files', focus: true, columns: WIDE })
    if (!opened.isPlaced) return { text: 'files: widen the terminal to see the pane.' }
    return { text: `Files pane opened at ${where}.` }
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.tool === 'Read') await recordTouch($, e.file_path, 'read')
      else if (e.tool === 'Write' || e.tool === 'Edit') await recordTouch($, e.file_path, 'edit')
      else if (e.tool === 'NotebookEdit') await recordTouch($, e.notebook_path, 'edit')
    } catch {
      // Recording is a convenience; the call's result stands either way.
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))
}
