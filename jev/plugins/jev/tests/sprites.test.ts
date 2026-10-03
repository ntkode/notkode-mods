import { describe, expect, test } from 'claude-code/testing'

import { ANSWER_FRAMES, COLORS, TRAVEL_FRAMES, scenePixels } from '../hooks/sprites'

// Columns: Claude 0-7, gap 8, middle 9-16, gap 17, Jev (the owl) 18-24.
const MIDDLE = [9, 16] as const
const where = (scene: Parameters<typeof scenePixels>[0], color: number, frame: number, card: Parameters<typeof scenePixels>[1] = 'pick') => {
  const cols: number[] = []
  for (const row of scenePixels(scene, card, frame)) row.forEach((p, c) => p === color && c >= MIDDLE[0] && c <= MIDDLE[1] && cols.push(c))
  return cols.length > 0 ? Math.min(...cols) : -1
}

describe('the scene follows the request', () => {
  test('asking: the packet runs from Claude to Jev, then the owl works', () => {
    expect(where('asking', COLORS.packet, 0)).toBeLessThan(where('asking', COLORS.packet, TRAVEL_FRAMES - 1))
    expect(where('asking', COLORS.packet, TRAVEL_FRAMES)).toBe(-1)
    const eye = (f: number) => JSON.stringify(scenePixels('asking', 'none', f)[2]!.slice(18))
    expect(eye(TRAVEL_FRAMES)).not.toBe(eye(TRAVEL_FRAMES + 1))
    expect(eye(0)).toBe(JSON.stringify(scenePixels('idle')[2]!.slice(18)))
  })

  test('answering: the card runs back to Claude, colored by who decided', () => {
    expect(where('answering', COLORS.pick, 0)).toBeGreaterThan(where('answering', COLORS.pick, ANSWER_FRAMES - 1))
    expect(where('answering', COLORS.direct, 0, 'direct')).toBeGreaterThan(-1)
    expect(where('answering', COLORS.pass, 0, 'pass')).toBeGreaterThan(-1)
  })

  test('working: Claude steps and a tool call sparks; the owl holds still; no card before a decision', () => {
    const legs = (f: number) => JSON.stringify(scenePixels('working', 'pick', f)[3]!.slice(0, 8))
    expect(legs(0)).not.toBe(legs(1))
    const owl = (f: number) => JSON.stringify(scenePixels('working', 'pick', f).map(r => r.slice(18)))
    expect(owl(0)).toBe(owl(1))
    expect(scenePixels('working', 'pick', 0, true)[0]!.includes(COLORS.spark)).toBe(true)
    expect(where('working', COLORS.pick, 0, 'none')).toBe(-1)
  })

  test('streaming: two lanes flow from Jev to Claude on every frame, never a blank middle', () => {
    const cols = (frame: number, color: number) => {
      const out: number[] = []
      scenePixels('streaming', 'none', frame).forEach(row => row.forEach((p, c) => p === color && c >= MIDDLE[0] && c <= MIDDLE[1] && out.push(c)))
      return out
    }
    for (let f = 0; f < 12; f++) {
      expect(cols(f, COLORS.packet).length).toBeGreaterThan(0)
      expect(cols(f, COLORS.stream).length).toBeGreaterThan(0)
    }
    // each dot moves one pixel left per frame (towards Claude)
    const shifted = cols(1, COLORS.packet).map(c => c + 1)
    for (const c of shifted.filter(c => c <= MIDDLE[1])) expect(cols(0, COLORS.packet)).toContain(c)
  })

  test('working with no decision yet still shows a trail between them', () => {
    expect(where('working', COLORS.trail, 0, 'none')).toBeGreaterThan(-1)
  })

  test('routing off: the owl sleeps, eyes shut, in every scene but down', () => {
    const pupils = (scene: Parameters<typeof scenePixels>[0], asleep: boolean) => scenePixels(scene, 'none', 0, false, asleep).flatMap(r => r.slice(18)).filter(p => p === COLORS.pupil).length
    expect(pupils('idle', false)).toBeGreaterThan(0)
    expect(pupils('idle', true)).toBe(0)
    expect(pupils('streaming', true)).toBe(0)
  })

  test("down: the owl's eye turns red", () => {
    expect(scenePixels('error').flat().includes(COLORS.error)).toBe(true)
    expect(scenePixels('idle').flat().includes(COLORS.error)).toBe(false)
  })
})
