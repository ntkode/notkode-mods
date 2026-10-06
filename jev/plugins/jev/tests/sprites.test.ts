import { describe, expect, test } from 'claude-code/testing'

import { ANSWER_FRAMES, COLORS, STILL, TRAVEL_FRAMES, scenePixels } from '../hooks/sprites'
import type { SceneState } from '../hooks/sprites'

// Columns: Claude 0-7, gap 8, middle 9-22, gap 23, Jev (the owl) 24-30. Rows 0-3 the actors, 4-5 ground.
const MIDDLE = [9, 22] as const
const OWL = 24
const at = (s: Partial<SceneState> & Pick<SceneState, 'scene'>) => scenePixels({ ...STILL, ...s })
/** The leftmost middle column holding `color`, or -1. */
const where = (s: Partial<SceneState> & Pick<SceneState, 'scene'>, color: number) => {
  const cols: number[] = []
  for (const row of at(s)) row.forEach((p, c) => p === color && c >= MIDDLE[0] && c <= MIDDLE[1] && cols.push(c))
  return cols.length > 0 ? Math.min(...cols) : -1
}
const owl = (s: Partial<SceneState> & Pick<SceneState, 'scene'>) => JSON.stringify(at(s).map(r => r.slice(OWL)))
const claude = (s: Partial<SceneState> & Pick<SceneState, 'scene'>) => JSON.stringify(at(s).map(r => r.slice(0, 8)))
const middle = (s: Partial<SceneState> & Pick<SceneState, 'scene'>) => JSON.stringify(at(s).map(r => r.slice(...MIDDLE)))

describe('only the one working moves', () => {
  test('asking: the conversation runs from Claude to Jev, then only the owl works; Claude waits', () => {
    expect(where({ scene: 'asking', frame: 0 }, COLORS.packet)).toBeLessThan(where({ scene: 'asking', frame: TRAVEL_FRAMES - 1 }, COLORS.packet))
    expect(where({ scene: 'asking', frame: TRAVEL_FRAMES }, COLORS.packet)).toBe(-1)
    expect(owl({ scene: 'asking', frame: TRAVEL_FRAMES })).not.toBe(owl({ scene: 'asking', frame: TRAVEL_FRAMES + 1 }))
    // the owl does not start before the conversation reaches it
    expect(owl({ scene: 'asking', frame: 0 })).toBe(owl({ scene: 'idle' }))
    for (let f = 0; f < 12; f++) expect(claude({ scene: 'asking', frame: f })).toBe(claude({ scene: 'idle' }))
  })

  test('thinking: Claude glances and blinks; the owl and the grass never move', () => {
    const frames = Array.from({ length: 20 }, (_, f) => f)
    expect(new Set(frames.map(f => claude({ scene: 'thinking', frame: f }))).size).toBeGreaterThan(1)
    expect(new Set(frames.map(f => owl({ scene: 'thinking', frame: f, card: 'pick' }))).size).toBe(1)
    expect(new Set(frames.map(f => middle({ scene: 'thinking', frame: f }))).size).toBe(1)
  })

  test('working: Claude steps and a tool call sparks; the owl never moves', () => {
    expect(claude({ scene: 'working', frame: 0 })).not.toBe(claude({ scene: 'working', frame: 1 }))
    for (let f = 0; f < 12; f++) expect(owl({ scene: 'working', frame: f, card: 'pick' })).toBe(owl({ scene: 'working', frame: 0, card: 'pick' }))
    expect(at({ scene: 'working', spark: true })[0]!.includes(COLORS.spark)).toBe(true)
    expect(at({ scene: 'working', spark: false })[0]!.includes(COLORS.spark)).toBe(false)
    // a call too quick to see still flashes as the next request starts
    expect(at({ scene: 'thinking', spark: true })[0]!.includes(COLORS.spark)).toBe(true)
  })

  test('idle and unset hold still', () => {
    for (const scene of ['idle', 'unset'] as const) {
      expect(claude({ scene, frame: 0 })).toBe(claude({ scene, frame: 5 }))
      expect(owl({ scene, frame: 0 })).toBe(owl({ scene, frame: 5 }))
    }
  })
})

describe('the information shows as it travels', () => {
  test("answering: Jev's card runs back to Claude, colored by what Jev answered", () => {
    expect(where({ scene: 'answering', frame: 0, card: 'pick' }, COLORS.pick)).toBeGreaterThan(where({ scene: 'answering', frame: ANSWER_FRAMES - 1, card: 'pick' }, COLORS.pick))
    expect(where({ scene: 'answering', card: 'pass' }, COLORS.pass)).toBeGreaterThan(-1)
    expect(where({ scene: 'answering', card: 'fail' }, COLORS.fail)).toBeGreaterThan(-1)
  })

  test("a hint rests by Claude while it thinks and works; a pass or a failure does not", () => {
    expect(where({ scene: 'thinking', card: 'pick' }, COLORS.pick)).toBe(MIDDLE[0])
    expect(where({ scene: 'working', card: 'pick' }, COLORS.pick)).toBe(MIDDLE[0])
    // the card's top row is empty (the grey of a pass is the trail's grey, on the row below)
    const cardRow = (s: Partial<SceneState> & Pick<SceneState, 'scene'>) => at(s)[1]!.slice(MIDDLE[0], MIDDLE[1] + 1)
    expect(cardRow({ scene: 'thinking', card: 'pass' }).every(p => p === null)).toBe(true)
    expect(cardRow({ scene: 'working', card: 'fail' }).every(p => p === null)).toBe(true)
    // with no card, grass still lies between them
  })

  test('shadow: the card never leaves Jev, so Claude never carries it', () => {
    for (let f = 0; f < ANSWER_FRAMES; f++) expect(where({ scene: 'answering', frame: f, card: 'pick', shadow: true }, COLORS.pick)).toBe(MIDDLE[0] + 12)
    expect(where({ scene: 'thinking', card: 'pick', shadow: true }, COLORS.pick)).toBe(MIDDLE[0] + 12)
  })

  test("a failed answer turns the owl's eyes red while it travels", () => {
    expect(at({ scene: 'answering', card: 'fail' }).flat().includes(COLORS.error)).toBe(true)
    expect(at({ scene: 'answering', card: 'pick' }).flat().includes(COLORS.error)).toBe(false)
  })
})

test('a control turn: the owl sleeps, eyes shut, while Claude works alone', () => {
  const pupils = (s: Partial<SceneState> & Pick<SceneState, 'scene'>) => at(s).flatMap(r => r.slice(OWL)).filter(p => p === COLORS.pupil).length
  expect(pupils({ scene: 'idle' })).toBeGreaterThan(0)
  expect(pupils({ scene: 'thinking', asleep: true })).toBe(0)
  expect(pupils({ scene: 'working', asleep: true })).toBe(0)
})

test('they stand on grass that runs the whole width, with blades and a flower between them', () => {
  for (const scene of ['unset', 'idle', 'asking', 'answering', 'thinking', 'working'] as const) {
    const px = at({ scene })
    expect(px).toHaveLength(6)
    expect(px[4]!.every(p => p === COLORS.grass || p === COLORS.grassLight)).toBe(true)
    expect(px[5]!.every(p => p === COLORS.soil)).toBe(true)
    expect(px[3]!.slice(MIDDLE[0], MIDDLE[1] + 1).includes(COLORS.flower)).toBe(true)
  }
  expect(where({ scene: 'idle' }, COLORS.blade)).toBeGreaterThan(-1)
})
