# hig

**Apple's Human Interface Guidelines, inside Claude Code.** Claude designs with them in mind, every
UI edit it makes is checked against them, and an audit pane shows which guidelines your app
already covers and which it does not yet, with the places in the code and a button to have Claude
fix them.

> **Status: v0.1.** Tested with `claude plugin test` (12 of 12) on the terminal and desktop surfaces,
> and run against real SwiftUI and Next.js projects to trim false alarms.

## What it does

- **Guides Claude.** In a project with Apple or web interface code, Claude's system prompt carries
  the guidelines that apply to it (SwiftUI, UIKit, iOS, macOS, web), one line each, with the HIG
  link. Projects with no UI code get nothing.
- **Checks each edit.** When Claude writes or edits a UI file, the guidelines that edit *newly*
  breaks go back to Claude with the line and the link, so it fixes them in the same change.
- **Audits the project.** `/hig` opens a pane:
  - overall coverage and a bar per area (Accessibility, Color, Typography, Layout, Icons, Writing,
    Privacy, Patterns, Components, Principles);
  - the guidelines, filtered to **gaps** (`g`), **to review** (`v`), **covered** (`p`) or **all** (`a`);
  - open one for the guideline, its HIG page, what the check found, and every `file:line`;
  - **fix** (`f`) sends Claude a prompt to close that gap, or all gaps from the list;
  - **review with Claude** (`d`): for guidelines no check can settle (hierarchy, VoiceOver
    order, contrast…), Claude reads the code and records a verdict;
  - **mark covered / mark gap** (`y` / `n`) to judge a review item yourself;
  - **waive** (`w`) a guideline that does not fit your app; waivers and verdicts are kept per project;
  - **export** (`x`) writes `HIG-AUDIT.md` at the project root.
- **Two tools for Claude**: `mcp__hig__audit` (the gaps, with places and links) and
  `mcp__hig__verdict` (record a judgment). Ask "how close are we to the HIG?" and Claude uses them.

## Commands

| Command | Does |
|---|---|
| `/hig` | open the audit pane |
| `/hig scan` | scan again and print the summary |
| `/hig fix` | ask Claude to fix every gap |
| `/hig review` | ask Claude to judge every review item |
| `/hig report` | write `HIG-AUDIT.md` |

## What is checked

43 guidelines. 35 have an automatic check; the other 8 are review items. Highlights:

| Area | Checks |
|---|---|
| Accessibility | labels on images and icon-only buttons; tap gestures and clickable `div`s that should be buttons; 44 pt targets (28 pt on Mac); Reduce Motion / `prefers-reduced-motion`; alternatives to custom gestures; visible focus; zoom not disabled |
| Color | hard-coded RGB, hex, black and white; forced light or dark appearance; `prefers-color-scheme` |
| Typography | fixed font sizes that skip Dynamic Type (`.system(size:)`, px); text under 11 pt (10 pt on Mac) |
| Layout | content ignoring safe areas; `UIScreen.main.bounds` and phone-wide fixed widths; viewport tag; left/right instead of leading/trailing |
| Icons | app icon (asset catalog, `.icon`, `.icns`, apple-touch-icon); SF Symbols for glyphs |
| Writing | "click" in a touch app; "Error" / "Oops" / raw `localizedDescription`; a string catalog |
| Privacy | an Info.plist purpose string for each protected API used; permissions asked at launch; `PrivacyInfo.xcprivacy`; Sign in with Apple beside third-party sign-in; account deletion |
| Patterns | launch screen; loading states; destructive role, confirmation or undo; keyboard and AutoFill types on fields; haptics; dismissable sheets; review requests at launch |
| Components | tab bars of five or fewer; `NavigationView` → `NavigationStack`, titled screens; "Yes"/"No" alert buttons; keyboard shortcuts |

## Settings

In `/config`:

- **HIG: guide Claude** (on): the guidelines in Claude's system prompt.
- **HIG: check each edit** (on): edits checked as Claude makes them.

## Limits

- The checks read source text with patterns, not a compiler: expect some false alarms. Waive what
  does not apply, or tell Claude to leave a hit alone.
- Covered means "the check found nothing wrong", not "Apple approved it". The review items are there
  because good design needs judgment.
- React Native, Flutter and Kotlin code are not read.
- Up to 2,500 files of 400 KB or less are read; git-ignored files are skipped.

## Install

```
/plugin marketplace add ntkode/notkode-mods
/plugin install hig@notkode-mods
```
