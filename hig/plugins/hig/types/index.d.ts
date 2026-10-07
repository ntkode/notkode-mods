/** Which kind of code a guideline is checked against. */
export type Platform = 'apple' | 'web'

/**
 * What a check found for one guideline:
 * pass (followed), gap (not followed, with the places), review (needs judgment: Claude or you),
 * na (does not apply to this project).
 */
export type Status = 'pass' | 'gap' | 'review' | 'na'

/** One place in the code a check points at. */
export type Hit = { path: string; line: number; text: string }

/** Claude's (or your) judgment of a guideline no check can settle. */
export type Verdict = { status: 'pass' | 'gap'; note: string; at: number; by: 'claude' | 'you' }

/** One guideline as the audit found it. */
export type Finding = {
  id: string
  /** What the check alone found, before verdicts and waivers. */
  auto: Status
  /** What counts: a waiver, then a verdict on a review item, then the check. */
  status: Status
  hits: Hit[]
  /** Why the check landed where it did, in one line. */
  note: string
  isWaived: boolean
  verdict?: Verdict
}

/** What the project is made of, as the scan read it. */
export type Stack = {
  apple: boolean
  web: boolean
  swiftui: boolean
  uikit: boolean
  ios: boolean
  mac: boolean
}

export type Report = {
  root: string
  at: number
  files: number
  stack: Stack
  findings: Finding[]
}

/** What the pane lists. */
export type Filter = 'gap' | 'review' | 'pass' | 'all'

declare module 'claude-code' {
  interface PluginState {
    hig: {
      /** The last audit; null before the first scan. */
      report: Report | null
      isScanning: boolean
      filter: Filter
      /** The guideline open in the pane; null shows the list. */
      open: string | null
    }
  }
}
