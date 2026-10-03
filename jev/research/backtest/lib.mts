// Shared pieces of the backtests: the Jev key, one Jev call, a small worker pool, and the
// state text the mod sends. Run scripts with plain `node` (22.6+ runs TypeScript directly).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export const DATA = new URL('./data/', import.meta.url).pathname

/** The key /jev-setup saved in the macOS Keychain, or OPENROUTER_API_KEY. */
export function jevKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY
  return execFileSync('security', ['find-generic-password', '-s', 'claude-code-jev-mod', '-a', 'openrouter', '-w']).toString().trim()
}

export type Answer = { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> } | { type: 'noul'; noul: number }
export type Decision = { ms: number; answers?: Record<string, Answer>; cost: number; error?: string }

const KEY = jevKey()

/** One Jev decision through OpenRouter, retried on rate limits and server errors. */
export async function decide(state: string, questions: Record<string, unknown>): Promise<Decision> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = performance.now()
    const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'jevMod backtest' },
      body: JSON.stringify({ model: '~typesafe/jev-latest', state, questions }),
    })
    const ms = Math.round(performance.now() - started)
    if (res.status === 429 || res.status >= 500) {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
      continue
    }
    const body = (await res.json()) as { answers?: Record<string, Answer>; usage?: { cost?: number } }
    if (!res.ok) return { ms, cost: 0, error: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}` }
    return { ms, answers: body.answers, cost: body.usage?.cost ?? 0 }
  }
  return { ms: 0, cost: 0, error: 'retries exhausted' }
}

/** Runs `work` over every item with `width` at a time, appending each result to `out` so a rerun resumes. */
export async function pool<T, R extends { i: number }>(items: T[], out: string, work: (item: T, i: number) => Promise<R>, width = 6): Promise<R[]> {
  const done = new Set(existsSync(out) ? readJsonl<R>(out).map(r => r.i) : [])
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      if (done.has(i)) continue
      writeFileSync(out, JSON.stringify(await work(items[i]!, i)) + '\n', { flag: 'a' })
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
  return readJsonl<R>(out)
}

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as T)
}

export type Turn = {
  project: string
  prompt: string
  history: { role: 'user' | 'assistant'; text: string }[]
  tools: { tool: string; summary: string; isError: boolean }[]
  answer: string
  reason: string
  steps: number
  output: number
  next: string
  toolSearch: number
  explore: number
  mcpUsed: string[]
  skillsUsed: string[]
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)} [...]`)

/** What Jev reads before a turn: the project, the recent exchanges, the new prompt. */
export function turnState(t: Pick<Turn, 'project' | 'history' | 'prompt'>): string {
  const recent = t.history
    .filter(m => m.text.trim() !== '')
    .slice(-6)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${clip(m.text.trim(), 1200)}`)
  return [
    `Project: ${t.project}`,
    recent.length > 0 ? `Recent conversation:\n${recent.join('\n\n')}` : 'Recent conversation: (none)',
    `LATEST user message:\n${clip(t.prompt.trim(), 4000)}`,
  ].join('\n\n')
}

export const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)]! : 0
}
export const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '-')
