import { expect, test } from 'claude-code/testing'

import type { Report, Status } from '../types'
import { audit, auditText, digest, newHits, tally } from '../hooks/audit'
import type { Judgments } from '../hooks/audit'
import { RULES } from '../hooks/rules'
import { file, isRelevant } from '../hooks/scan'
import { BAD_APP, BAD_WEB, GOOD_APP } from './fixtures'

const NONE: Judgments = { verdicts: {}, waived: [] }

function run(files: Record<string, string>, j = NONE): Report {
  return audit('/p', Object.entries(files).map(([p, t]) => file(p, t)), j, 0)
}

function statusOf(r: Report, id: string): Status {
  return r.findings.find(f => f.id === id)!.status
}

test('every rule has a unique id, a HIG page and guidance', async () => {
  const ids = new Set(RULES.map(r => r.id))
  expect(ids.size).toBe(RULES.length)
  for (const r of RULES) {
    expect(r.slug).toMatch(/^[a-z0-9-]+$/)
    expect(r.guidance.length).toBeGreaterThan(40)
  }
})

test('the scan skips build output, dependencies and tests', async () => {
  expect(isRelevant('App/ContentView.swift')).toBe(true)
  expect(isRelevant('web/src/App.tsx')).toBe(true)
  expect(isRelevant('node_modules/x/index.js')).toBe(false)
  expect(isRelevant('DerivedData/a.swift')).toBe(false)
  expect(isRelevant('AppTests/FooTests.swift')).toBe(false)
  expect(isRelevant('README.md')).toBe(false)
})

test('a SwiftUI app that breaks the guidelines shows them as gaps, with places', async () => {
  const r = run(BAD_APP)
  expect(r.stack.swiftui).toBe(true)
  expect(r.stack.ios).toBe(true)
  for (const id of [
    'purpose-strings', 'ask-in-context', 'dark-mode', 'dynamic-type', 'min-text-size', 'platform-words', 'image-labels',
    'real-buttons', 'reduce-motion', 'semantic-colors', 'text-entry', 'tab-bar', 'navigation', 'privacy-manifest', 'app-icon',
    'destructive-actions', 'localization',
  ]) {
    expect([id, statusOf(r, id)]).toEqual([id, 'gap'])
  }
  const purpose = r.findings.find(f => f.id === 'purpose-strings')!
  expect(purpose.note).toContain('NSLocationWhenInUseUsageDescription')
  expect(purpose.hits[0]!.path).toBe('Demo/DemoApp.swift')
  expect(statusOf(r, 'launch-screen')).toBe('pass')
  expect(statusOf(r, 'voiceover')).toBe('review')
  // Web-only guidelines do not apply to a Swift app.
  expect(statusOf(r, 'zoom')).toBe('na')
})

test('the same app, fixed, passes those checks', async () => {
  const r = run(GOOD_APP)
  for (const id of [
    'purpose-strings', 'ask-in-context', 'dark-mode', 'dynamic-type', 'min-text-size', 'platform-words', 'image-labels',
    'reduce-motion', 'semantic-colors', 'text-entry', 'navigation', 'privacy-manifest', 'app-icon', 'launch-screen', 'localization', 'sheets',
  ]) {
    expect([id, statusOf(r, id)]).toEqual([id, 'pass'])
  }
  expect(tally(r.findings).gap).toBe(0)
})

test('a web page: alt text, zoom, clickable divs, focus ring, reduced motion', async () => {
  const r = run(BAD_WEB)
  expect(r.stack.web).toBe(true)
  expect(r.stack.apple).toBe(false)
  for (const id of ['image-labels', 'zoom', 'real-buttons', 'keyboard-focus', 'reduce-motion', 'touch-targets', 'dark-mode', 'text-entry', 'semantic-colors', 'dynamic-type']) {
    expect([id, statusOf(r, id)]).toEqual([id, 'gap'])
  }
  expect(statusOf(r, 'purpose-strings')).toBe('na')
})

test('verdicts settle review items, waivers take a guideline out', async () => {
  const r = run(BAD_APP, {
    verdicts: { voiceover: { status: 'pass', note: 'Checked.', at: 1, by: 'claude' }, 'dark-mode': { status: 'pass', note: 'no', at: 1, by: 'claude' } },
    waived: ['tab-bar'],
  })
  expect(statusOf(r, 'voiceover')).toBe('pass')
  // A verdict never overrides what a check found.
  expect(statusOf(r, 'dark-mode')).toBe('gap')
  expect(statusOf(r, 'tab-bar')).toBe('na')
  expect(r.findings.find(f => f.id === 'tab-bar')!.isWaived).toBe(true)
})

test('an edit is held to what it added, and the digest and audit text read well', async () => {
  const before = run(GOOD_APP)
  const after = run({ ...GOOD_APP, 'Demo/ContentView.swift': GOOD_APP['Demo/ContentView.swift']!.replace('.font(.body)', '.font(.system(size: 8))') })
  const found = newHits(before, after, 'Demo/ContentView.swift')
  expect(found.map(f => f.rule.id).sort()).toEqual(['dynamic-type', 'min-text-size'])

  const text = digest(before.stack)
  expect(text).toContain('Human Interface Guidelines')
  expect(text).toContain('Dark Mode is supported')
  expect(text).not.toContain('People can zoom')

  const bad = auditText(run(BAD_APP))
  expect(bad).toContain('## Gaps')
  expect(bad).toContain('[dark-mode]')
  expect(bad).toContain('Demo/DemoApp.swift:')
})
