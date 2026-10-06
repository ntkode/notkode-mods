export type JevEconomy = {
  days: number
  turns: number
  /** Turns that recorded Claude's cost (logged since the mod tracks it). */
  pricedTurns: number
  /** Claude's requests, at API prices. */
  claudeUsd: number
  /** Calls to Jev, as the provider priced them. */
  jevUsd: number
  /** Calls to Jev with no price reported. */
  jevUnpriced: number
  asks: number
  hintTurns: number
  controlTurns: number
  /** Weekly quota points per dollar of Claude, from turns that recorded both. */
  weekPctPerUsd?: number
  saved?: {
    /** Per turn with hints; negative when hints cost more. */
    usdPerTurn: number
    outputPerTurn: number
    usd: number
    output: number
    /** The saving as points of the weekly quota, when the rate is known. */
    weekPct?: number
    /** The saving less what Jev cost on the turns with hints. */
    netUsd: number
  }
}

/** The /jev board over the last days: each feature's saving, and what Jev itself took. */
export type JevBoard = {
  days: number
  turns: number
  /** Weekly-quota percent per weighted token unit, learned from the account's own turns. */
  pctPerUnit?: number
  features: Record<'hints' | 'effort' | 'skillGate' | 'freshStart' | 'doneCheck', { savedPct?: number; detail: string }>
  usage: { asks: number; p50Ms?: number; usd: number; unpriced: number; failed: number }
}

/** The last finished turn as the pane draws it. */
export type JevTurnView = {
  prompt: string
  arm: 'hint' | 'control' | 'shadow' | 'excluded' | 'off'
  steps: number
  durationMs: number
  output?: number
  jev?: {
    asked: number
    hinted: number
    followed: number
    picks: string[]
    reasons: Record<string, number>
    /** Jev's median latency this turn. */
    ms?: number
    /** What Jev answered each time it was asked, in order: `pick` (a hint), `pass` or `fail`. */
    cards: string[]
  }
  /** The done check at the turn's last stop. */
  done?: { verdict: 'push' | 'ok' | 'running' | 'error'; pushed: boolean }
}

/** This session's running totals. */
export type JevSessionView = {
  turns: number
  hintTurns: number
  controlTurns: number
  requests: number
  asked: number
  hinted: number
  followed: number
  output: number
  /** Jev's median latency per turn, newest last. */
  jevMs: number[]
  /** What the calls to Jev cost this session, as the provider priced them. */
  jevUsd: number
  /** Calls to Jev this session whose provider reported no price. */
  jevUnpriced: number
}

/**
 * Whether Jev can be asked in this session: off (switched off in /config), no_key (run
 * /jev-setup), ready, excluded (a repo whose conversations stay out of Jev).
 */
export type JevReadiness = 'off' | 'no_key' | 'ready' | 'excluded'

/** How a turn is run: Jev's hints reach Claude, Jev sits out (control), Jev is asked in shadow, or not at all (paused). */
export type JevArm = 'hint' | 'control' | 'shadow' | 'off'

declare module 'claude-code' {
  interface PluginState {
    jev: {
      status: {
        state: JevReadiness
        mode: 'on' | 'shadow' | 'off'
        /** Where Jev is reached (`OpenRouter`). */
        provider?: string
        /** This session's requests go through a local proxy (a jev-gateway hints too). */
        gateway?: string
        /** Jev is not asked in this session until it is resumed (the pane's switch). */
        paused?: boolean
        /** The done check's mode, as /config or the pane's switch set it. */
        doneCheck?: 'on' | 'off'
        /** Low effort for quick status questions. */
        effort?: 'on' | 'off'
        /** Skills the project won't need keep only their name in the listing. */
        skillGate?: 'on' | 'off'
        /** Offer /clear or /compact when a new task starts in a long conversation. */
        freshStart?: 'on' | 'off'
      }
      last: JevTurnView | null
      session: JevSessionView
      /** What the running turn is doing, and since when: the animation's clock. */
      phase: { name: 'asking' | 'thinking' | 'working'; at: number; arm: JevArm; tool?: string } | null
      /** Jev's newest answer in the running turn. */
      decision: { mode: 'hint' | 'pass'; tool?: string; confidence?: number; reason?: string; shadow?: boolean; at: number } | null
      /** The skill gate's decision for the session: the same listing all session long, reloads included. */
      skills: { session: string; mode: 'on' | 'shadow'; trim: string[]; count: number; before: number; after: number } | null
      /** The board over the last 7 days: each feature's saving, Jev's own usage; refreshed after each turn. */
      board: JevBoard | null
      /** ANTHROPIC_BASE_URL before v0.4 routed the session through its gateway: read once, to undo that. */
      original: { saved: boolean; value: string | null }
    }
  }
}
