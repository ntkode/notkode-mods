// Pixel scenes for the band above the prompt: Claude (the orange pixel mascot, on the left: it
// starts every exchange) and Jev (a teal owl, the judge, on the right), standing on a strip of grass.
// Only the one doing the work moves, and information shows as a particle exactly while it travels:
// the conversation going to Jev, Jev's answer coming back. What each one says sits in a speech
// balloon beside it, drawn by the band. 6 pixels tall (4 for the actors, 2 of ground), two per
// terminal cell, so the scene is 3 rows. Pure: tests run it as is.

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
  /** The ground they stand on, and the blades and the flower between them. */
  grass: 0x4c9a4a,
  grassLight: 0x7bc96f,
  soil: 0x2f6b34,
  blade: 0x6cbf5f,
  flower: 0xf6e27a,
  /** The conversation on its way to Jev. */
  packet: 0xe6edf3,
  spark: 0xffd166,
  /** Card colors: what Jev answered. */
  pick: 0x4cc9f0,
  pass: 0x6c7680,
  fail: 0xef476f,
} as const

/**
 * What the turn is doing, one actor at a time:
 * - `asking`: the conversation leaves Claude for Jev (a packet runs Claude → Jev), then Jev
 *   decides, its eyes darting, for exactly as long as the call to Jev takes. Claude waits.
 * - `answering`: Jev's answer runs back to Claude as a card: cyan for a hint, grey when Jev left
 *   the choice to Claude, red when Jev failed. In shadow the card stays with Jev: Claude never
 *   sees it.
 * - `thinking`: Claude's request is with its model: Claude glances and blinks, a hint it carries
 *   rests by it. Jev holds still.
 * - `working`: Claude runs tools: its legs step, a spark flashes per call (still lit as the next
 *   request starts, when the call was too quick to see). Jev holds still.
 */
export type Scene = 'unset' | 'idle' | 'asking' | 'answering' | 'thinking' | 'working'
export type Card = 'pick' | 'pass' | 'fail' | 'none'

/** One frame of the band: the scene, how far into it, and how the turn is run. */
export type SceneState = {
  scene: Scene
  frame: number
  /** Jev's newest answer in this turn. */
  card: Card
  /** A tool call just started. */
  spark: boolean
  /** Jev sits the turn out (a control turn, or paused): the owl sleeps. */
  asleep: boolean
  /** Jev is asked, but its answers never reach Claude. */
  shadow: boolean
}

export const STILL: Omit<SceneState, 'scene'> = { frame: 0, card: 'none', spark: false, asleep: false, shadow: false }

/** Scenes that move; the rest hold still. */
export const ANIMATED: ReadonlySet<Scene> = new Set(['asking', 'answering', 'thinking', 'working'])

/** Frames the packet takes to cross, before Jev starts working. */
export const TRAVEL_FRAMES = 4
/** Frames the card takes to cross from Jev to Claude. */
export const ANSWER_FRAMES = 7

const MID = 14
const BLANK = '.'.repeat(MID)
/** The grass between them, on the actors' bottom row: blades and one flower. Still: only actors move. */
const TUFTS = '.v..f...v.v..v'

function put(row: string, at: number, text: string): string {
  return row.slice(0, at) + text + row.slice(at + text.length)
}

// The owl's eye row: pupils left (at Claude), pupils right, or eyes shut.
const OWL_EYES = { left: 'tkwtkwt', right: 'twktwkt', shut: 'ttttttt' } as const

/** The owl moves only while it holds a request: the one moment it works. */
function jev(s: SceneState): string[] {
  const deciding = s.scene === 'asking' && s.frame >= TRAVEL_FRAMES
  const look: keyof typeof OWL_EYES = s.asleep
    ? 'shut'
    : deciding
      ? (['left', 'right', 'left', 'right', 'shut'] as const)[(s.frame - TRAVEL_FRAMES) % 5]!
      : 'left'
  return ['t.....t', '.ttttt.', OWL_EYES[look], '.ttatt.']
}

// Claude's eye row: looking ahead, glancing toward Jev, or blinking.
const CLAUDE_EYES = { ahead: '.okooko.', glance: '.ookook.', shut: '.oooooo.' } as const

/** Claude moves only while it works: thinking (glances, blinks) or running tools (steps). */
function claude(s: SceneState): string[] {
  const f = s.frame
  const working = s.scene === 'working'
  const eyes: keyof typeof CLAUDE_EYES =
    s.scene === 'thinking' ? (f % 10 === 8 ? 'shut' : f % 10 >= 4 && f % 10 <= 6 ? 'glance' : 'ahead') : working && f % 9 === 8 ? 'shut' : 'ahead'
  const legs = working && f % 2 === 1 ? 'o.o..o.o' : '.o.oo.o.'
  return ['.oooooo.', CLAUDE_EYES[eyes], 'oooooooo', legs]
}

/** Where an answer rests once it has landed: by Claude, or with Jev in shadow. Only a hint rests. */
function resting(s: SceneState): number | undefined {
  if (s.card !== 'pick') return undefined
  return s.shadow ? MID - 2 : 0
}

function middle(s: SceneState): string[] {
  const f = s.frame
  const rows = ((): string[] => {
    switch (s.scene) {
      case 'unset':
      case 'idle':
        return [BLANK, BLANK, BLANK]
      case 'asking': {
        // the conversation runs from Claude (left) to Jev (right); then Jev decides, in its eyes
        if (f >= TRAVEL_FRAMES) return [BLANK, BLANK, BLANK]
        const at = Math.min(MID - 2, Math.round((f * (MID - 2)) / (TRAVEL_FRAMES - 1)))
        return [BLANK, BLANK, put(BLANK, at, 'pp')]
      }
      case 'answering': {
        // the card runs from Jev (right) to Claude (left); in shadow it never leaves Jev
        const at = s.shadow ? MID - 2 : Math.round(((MID - 2) * (ANSWER_FRAMES - 1 - Math.min(f, ANSWER_FRAMES - 1))) / (ANSWER_FRAMES - 1))
        const card = put(BLANK, at, 'cc')
        return [BLANK, card, card]
      }
      case 'thinking':
      case 'working': {
        // a tool's spark sits by Claude, and outlasts a call too quick to see by a frame or two
        const top = s.spark ? put(BLANK, 0, 'y') : BLANK
        const at = resting(s)
        if (at === undefined) return [top, BLANK, BLANK]
        return [top, put(BLANK, at, 'cc'), put(BLANK, at, 'cc')]
      }
    }
  })()
  return [...rows, TUFTS]
}

export const SCENE_ROWS = 3

/** One column of ground: grass with a lighter blade here and there, soil under it. */
function ground(c: number): [number, number] {
  return [(c * 5) % 7 < 2 ? COLORS.grassLight : COLORS.grass, COLORS.soil]
}

/** The scene's pixels: Claude, what passes between them, Jev, all on the grass. */
export function scenePixels(s: SceneState): Px[][] {
  const dim = s.scene === 'unset'
  const failed = s.scene === 'answering' && s.card === 'fail'
  const palette: Record<string, number | undefined> = {
    a: dim ? COLORS.jevDim : COLORS.beak,
    t: dim ? COLORS.jevDim : COLORS.jev,
    w: dim ? 0x9aa3ab : COLORS.visor,
    // the owl's eyes turn red while a failed answer travels
    k: failed ? COLORS.error : COLORS.pupil,
  }
  const between: Record<string, number | undefined> = {
    p: COLORS.packet,
    v: COLORS.blade,
    f: COLORS.flower,
    c: s.card === 'none' ? undefined : COLORS[s.card],
    y: COLORS.spark,
  }
  const body = dim ? COLORS.claudeDim : COLORS.claude
  const j = jev(s)
  const m = middle(s)
  const c = claude(s)
  const rows: Px[][] = []
  for (let r = 0; r < 4; r++) {
    const row: Px[] = []
    for (const ch of c[r]!) row.push(ch === 'o' ? body : ch === 'k' ? COLORS.claudeEye : null)
    row.push(null)
    for (const ch of m[r]!) row.push(between[ch] ?? null)
    row.push(null)
    for (const ch of j[r]!) row.push(palette[ch] ?? null)
    rows.push(row)
  }
  const width = rows[0]!.length
  rows.push(Array.from({ length: width }, (_, c) => ground(c)[0]))
  rows.push(Array.from({ length: width }, (_, c) => ground(c)[1]))
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
