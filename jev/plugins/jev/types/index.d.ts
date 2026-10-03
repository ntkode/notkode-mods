/** The last finished turn as the pane draws it. */
export type JevTurnView = {
  prompt: string
  route: 'gateway' | 'direct' | 'excluded' | 'down'
  steps: number
  durationMs: number
  output?: number
  fallbacks?: number
  gateway?: { requests: number; modes: Record<string, number>; reasons: Record<string, number>; picks: string[]; jevMs?: number }
}

/** This session's running totals. */
export type JevSessionView = {
  turns: number
  routed: number
  requests: number
  picked: number
  fallbacks: number
}

/**
 * Where jev-gateway stands for this session:
 * off (switched off in /config), not_installed (no gateway, or no Node.js it runs on), no_key,
 * starting, up, down (not answering: the session went direct), excluded (a repo whose
 * conversations stay out of Jev), external (the session was started through `jev-claude`, whose
 * gateway the mod watches but does not run).
 */
export type JevGatewayState = 'off' | 'not_installed' | 'no_key' | 'starting' | 'up' | 'down' | 'excluded' | 'external'

declare module 'claude-code' {
  interface PluginState {
    jev: {
      last: JevTurnView | null
      session: JevSessionView
      gateway: {
        state: JevGatewayState
        origin?: string
        /** This session's model requests go through the gateway now. */
        routed: boolean
        /** The person switched routing off for this session in the pane. */
        paused?: boolean
        /** Jev routing inside the gateway; off makes it a metering proxy (the baseline). */
        routing?: boolean
        minConfidence?: number
        pid?: number
        /** What went wrong or what to do next, in a few words (`run /jev-setup`). */
        note?: string
      }
      /** ANTHROPIC_BASE_URL as the session started, restored whenever routing stops. */
      original: { saved: boolean; value: string | null }
      /** The running request, and since when: the animation's clock. */
      phase: { name: 'asking' | 'working'; at: number } | null
      /** The gateway's decision on the newest request of the running turn. */
      decision: { mode: string; tool?: string; confidence?: number; reason?: string; at: number } | null
    }
  }
}
