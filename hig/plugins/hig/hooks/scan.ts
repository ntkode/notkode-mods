import type { Hit, Stack, Status } from '../types'

/** One file of the project as the checks read it: its path from the project root and its lines. */
export type SourceFile = { path: string; text: string; lines: string[] }

/** What one platform's check of one guideline found. */
export type Outcome = { status: Status; hits: Hit[]; note: string }

/** `paths`: every file in the project, read or not, for checks that only ask whether a file exists. */
export type Ctx = { files: SourceFile[]; stack: Stack; paths: string[] }

export const MAX_HITS = 40

export function file(path: string, text: string): SourceFile {
  return { path, text, lines: text.split('\n') }
}

export function ext(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isSwift = (p: string) => ext(p) === 'swift'
export const isObjC = (p: string) => ext(p) === 'm' || ext(p) === 'mm'
/** Info.plist, the Xcode project, privacy manifests, asset catalogs' Contents.json, storyboards. */
export const isAppleConfig = (p: string) =>
  ['plist', 'pbxproj', 'xcprivacy', 'entitlements', 'storyboard', 'xib', 'xcconfig', 'xcstrings', 'strings'].includes(ext(p)) ||
  p.endsWith('/Contents.json') ||
  p.endsWith('.icon/icon.json') ||
  /(^|\/)(Package|Project)\.swift$/.test(p) ||
  /(^|\/)project\.ya?ml$/.test(p) ||
  // Build scripts that write Info.plist by hand.
  ext(p) === 'sh'
export const isMarkup = (p: string) => ['html', 'htm', 'jsx', 'tsx', 'vue', 'svelte', 'astro'].includes(ext(p))
export const isStyle = (p: string) => ['css', 'scss', 'sass', 'less'].includes(ext(p))
export const isScript = (p: string) => ['js', 'jsx', 'ts', 'tsx', 'mjs', 'vue', 'svelte', 'astro'].includes(ext(p))
export const isWeb = (p: string) => isMarkup(p) || isStyle(p) || isScript(p) || p.endsWith('manifest.json') || p.endsWith('.webmanifest')

/** The files the audit reads: Apple app sources and config, and web UI sources. */
export function isRelevant(path: string): boolean {
  if (/(^|\/)(node_modules|\.git|Pods|Carthage|DerivedData|\.build|build|dist|out|\.next|\.nuxt|coverage|vendor|\.swiftpm|xcuserdata)(\/|$)/.test(path)) return false
  if (/\.min\.(js|css)$/.test(path) || /\.d\.ts$/.test(path)) return false
  if (/(^|\/)([^/]*Tests|tests?|__tests__|spec)(\/|$)/.test(path) || /\.(test|spec)\.[jt]sx?$/.test(path)) return false
  return isSwift(path) || isObjC(path) || isAppleConfig(path) || isWeb(path)
}

/** What the project is made of. */
export function detectStack(files: SourceFile[]): Stack {
  const swift = files.filter(f => isSwift(f.path))
  const apple = swift.length > 0 || files.some(f => ext(f.path) === 'pbxproj' || isObjC(f.path))
  const web = files.some(f => isMarkup(f.path) || isStyle(f.path))
  const all = (re: RegExp, set: SourceFile[]) => set.some(f => re.test(f.text))
  const config = files.filter(f => isAppleConfig(f.path))
  const swiftui = all(/import SwiftUI\b/, swift)
  const uikit = all(/import UIKit\b/, swift) || files.some(f => isObjC(f.path))
  const iosSignal = uikit || all(/\.iOS\(|SDKROOT = iphoneos|IPHONEOS_DEPLOYMENT_TARGET|TARGETED_DEVICE_FAMILY = "?1/, config)
  const mac = all(/import AppKit\b|NSApplication|NSWindow\b/, swift) || all(/\.macOS\(|SDKROOT = macosx|MACOSX_DEPLOYMENT_TARGET/, config)
  // A SwiftUI app that names no platform is most often an iPhone app.
  const ios = iosSignal || (apple && !mac)
  return { apple, web, swiftui, uikit, ios, mac }
}

export function pass(note: string): Outcome {
  return { status: 'pass', hits: [], note }
}
export function na(note: string): Outcome {
  return { status: 'na', hits: [], note }
}
export function review(note: string): Outcome {
  return { status: 'review', hits: [], note }
}
export function gap(note: string, hits: Hit[] = []): Outcome {
  return { status: 'gap', hits: hits.slice(0, MAX_HITS), note }
}
/** A gap when there are hits, else a pass. */
export function gapIf(hits: Hit[], gapNote: (n: number) => string, passNote: string): Outcome {
  return hits.length > 0 ? gap(gapNote(hits.length), hits) : pass(passNote)
}

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')
}

export function hitAt(f: SourceFile, index: number): Hit {
  return { path: f.path, line: index + 1, text: f.lines[index]!.trim().slice(0, 160) }
}

/** Every line of the files `which` picks that matches `re` (comments left out). */
export function grep(ctx: Ctx, which: (p: string) => boolean, re: RegExp, keep?: (f: SourceFile, i: number) => boolean): Hit[] {
  const out: Hit[] = []
  for (const f of ctx.files) {
    if (!which(f.path)) continue
    const quiet = commented(f)
    f.lines.forEach((line, i) => {
      if (re.test(line) && !quiet[i] && (!keep || keep(f, i))) out.push(hitAt(f, i))
    })
  }
  return out
}

const commentCache = new WeakMap<SourceFile, boolean[]>()

/** Which lines are comments: line comments, and every line of a block comment. */
export function commented(f: SourceFile): boolean[] {
  const known = commentCache.get(f)
  if (known) return known
  const out: boolean[] = []
  let inBlock = false
  for (const line of f.lines) {
    const t = line.trim()
    if (inBlock) {
      out.push(true)
      if (t.includes('*/') || t.includes('-->')) inBlock = false
      continue
    }
    const opens = t.startsWith('/*') || t.startsWith('<!--') || t.startsWith('{/*')
    out.push(isComment(line) || opens)
    if (opens && !t.includes('*/') && !t.includes('-->')) inBlock = true
  }
  commentCache.set(f, out)
  return out
}

export function has(ctx: Ctx, which: (p: string) => boolean, re: RegExp): boolean {
  return ctx.files.some(f => which(f.path) && re.test(f.text))
}

/** Whether `re` matches within `before` lines above and `after` lines below line `i`, the line itself included. */
export function near(f: SourceFile, i: number, re: RegExp, before: number, after: number): boolean {
  for (let j = Math.max(0, i - before); j <= Math.min(f.lines.length - 1, i + after); j++) {
    if (re.test(f.lines[j]!)) return true
  }
  return false
}

/** Every `<tag ...>` opening of `tag` in the file, whole even across lines, with the line it starts on. */
export function tags(f: SourceFile, tag: string): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = []
  const re = new RegExp(`<${tag}\\b`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(f.text))) {
    const end = tagEnd(f.text, m.index)
    const index = f.text.slice(0, m.index).split('\n').length - 1
    if (commented(f)[index]) continue
    out.push({ index, text: f.text.slice(m.index, end) })
  }
  return out
}

/** Where an opening tag ends, skipping `>` inside quotes and JSX braces. */
function tagEnd(text: string, from: number): number {
  let depth = 0
  let quote = ''
  for (let i = from + 1; i < text.length && i < from + 2000; i++) {
    const c = text[i]!
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth <= 0) return i + 1
  }
  return Math.min(text.length, from + 200)
}

/** The modifiers chained onto the view on line `i`: that line and the lines below that start with a dot. */
export function chain(f: SourceFile, i: number): string {
  let out = f.lines[i]!
  for (let j = i + 1; j < f.lines.length && /^\s*\./.test(f.lines[j]!); j++) out += `\n${f.lines[j]}`
  return out
}

/** CSS rule blocks, innermost: the selector and the declarations, with the line the block starts on. */
export function cssBlocks(f: SourceFile): { selector: string; body: string; index: number }[] {
  const out: { selector: string; body: string; index: number }[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(f.text))) {
    const selector = m[1]!.trim()
    const index = f.text.slice(0, m.index + m[0].indexOf(selector)).split('\n').length - 1
    out.push({ selector, body: m[2]!, index })
  }
  return out
}
