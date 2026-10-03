// Pixel scenes for the band above the prompt: Claude (the orange pixel mascot, on the
// left: it starts every exchange) and Jev (a teal owl, the judge, on the right), animated by what is really happening in the turn: who
// is sending what to whom, and who is working. 4 pixels tall, two per terminal cell,
// so the scene is 2 rows. Pure: tests run it as is.

/** One scene pixel: an RGB color, or null for the terminal's own background. */
type Px = number | null

const DEFAULT = 0x01000000
const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄

export const COLORS = {
  jev: 0x2bb3a3,
  jevDim: 0x5c6670,
  visor: 0xf2f2f2,
  pupil: 0x111111,
  beak: 0xffd166,
  error: 0xef476f,
  claude: 0xd97757,
  claudeDim: 0x8a6a5e,
  claudeEye: 0x1a1a1a,
  trail: 0x6c7680,
  packet: 0xe6edf3,
  spark: 0xffd166,
  /** Card colors: what jev-gateway did with the request. */
  pick: 0x4cc9f0,
  direct: 0x06d6a0,
  pass: 0x6c7680,
} as const

/**
 * One model request through jev-gateway:
 * - `asking`: the request leaves Claude for the gateway (a packet runs Claude → Jev), then Jev
 *   works while the request is in flight.
 * - `answering`: the gateway's decision runs back to Claude as a card: cyan when Jev picked the
 *   tool, green when Jev answered without the LLM, grey when it left the choice to Claude.
 * - `working`: Claude acts on it (legs stepping, a spark per tool call); Jev watches.
 */
export type Scene = 'unset' | 'idle' | 'asking' | 'answering' | 'working' | 'error'
export type Card = 'pick' | 'direct' | 'pass' | 'none'

/** Scenes that move; the rest hold still. */
export const ANIMATED: ReadonlySet<Scene> = new Set(['asking', 'answering', 'working'])

/** Frames the packet takes to cross, before Jev starts working. */
export const TRAVEL_FRAMES = 4
/** Frames the card takes to cross from Jev to Claude. */
export const ANSWER_FRAMES = 7

const MID = 8
const BLANK = '.'.repeat(MID)

function put(row: string, at: number, text: string): string {
  return row.slice(0, at) + text + row.slice(at + text.length)
}

/** Jev is working while it holds a request: its eyes look around and blink. */
function jevWorking(scene: Scene, frame: number): boolean {
  return scene === 'asking' && frame >= TRAVEL_FRAMES
}

// The owl's eye row: pupils left (at Claude), pupils right, or eyes shut.
const OWL_EYES = { left: 'tkwtkwt', right: 'twktwkt', shut: 'ttttttt' } as const

function jev(scene: Scene, frame: number): string[] {
  const look: keyof typeof OWL_EYES = jevWorking(scene, frame)
    ? (['left', 'right', 'left', 'right', 'shut'] as const)[(frame - TRAVEL_FRAMES) % 5]!
    : 'left'
  return ['t.....t', '.ttttt.', OWL_EYES[look], '.ttatt.']
}

function claude(scene: Scene, frame: number): string[] {
  const working = scene === 'working'
  const legs = working && frame % 2 === 1 ? 'o.o..o.o' : '.o.oo.o.'
  // eyes close for one frame now and then while it works
  const eyes = working && frame % 9 === 8 ? '.oooooo.' : '.okooko.'
  return ['.oooooo.', eyes, 'oooooooo', legs]
}

function middle(scene: Scene, frame: number, spark: boolean): string[] {
  switch (scene) {
    case 'idle':
    case 'error':
      return [BLANK, BLANK, '..g..g..', BLANK]
    case 'unset':
      return [BLANK, BLANK, BLANK, BLANK]
    case 'asking': {
      if (frame < TRAVEL_FRAMES) {
        // the packet runs from Claude (left) to Jev (right)
        const at = Math.min(MID - 2, frame * 2)
        return [BLANK, BLANK, put(BLANK, at, 'pp'), BLANK]
      }
      // Jev works: a pulse of dots next to it
      const dots = frame % 3 === 0 ? '.......g' : frame % 3 === 1 ? '.....g.g' : '...g.g.g'
      return [BLANK, BLANK, dots, BLANK]
    }
    case 'answering': {
      // the card runs from Jev (right) to Claude (left)
      const at = MID - 2 - Math.min(frame, ANSWER_FRAMES - 1)
      const card = put(BLANK, at, 'cc')
      return [BLANK, card, card, BLANK]
    }
    case 'working': {
      // Jev's answer rests by Claude; a spark flashes on a tool call
      const card = put(BLANK, 0, 'cc')
      return [spark ? put(BLANK, 0, 'y') : BLANK, card, card, BLANK]
    }
  }
}

export const SCENE_ROWS = 2

/** The scene's pixels at `frame`: Claude, what passes between them, Jev. */
export function scenePixels(scene: Scene, card: Card = 'none', frame = 0, spark = false): Px[][] {
  const dim = scene === 'unset'
  const palette: Record<string, number | undefined> = {
    a: scene === 'error' ? COLORS.error : dim ? COLORS.jevDim : COLORS.beak,
    t: dim ? COLORS.jevDim : COLORS.jev,
    w: dim ? 0x9aa3ab : COLORS.visor,
    k: scene === 'error' ? COLORS.error : COLORS.pupil,
    g: COLORS.trail,
    p: COLORS.packet,
    c: card === 'none' ? undefined : COLORS[card],
    y: COLORS.spark,
  }
  const body = dim ? COLORS.claudeDim : COLORS.claude
  const j = jev(scene, frame)
  const m = middle(scene, frame, spark)
  const c = claude(scene, frame)
  const rows: Px[][] = []
  for (let r = 0; r < 4; r++) {
    const row: Px[] = []
    for (const ch of c[r]!) row.push(ch === 'o' ? body : ch === 'k' ? COLORS.claudeEye : null)
    row.push(null)
    for (const ch of m[r]!) row.push(palette[ch] ?? null)
    row.push(null)
    for (const ch of j[r]!) row.push(palette[ch] ?? null)
    rows.push(row)
  }
  return rows
}

/** Packs pixels two per cell (▀ with the top as foreground, the bottom as background) into Raster `cells`. */
export function rasterCells(pixels: Px[][]): { cells: string; columns: number; rows: number } {
  const columns = Math.max(...pixels.map(r => r.length))
  const rows = Math.ceil(pixels.length / 2)
  const words = new Uint32Array(columns * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const top = pixels[2 * r]?.[c] ?? null
      const bottom = pixels[2 * r + 1]?.[c] ?? null
      const at = (r * columns + c) * 3
      if (top === null && bottom === null) {
        words[at] = 0x20
        words[at + 1] = DEFAULT
        words[at + 2] = DEFAULT
      } else if (top !== null) {
        words[at] = UPPER
        words[at + 1] = top
        words[at + 2] = bottom ?? DEFAULT
      } else {
        words[at] = LOWER
        words[at + 1] = bottom as number
        words[at + 2] = DEFAULT
      }
    }
  }
  return { cells: base64(new Uint8Array(words.buffer)), columns, rows }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
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
