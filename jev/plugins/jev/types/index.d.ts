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
        doneCheck?: 'shadow' | 'on' | 'off'
      }
      last: JevTurnView | null
      session: JevSessionView
      /** What the running turn is doing, and since when: the animation's clock. */
      phase: { name: 'asking' | 'thinking' | 'working'; at: number; arm: JevArm; tool?: string } | null
      /** Jev's newest answer in the running turn. */
      decision: { mode: 'hint' | 'pass'; tool?: string; confidence?: number; reason?: string; shadow?: boolean; at: number } | null
      /** The last 7 days from the log, as the pane's lines (answers, hints vs control, spend, savings); refreshed after each turn. */
      week: string[] | null
      /** ANTHROPIC_BASE_URL before v0.4 routed the session through its gateway: read once, to undo that. */
      original: { saved: boolean; value: string | null }
    }
  }
}
