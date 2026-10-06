// Pure helpers for the files pane: paths, listing, file kinds, and pictures as terminal cells.

export type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number }

/** Names never worth showing, gitignored or not. */
export const ALWAYS_HIDDEN = new Set(['.git', '.DS_Store', 'node_modules', '.Trash'])

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic'])
export const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx', 'mdown'])
const BINARY_EXT = new Set(['pdf', 'zip', 'gz', 'tgz', 'xz', 'dmg', 'pkg', 'exe', 'dll', 'so', 'dylib', 'o', 'a', 'class', 'jar', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'mov', 'wav', 'ico', 'sqlite', 'db', 'bin', 'pyc'])

/** Text drawn at most per file; the tree cuts at 100,000 characters anyway. */
export const MAX_TEXT = 90_000
/** Entries drawn at most per folder. */
export const MAX_ENTRIES = 400

export function ext(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

export function join(dir: string, name: string): string {
  if (dir === '' || dir === '.') return name
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/** The folder above `rel` ('' is the root, and stays it). */
export function parent(rel: string): string {
  const trimmed = rel.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut < 0 ? '' : trimmed.slice(0, cut)
}

/** `abs` relative to `root` when inside it, else `abs` itself. */
export function relative(root: string, abs: string): string {
  const base = root.replace(/\/+$/, '')
  if (abs === base) return ''
  return abs.startsWith(`${base}/`) ? abs.slice(base.length + 1) : abs
}

export function absolute(root: string, rel: string): string {
  if (rel.startsWith('/')) return rel
  return rel === '' ? root : `${root.replace(/\/+$/, '')}/${rel}`
}

export type FileKind = 'markdown' | 'image' | 'binary' | 'text'

export function kindOf(path: string): FileKind {
  const e = ext(path)
  if (MARKDOWN_EXT.has(e)) return 'markdown'
  if (IMAGE_EXT.has(e)) return 'image'
  if (BINARY_EXT.has(e)) return 'binary'
  return 'text'
}

/** True when the text holds a NUL in its first 8,000 characters: a binary file read as text. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes('\u0000')
}

/** Folders first, then files, each by name as a person sorts them; hidden and always-hidden names dropped. */
export function arrange(entries: readonly Entry[], opts: { showHidden: boolean; ignored?: ReadonlySet<string> }): Entry[] {
  return entries
    .filter(e => !ALWAYS_HIDDEN.has(e.name))
    .filter(e => opts.showHidden || !e.name.startsWith('.'))
    .filter(e => opts.showHidden || !opts.ignored?.has(e.name))
    .sort((a, b) => {
      const ad = a.kind === 'dir' ? 0 : 1
      const bd = b.kind === 'dir' ? 0 : 1
      return ad - bd || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Cuts long text, saying how much was left out. */
export function clip(text: string, max = MAX_TEXT): { text: string; isCut: boolean } {
  if (text.length <= max) return { text, isCut: false }
  const cut = text.lastIndexOf('\n', max)
  return { text: text.slice(0, cut > max / 2 ? cut : max), isCut: true }
}

/** Width and height from a PNG's IHDR, or undefined when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return undefined
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

/**
 * Cells for a picture `width` pixels wide: terminal cells are about twice as tall as wide,
 * so one row of cells covers two pixel rows' worth of the picture's aspect.
 */
export function fitCells(width: number, height: number, maxColumns: number, maxRows: number): { columns: number; rows: number } {
  let columns = Math.max(1, Math.min(maxColumns, width))
  let rows = Math.max(1, Math.round((columns * height) / width / 2))
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.min(maxColumns, Math.round((rows * 2 * width) / height)))
  }
  return { columns, rows }
}

export type Pixels = { width: number; height: number; rgb: Uint32Array }

/** Decodes an uncompressed 24- or 32-bit BMP (what macOS `sips -s format bmp` writes) into 0xRRGGBB pixels, top row first. */
export function decodeBmp(bytes: Uint8Array): Pixels {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('not a BMP')
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = v.getUint32(10, true)
  const width = v.getInt32(18, true)
  const rawHeight = v.getInt32(22, true)
  const bpp = v.getUint16(28, true)
  const compression = v.getUint32(30, true)
  if (bpp !== 24 && bpp !== 32) throw new Error(`BMP of ${bpp} bits per pixel`)
  if (compression !== 0 && compression !== 3) throw new Error('compressed BMP')
  const height = Math.abs(rawHeight)
  const isBottomUp = rawHeight > 0
  const step = bpp / 8
  const stride = Math.ceil((width * step) / 4) * 4
  const rgb = new Uint32Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = offset + (isBottomUp ? height - 1 - y : y) * stride
    for (let x = 0; x < width; x++) {
      const p = row + x * step
      if (p + 2 >= bytes.length) continue
      let b = bytes[p]!, g = bytes[p + 1]!, r = bytes[p + 2]!
      if (step === 4) {
        // Blend transparent pixels onto a dark grey, so a logo on alpha stays readable.
        const a = bytes[p + 3]! / 255
        const bg = 0x1e
        r = Math.round(r * a + bg * (1 - a))
        g = Math.round(g * a + bg * (1 - a))
        b = Math.round(b * a + bg * (1 - a))
      }
      rgb[y * width + x] = (r << 16) | (g << 8) | b
    }
  }
  return { width, height, rgb }
}

/** Packs pixels two per cell (▀: the top pixel as foreground, the bottom as background) into Raster `cells`. */
export function rasterCells(px: Pixels): { cells: string; columns: number; rows: number } {
  const columns = px.width
  const rows = Math.ceil(px.height / 2)
  const words = new Uint32Array(columns * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const top = px.rgb[2 * r * columns + c] ?? 0
      const bottomY = 2 * r + 1
      const bottom = bottomY < px.height ? (px.rgb[bottomY * columns + c] ?? 0) : 0x01000000
      const i = (r * columns + c) * 3
      words[i] = 0x2580
      words[i + 1] = top
      words[i + 2] = bottom
    }
  }
  return { cells: toBase64(new Uint8Array(words.buffer)), columns, rows }
}

/** Whether this terminal draws real pictures (the kitty graphics protocol), read from its environment. */
export function hasPixels(env: { term?: string; termProgram?: string; kitty?: string; ghostty?: string }): boolean {
  if (env.kitty || env.ghostty) return true
  if (env.term?.includes('kitty') || env.term?.includes('ghostty')) return true
  const program = env.termProgram?.toLowerCase() ?? ''
  return program === 'ghostty' || program === 'kitty'
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64 of `bytes`. */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += ALPHABET[a >> 2]
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : ALPHABET[c & 63]
  }
  return out
}

/** The bytes of standard base64 text (padding and whitespace ignored). */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let acc = 0
  let o = 0
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | ALPHABET.indexOf(clean[i]!)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out
}
