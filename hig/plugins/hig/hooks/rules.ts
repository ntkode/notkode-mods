import type { Hit, Platform } from '../types'
import type { Ctx, Outcome, SourceFile } from './scan'
import {
  chain, cssBlocks, gap, gapIf, grep, has, hitAt, isAppleConfig, isMarkup, isScript, isStyle, isSwift, na, near, pass, review, tags,
} from './scan'

export const HIG = 'https://developer.apple.com/design/human-interface-guidelines/'

export const AREAS = ['Accessibility', 'Color', 'Typography', 'Layout', 'Icons', 'Writing', 'Privacy', 'Patterns', 'Components', 'Principles'] as const
export type Area = (typeof AREAS)[number]

/**
 * One guideline: what it asks, where Apple writes it down, and how it is checked on each platform.
 * A platform the rule applies to with no check is a review item: Claude or you judge it.
 */
export type Rule = {
  id: string
  area: Area
  title: string
  /** The guideline in one or two sentences, as Claude reads it. */
  guidance: string
  /** The HIG page: `${HIG}${slug}`. */
  slug: string
  platforms: Platform[]
  check?: Partial<Record<Platform, (ctx: Ctx) => Outcome>>
  /** What to look at when judging it by hand. */
  ask?: string
}

const swift = isSwift
const markup = isMarkup
const style = isStyle
const config = isAppleConfig
const anyWeb = (p: string) => isMarkup(p) || isScript(p) || isStyle(p)

/** Lines of Swift that are string literals holding `re`. */
function swiftStrings(ctx: Ctx, re: RegExp): Hit[] {
  return grep(ctx, swift, /"[^"]*"/, (f, i) => [...f.lines[i]!.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].some(m => re.test(m[1]!)))
}

/** The project's root files: the app's entry point and launch callbacks. */
function isLaunchFile(f: SourceFile): boolean {
  return /@main\b|didFinishLaunchingWithOptions|application\(_ application/.test(f.text)
}

/** Purpose strings each privacy-sensitive API needs in Info.plist. */
const PURPOSES: { api: RegExp; keys: string[]; what: string }[] = [
  { api: /requestWhenInUseAuthorization|CLLocationUpdate|CLMonitor\b/, keys: ['NSLocationWhenInUseUsageDescription'], what: 'location' },
  { api: /requestAlwaysAuthorization/, keys: ['NSLocationAlwaysAndWhenInUseUsageDescription'], what: 'location always' },
  { api: /AVCaptureDevice(?![^\n]*\.audio)|AVCaptureVideoPreviewLayer|sourceType\s*=\s*\.camera|DataScannerViewController/, keys: ['NSCameraUsageDescription'], what: 'camera' },
  { api: /AVAudioRecorder|requestRecordPermission|AVAudioApplication\.requestRecordPermission|AVCaptureDevice[^\n]*\.audio|AVAudioEngine\(\)\.inputNode|\.inputNode\b/, keys: ['NSMicrophoneUsageDescription'], what: 'microphone' },
  { api: /SFSpeechRecognizer/, keys: ['NSSpeechRecognitionUsageDescription'], what: 'speech recognition' },
  { api: /PHPhotoLibrary\.requestAuthorization|PHAsset\.fetchAssets/, keys: ['NSPhotoLibraryUsageDescription'], what: 'photo library' },
  { api: /UIImageWriteToSavedPhotosAlbum|PHAccessLevel\.addOnly|\.addOnly\)/, keys: ['NSPhotoLibraryAddUsageDescription', 'NSPhotoLibraryUsageDescription'], what: 'saving photos' },
  { api: /CNContactStore/, keys: ['NSContactsUsageDescription'], what: 'contacts' },
  { api: /EKEventStore/, keys: ['NSCalendarsFullAccessUsageDescription', 'NSCalendarsWriteOnlyAccessUsageDescription', 'NSCalendarsUsageDescription', 'NSRemindersFullAccessUsageDescription', 'NSRemindersUsageDescription'], what: 'calendars and reminders' },
  { api: /HKHealthStore/, keys: ['NSHealthShareUsageDescription'], what: 'Health data' },
  { api: /CMMotionActivityManager|CMPedometer/, keys: ['NSMotionUsageDescription'], what: 'motion' },
  { api: /CBCentralManager|CBPeripheralManager/, keys: ['NSBluetoothAlwaysUsageDescription'], what: 'Bluetooth' },
  { api: /\.deviceOwnerAuthenticationWithBiometrics|biometryType/, keys: ['NSFaceIDUsageDescription'], what: 'Face ID' },
  { api: /ATTrackingManager/, keys: ['NSUserTrackingUsageDescription'], what: 'tracking' },
  { api: /HMHomeManager/, keys: ['NSHomeKitUsageDescription'], what: 'HomeKit' },
  { api: /NWBrowser|NetServiceBrowser|MCNearbyServiceBrowser/, keys: ['NSLocalNetworkUsageDescription'], what: 'local network' },
]

const PERMISSION_REQUEST = /requestWhenInUseAuthorization|requestAlwaysAuthorization|\.requestAuthorization\(|requestAccess\(|requestRecordPermission|requestTrackingAuthorization|requestFullAccessTo/

export const RULES: Rule[] = [
  // ---- Accessibility ----
  {
    id: 'image-labels',
    area: 'Accessibility',
    title: 'Images and icon-only controls have labels',
    guidance: 'Give every meaningful image and icon-only button an accessibility label (alt text on the web); mark purely decorative images as hidden from assistive technologies.',
    slug: 'accessibility',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const hits = grep(ctx, swift, /\bImage\(\s*"[^"]+"\s*\)|\bImage\(\s*systemName:[^)]*\)\s*$/, (f, i) => {
          if (/accessibilityLabel|accessibilityHidden|accessibilityElement|decorative:|Label\(|Text\(/.test(chain(f, i))) return false
          if (near(f, i, /\bLabel\s*\{|\bLabel\(/, 2, 0)) return false
          // A symbol beside its words (an icon and a Text in one row) is read with them.
          return !(/systemName:/.test(f.lines[i]!) && near(f, i, /\bText\(/, 2, 3))
        })
        if (!has(ctx, swift, /\bImage\(/)) return na('No images in the Swift code.')
        return gapIf(hits, n => `${n} images or icons have no label and are not marked decorative.`, 'Every image the check found has a label, text beside it, or is decorative.')
      },
      web: ctx => {
        const hits: Hit[] = []
        let any = false
        for (const f of ctx.files) {
          if (!markup(f.path)) continue
          for (const t of tags(f, 'img')) {
            any = true
            if (!/\balt\s*=/.test(t.text)) hits.push(hitAt(f, t.index))
          }
          for (const t of tags(f, 'button')) {
            any = true
            if (/aria-label|title=|aria-labelledby/.test(t.text)) continue
            // An icon-only button: an <svg> or <Icon> and nothing else to read between the tags.
            const start = f.text.indexOf(t.text) + t.text.length
            const close = f.text.indexOf('</button>', start)
            const inner = close < 0 ? '' : f.text.slice(start, Math.min(close, start + 1500))
            const words = inner.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, '').trim()
            if (/^\s*<(svg|[A-Z]\w*Icon|Icon)\b/.test(inner) && words === '' && !/sr-only|visually-hidden/.test(inner)) hits.push(hitAt(f, t.index))
          }
        }
        if (!any) return na('No images or buttons in the markup.')
        return gapIf(hits, n => `${n} images lack alt or icon-only buttons lack aria-label.`, 'Images have alt text and icon-only buttons have labels.')
      },
    },
  },
  {
    id: 'real-buttons',
    area: 'Accessibility',
    title: 'Tappable things are real buttons',
    guidance: 'Use Button (or <button>) for anything people tap or click, so it gets the button trait, keyboard and switch access, and the system highlight. A tap gesture on a plain view gets none of that.',
    slug: 'buttons',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        if (!has(ctx, swift, /onTapGesture|UITapGestureRecognizer/)) return pass('No tap gestures stand in for buttons.')
        const hits = grep(ctx, swift, /\.onTapGesture\b|UITapGestureRecognizer\(/, (f, i) => !near(f, i, /accessibilityAddTraits|\.isButton|accessibilityAction/, 3, 3))
        return gapIf(hits, n => `${n} tap gestures act as buttons without the button trait.`, 'Tap gestures carry the button trait.')
      },
      web: ctx => {
        const hits: Hit[] = []
        for (const f of ctx.files) {
          if (!markup(f.path)) continue
          for (const tag of ['div', 'span', 'li', 'img', 'td']) {
            for (const t of tags(f, tag)) {
              // A backdrop that closes a menu is hidden from assistive technology on purpose.
              if (/\bon[Cc]lick\b|@click|on:click/.test(t.text) && !/\brole\s*=\s*["']?(button|link|tab|menuitem|option|checkbox)|aria-hidden/.test(t.text)) hits.push(hitAt(f, t.index))
            }
          }
        }
        return gapIf(hits, n => `${n} clickable elements are not buttons (no role, no keyboard).`, 'Clickable elements are buttons or carry a role.')
      },
    },
  },
  {
    id: 'touch-targets',
    area: 'Accessibility',
    title: 'Controls are at least 44×44 points',
    guidance: 'Make every control at least 44×44 pt on iOS and iPadOS (28×28 pt on macOS) so people can hit it; pad small glyphs rather than shrinking the hit area.',
    slug: 'accessibility',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const min = ctx.stack.ios ? 44 : 28
        const hits = grep(ctx, swift, /\.frame\([^)]*(width|height):\s*\d/, (f, i) => {
          const line = f.lines[i]!
          const w = Number(/width:\s*(\d+(?:\.\d+)?)/.exec(line)?.[1] ?? Infinity)
          const h = Number(/height:\s*(\d+(?:\.\d+)?)/.exec(line)?.[1] ?? Infinity)
          const small = Math.min(w, h) < min && (w === Infinity || w < min * 2) && (h === Infinity || h < min * 2)
          return small && near(f, i, /\bButton\b|onTapGesture|Toggle\(|Menu\s*\{|Link\(/, 6, 0) && !near(f, i, /contentShape|\.padding\(/, 0, 2)
        })
        return gapIf(hits, n => `${n} controls are framed smaller than ${min} pt with no padding or content shape.`, `No control is framed under ${min} pt.`)
      },
      web: ctx => {
        const hits: Hit[] = []
        for (const f of ctx.files) {
          if (!style(f.path)) continue
          for (const b of cssBlocks(f)) {
            if (!/button|\.btn|\[role=["']?button|\bicon-button|\ba\b/.test(b.selector)) continue
            const h = /(?:^|[;\s])(?:min-)?height:\s*(\d+(?:\.\d+)?)px/.exec(b.body)
            const w = /(?:^|[;\s])(?:min-)?width:\s*(\d+(?:\.\d+)?)px/.exec(b.body)
            if ((h && Number(h[1]) < 44) || (w && Number(w[1]) < 44 && !/padding/.test(b.body))) hits.push(hitAt(f, b.index))
          }
        }
        return gapIf(hits, n => `${n} button styles set a size under 44 px.`, 'No button style sets a size under 44 px.')
      },
    },
  },
  {
    id: 'reduce-motion',
    area: 'Accessibility',
    title: 'Motion respects Reduce Motion',
    guidance: 'When people turn on Reduce Motion, tone down or replace animation (fades instead of slides, no parallax or auto-playing motion). Read accessibilityReduceMotion in SwiftUI, prefers-reduced-motion on the web.',
    slug: 'motion',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const anims = grep(ctx, swift, /withAnimation|\.animation\(|\.transition\(|UIView\.animate|matchedGeometryEffect|\.phaseAnimator|\.keyframeAnimator|repeatForever/)
        if (anims.length === 0) return na('No animation in the Swift code.')
        if (has(ctx, swift, /accessibilityReduceMotion|isReduceMotionEnabled/)) return pass('Animations read Reduce Motion.')
        return gap(`${anims.length} animations and nothing reads Reduce Motion.`, anims)
      },
      web: ctx => {
        const anims = grep(ctx, anyWeb, /@keyframes|animation\s*:|transition\s*:|animate-|framer-motion|<motion\./)
        if (anims.length === 0) return na('No animation in the web code.')
        if (has(ctx, anyWeb, /prefers-reduced-motion|useReducedMotion|motion-reduce|motion-safe/)) return pass('Animations honor prefers-reduced-motion.')
        return gap(`${anims.length} animations and no prefers-reduced-motion.`, anims)
      },
    },
  },
  {
    id: 'gesture-alternatives',
    area: 'Accessibility',
    title: 'Custom gestures have an alternative',
    guidance: 'Every action reached by a custom gesture (drag, long press, pinch, swipe) is also reachable another way: a button, a menu, a context menu or an accessibility action.',
    slug: 'gestures',
    platforms: ['apple'],
    check: {
      apple: ctx => {
        const gestures = grep(ctx, swift, /DragGesture|LongPressGesture|onLongPressGesture|MagnifyGesture|MagnificationGesture|RotateGesture|RotationGesture|UI(Swipe|Pan|LongPress|Pinch|Rotation)GestureRecognizer/)
        if (gestures.length === 0) return na('No custom gestures.')
        if (has(ctx, swift, /accessibilityAction|accessibilityAdjustableAction|contextMenu|swipeActions|accessibilityCustomActions/)) return pass('Gestures have accessibility actions or menus beside them.')
        return gap(`${gestures.length} custom gestures and no accessibility action or menu offering the same.`, gestures)
      },
    },
  },
  {
    id: 'keyboard-focus',
    area: 'Accessibility',
    title: 'Keyboard focus stays visible and in order',
    guidance: 'Never remove the focus ring without a visible replacement (:focus-visible), and never set a positive tabindex: keep focus order the reading order.',
    slug: 'focus-and-selection',
    platforms: ['web'],
    check: {
      web: ctx => {
        const killed = grep(ctx, anyWeb, /outline\s*:\s*(none|0)\b|outline-none\b/)
        const positive = grep(ctx, markup, /tab[iI]ndex\s*=\s*\{?["']?[1-9]/)
        const keepsRing = has(ctx, anyWeb, /:focus-visible|focus-visible:|focus:ring|focus:outline/)
        const hits = [...(keepsRing ? [] : killed), ...positive]
        return gapIf(hits, n => `${n} places hide the focus ring with no :focus-visible style, or set a positive tabindex.`, 'Focus stays visible and in reading order.')
      },
    },
  },
  {
    id: 'zoom',
    area: 'Accessibility',
    title: 'People can zoom',
    guidance: 'Do not disable pinch-zoom: no user-scalable=no or maximum-scale=1 in the viewport meta tag.',
    slug: 'accessibility',
    platforms: ['web'],
    check: {
      web: ctx => {
        const hits = grep(ctx, markup, /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/)
        return gapIf(hits, () => 'The viewport stops people from zooming.', 'Zoom is left on.')
      },
    },
  },
  {
    id: 'voiceover',
    area: 'Accessibility',
    title: 'VoiceOver reads custom views well',
    guidance: 'Custom views expose a role, value and hint; related elements are grouped (accessibilityElement(children: .combine)); the reading order follows the visual order.',
    slug: 'voiceover',
    platforms: ['apple', 'web'],
    ask: 'Walk the main screens as VoiceOver would: is every element announced with a useful label, role and value, in order?',
  },
  {
    id: 'contrast',
    area: 'Accessibility',
    title: 'Text has enough contrast',
    guidance: 'Text and glyphs meet at least 4.5:1 contrast with their background (3:1 for large text), in light and dark appearances and with Increase Contrast.',
    slug: 'color',
    platforms: ['apple', 'web'],
    ask: 'Check the text and icon colors against their backgrounds in both appearances; flag pairs under 4.5:1.',
  },

  // ---- Color ----
  {
    id: 'semantic-colors',
    area: 'Color',
    title: 'Colors are semantic, not hard-coded',
    guidance: 'Use system and semantic colors (Color.primary, .secondary, Color(.systemBackground), asset-catalog colors with light and dark variants) or design tokens, not literal RGB, hex, black or white, so color adapts to appearance and contrast settings.',
    slug: 'color',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const hits = grep(ctx, swift, /\bColor\(\s*red:|UIColor\(\s*red:|Color\(\s*hex|UIColor\(\s*hex|#colorLiteral|(foregroundColor|foregroundStyle|background|fill|tint)\(\s*(Color)?\.(black|white)\s*\)|backgroundColor\s*=\s*\.(white|black)\b/)
        return gapIf(hits, n => `${n} hard-coded colors that will not adapt to Dark Mode or Increase Contrast.`, 'Colors come from the system or the asset catalog.')
      },
      web: ctx => {
        const hits = grep(ctx, style, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/, (f, i) => !/^\s*--/.test(f.lines[i]!) && !/var\(--/.test(f.lines[i]!))
        if (!has(ctx, style, /\{/)) return review('No stylesheets: colors may live in components or a utility framework.')
        return gapIf(hits, n => `${n} literal colors outside custom properties.`, 'Colors go through custom properties.')
      },
    },
  },
  {
    id: 'dark-mode',
    area: 'Color',
    title: 'Dark Mode is supported',
    guidance: 'Support both light and dark appearances; never force one appearance app-wide (preferredColorScheme(.light), UIUserInterfaceStyle = Light). On the web, answer prefers-color-scheme.',
    slug: 'dark-mode',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const forced = [
          ...grep(ctx, swift, /preferredColorScheme\(\s*\.(light|dark)\s*\)|overrideUserInterfaceStyle\s*=\s*\.(light|dark)/),
          ...grep(ctx, config, /UIUserInterfaceStyle|INFOPLIST_KEY_UIUserInterfaceStyle\s*=\s*(Light|Dark)/, (f, i) => /Light|Dark/.test(f.lines[i]! + (f.lines[i + 1] ?? ''))),
        ]
        return gapIf(forced, () => 'The app forces one appearance.', 'The app follows the system appearance.')
      },
      web: ctx => {
        if (has(ctx, anyWeb, /prefers-color-scheme|color-scheme\s*:|name=["']color-scheme|darkMode|dark:/)) return pass('Answers prefers-color-scheme.')
        return gap('Nothing answers prefers-color-scheme: dark appearance is not supported.')
      },
    },
  },
  {
    id: 'color-not-alone',
    area: 'Color',
    title: 'Color is never the only signal',
    guidance: 'Pair color with a shape, symbol or text for status and meaning (errors, selection, charts), so people who cannot tell the colors apart still get it.',
    slug: 'color',
    platforms: ['apple', 'web'],
    ask: 'Find states shown by color alone (red text for errors, a green dot for online) and check each has a symbol or words too.',
  },

  // ---- Typography ----
  {
    id: 'dynamic-type',
    area: 'Typography',
    title: 'Text scales with Dynamic Type',
    guidance: 'Use text styles (.body, .headline, .title) or custom fonts that scale (Font.custom(_:size:relativeTo:), UIFontMetrics) so text follows the person\'s text size; on the web, size text in rem, not px.',
    slug: 'typography',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const scales = has(ctx, swift, /UIFontMetrics|adjustsFontForContentSizeCategory/)
        const hits = grep(ctx, swift, /\.system\(\s*size:|\.custom\([^)]*fixedSize:|UIFont\.systemFont\(ofSize:|UIFont\(name:/, (f, i) => {
          const line = f.lines[i]!
          if (/^\s*(static|let|var)\b.*UIFont/.test(line) && scales) return false
          return !(scales && /UIFont/.test(line))
        })
        return gapIf(hits, n => `${n} fixed font sizes that ignore the person's text size.`, 'Text uses styles that scale.')
      },
      web: ctx => {
        const px = grep(ctx, style, /font-size\s*:\s*\d+(\.\d+)?px/)
        const rel = grep(ctx, style, /font-size\s*:\s*[\d.]+(rem|em|%)|font-size\s*:\s*var\(|font-size\s*:\s*clamp/)
        if (px.length === 0) return pass('Font sizes are relative.')
        return px.length > rel.length ? gap(`${px.length} font sizes in px, which ignore the browser's text size.`, px) : pass('Font sizes are mostly relative.')
      },
    },
  },
  {
    id: 'min-text-size',
    area: 'Typography',
    title: 'Text is legible',
    guidance: 'Keep text at 11 pt or more on iOS (17 pt body by default) and 10 pt or more on macOS (13 pt body); use weight and color, not tiny sizes, for hierarchy.',
    slug: 'typography',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        // macOS draws smaller: its body is 13 pt and its smallest text 10 pt.
        const min = ctx.stack.ios ? 11 : 10
        const hits = grep(ctx, swift, /size:\s*\d|ofSize:\s*\d/, (f, i) => {
          const n = Number(/(?:size|ofSize):\s*(\d+(?:\.\d+)?)/.exec(f.lines[i]!)?.[1])
          return /font|Font|\.system|\.custom/.test(f.lines[i]!) && n > 0 && n < min
        })
        return gapIf(hits, n => `${n} text sizes under ${min} pt.`, `No text under ${min} pt.`)
      },
      web: ctx => {
        const hits = grep(ctx, style, /font-size\s*:/, (f, i) => {
          const m = /font-size\s*:\s*(\d+(?:\.\d+)?)(px|rem|em)/.exec(f.lines[i]!)
          if (!m) return false
          const px = m[2] === 'px' ? Number(m[1]) : Number(m[1]) * 16
          return px < 11
        })
        return gapIf(hits, n => `${n} font sizes under 11 px.`, 'No text under 11 px.')
      },
    },
  },

  // ---- Layout ----
  {
    id: 'safe-areas',
    area: 'Layout',
    title: 'Content respects safe areas',
    guidance: 'Keep controls and text inside the safe area; only backgrounds, images and full-bleed media extend under the notch, Dynamic Island and Home indicator.',
    slug: 'layout',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const hits = grep(ctx, swift, /ignoresSafeArea\(|edgesIgnoringSafeArea\(/, (f, i) =>
          !near(f, i, /background|Color\b|Color\.|Image\(|Gradient|Rectangle|Map\b|Map\(|VideoPlayer|Camera|Material|ScrollView/, 3, 0))
        return gapIf(hits, n => `${n} views ignore the safe area that are not backgrounds or media.`, 'Only backgrounds and media leave the safe area.')
      },
      web: ctx => {
        if (!has(ctx, markup, /viewport-fit\s*=\s*cover/)) return pass('The page stays inside the safe area (no viewport-fit=cover).')
        if (has(ctx, anyWeb, /safe-area-inset/)) return pass('viewport-fit=cover with safe-area-inset padding.')
        return gap('viewport-fit=cover without env(safe-area-inset-*) padding: content can sit under the notch.', grep(ctx, markup, /viewport-fit\s*=\s*cover/))
      },
    },
  },
  {
    id: 'adaptive-layout',
    area: 'Layout',
    title: 'Layout adapts to every size',
    guidance: 'Lay out with stacks, size classes and flexible frames rather than screen sizes or fixed widths, so the app works on every device, in Split View, rotated and at large text sizes.',
    slug: 'layout',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        // A Mac window or settings pane may well have a fixed width; a phone screen may not.
        const fixed = ctx.stack.ios ? '|\\.frame\\(\\s*width:\\s*(3[2-9]\\d|[4-9]\\d\\d|\\d{4,})\\b' : ''
        const hits = grep(ctx, swift, new RegExp(`UIScreen\\.main\\.bounds|UIScreen\\.main\\.nativeBounds${fixed}`))
        return gapIf(hits, n => `${n} layouts read the screen size or set a phone-wide fixed width.`, 'No layout reads the screen size or fixes a wide width.')
      },
      web: ctx => {
        // Next.js writes the viewport tag itself.
        const framework = ctx.paths.some(p => /(^|\/)next\.config\.[cm]?[jt]s$/.test(p)) || has(ctx, isScript, /export const viewport\b/)
        if (!framework && !has(ctx, markup, /<html|<head/)) return review('No HTML document found to check for a viewport tag.')
        if (!framework && !has(ctx, markup, /name=["']viewport["']/)) return gap('No <meta name="viewport">: the page will not adapt on phones.')
        if (!has(ctx, anyWeb, /@media|@container|\b(sm|md|lg):|clamp\(|minmax\(|auto-fit|flex-wrap/)) return gap('No media queries or fluid layout found.')
        return pass('Viewport set and the layout responds to size.')
      },
    },
  },
  {
    id: 'right-to-left',
    area: 'Layout',
    title: 'Layout mirrors for right-to-left',
    guidance: 'Use leading and trailing, not left and right, so layouts mirror for Arabic and Hebrew; on the web use logical properties (margin-inline-start, text-align: start).',
    slug: 'right-to-left',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const hits = grep(ctx, swift, /\.padding\(\s*\.(left|right)\b|textAlignment\s*=\s*\.(left|right)\b|NSTextAlignment\.(left|right)|contentHorizontalAlignment\s*=\s*\.(left|right)\b|leftAnchor|rightAnchor|semanticContentAttribute\s*=\s*\.forceLeftToRight/)
        return gapIf(hits, n => `${n} places use left and right instead of leading and trailing.`, 'Layout uses leading and trailing.')
      },
      web: ctx => {
        const physical = grep(ctx, style, /(margin|padding)-(left|right)\s*:|text-align\s*:\s*(left|right)|\b(left|right)\s*:\s*\d/)
        if (has(ctx, anyWeb, /margin-inline|padding-inline|inset-inline|text-align\s*:\s*(start|end)|\b(ms|me|ps|pe|start|end)-\d/)) return pass('Uses logical properties.')
        return gapIf(physical, n => `${n} physical left/right properties and no logical ones.`, 'No left/right-only layout.')
      },
    },
  },

  // ---- Icons ----
  {
    id: 'app-icon',
    area: 'Icons',
    title: 'The app has a proper icon',
    guidance: 'Provide an app icon in the asset catalog (or an Icon Composer .icon with light, dark and tinted variants); on the web, an apple-touch-icon and manifest icons.',
    slug: 'app-icons',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => (ctx.paths.some(p => /AppIcon\.appiconset\/|\.icon\/icon\.json$|\.icns$/.test(p)) ? pass('App icon found.') : gap('No AppIcon set, .icon or .icns file found.')),
      web: ctx => {
        if (ctx.paths.some(p => /apple-touch-icon[^/]*\.png$|(^|\/)app\/apple-icon\.\w+$/.test(p))) return pass('Touch icon found.')
        if (!has(ctx, markup, /<head/) && !ctx.paths.some(p => /(^|\/)next\.config\./.test(p))) return na('No HTML head to check.')
        return has(ctx, anyWeb, /apple-touch-icon/) || ctx.files.some(f => /manifest\.json$|\.webmanifest$/.test(f.path) && /"icons"/.test(f.text)) ? pass('Touch icon found.') : gap('No apple-touch-icon or manifest icons.')
      },
    },
  },
  {
    id: 'sf-symbols',
    area: 'Icons',
    title: 'Interface icons use SF Symbols',
    guidance: 'Use SF Symbols for interface glyphs: they match system text, scale with Dynamic Type, support weights and rendering modes, and are localized.',
    slug: 'sf-symbols',
    platforms: ['apple'],
    check: {
      apple: ctx => {
        if (has(ctx, swift, /systemName:|systemSymbolName:/)) return pass('SF Symbols are used.')
        const assets = grep(ctx, swift, /\bImage\(\s*"[^"]+"\s*\)|UIImage\(named:/)
        if (assets.length === 0) return na('No icons in the Swift code.')
        return gap(`${assets.length} asset images and no SF Symbols.`, assets)
      },
    },
  },

  // ---- Writing ----
  {
    id: 'platform-words',
    area: 'Writing',
    title: 'Words fit the platform',
    guidance: 'On touch devices say tap, not click; use the platform\'s own names (Settings, Home Screen) and title-case button labels on macOS.',
    slug: 'writing',
    platforms: ['apple'],
    check: {
      apple: ctx => {
        if (!ctx.stack.ios) return na('A Mac app: click is the right word.')
        const hits = swiftStrings(ctx, /\b[Cc]lick(ed|ing)?\b/)
        return gapIf(hits, n => `${n} strings say click in an app people tap.`, 'No click in a touch app.')
      },
    },
  },
  {
    id: 'helpful-errors',
    area: 'Writing',
    title: 'Errors say what happened and what to do',
    guidance: 'Error messages explain the problem in plain words and offer a way forward; never just "Error", "Oops" or a raw error description.',
    slug: 'alerts',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const vague = swiftStrings(ctx, /^(error!?|oops!?|something went wrong\.?|an error (has )?occurred\.?|unknown error\.?|failed\.?)$/i)
        const raw = grep(ctx, swift, /(Text|alert|message)\(.*\.localizedDescription/)
        return gapIf([...vague, ...raw], n => `${n} vague or raw error messages.`, 'Errors read as people would say them.')
      },
      web: ctx => {
        const hits = [
          ...grep(ctx, isScript, /["'`](Error!?|Oops!?|Something went wrong\.?|An error occurred\.?|Unknown error\.?)["'`]/),
          ...grep(ctx, isScript, /\balert\(\s*(err|error|e)(\.message)?\s*\)/),
        ]
        return gapIf(hits, n => `${n} vague or raw error messages.`, 'Errors read as people would say them.')
      },
    },
  },
  {
    id: 'localization',
    area: 'Writing',
    title: 'Text is ready to localize',
    guidance: 'Keep interface text in a string catalog (Localizable.xcstrings) or an i18n library, never concatenate sentences, and format dates, numbers and units with the locale.',
    slug: 'writing',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        if (ctx.files.some(f => /\.(xcstrings|strings)$/.test(f.path)) || has(ctx, swift, /String\(localized:|NSLocalizedString/)) return pass('Strings are localizable.')
        const texts = grep(ctx, swift, /\bText\(\s*"[A-Za-z]/)
        return texts.length > 3 ? gap(`${texts.length} interface strings and no string catalog.`, texts) : na('Too little text to judge.')
      },
      web: ctx => (has(ctx, isScript, /i18next|react-intl|next-intl|vue-i18n|useTranslation|FormattedMessage|\$t\(|svelte-i18n|lingui/) ? pass('An i18n library is in use.') : review('No i18n library found: fine if the product ships in one language.')),
    },
  },

  // ---- Privacy ----
  {
    id: 'purpose-strings',
    area: 'Privacy',
    title: 'Every permission says why',
    guidance: 'Each protected resource the app touches (location, camera, microphone, photos, contacts, Health...) has a purpose string in Info.plist that says, in a full sentence, how the data helps the person.',
    slug: 'privacy',
    platforms: ['apple'],
    check: {
      apple: ctx => {
        const plist = ctx.files.filter(f => config(f.path)).map(f => f.text).join('\n')
        const hits: Hit[] = []
        const missing: string[] = []
        let used = 0
        for (const p of PURPOSES) {
          const uses = grep(ctx, swift, p.api)
          if (uses.length === 0) continue
          used++
          if (!p.keys.some(k => plist.includes(k))) {
            missing.push(`${p.what} (${p.keys[0]})`)
            hits.push(...uses.slice(0, 3))
          }
        }
        if (used === 0) return na('No protected resources are used.')
        return missing.length ? gap(`Missing purpose strings: ${missing.join(', ')}.`, hits) : pass('Every protected resource has a purpose string.')
      },
    },
  },
  {
    id: 'ask-in-context',
    area: 'Privacy',
    title: 'Permissions are asked in context',
    guidance: 'Ask for a permission when people use the feature that needs it, not at launch; explain first when the reason is not obvious.',
    slug: 'privacy',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const all = grep(ctx, swift, PERMISSION_REQUEST)
        if (all.length === 0) return na('No permission requests.')
        const atLaunch = all.filter(h => isLaunchFile(ctx.files.find(f => f.path === h.path)!))
        return gapIf(atLaunch, n => `${n} permission requests run at launch.`, 'Permissions are requested away from launch.')
      },
      web: ctx => {
        const all = grep(ctx, isScript, /Notification\.requestPermission|geolocation\.(getCurrentPosition|watchPosition)|getUserMedia\(/)
        if (all.length === 0) return na('No permission requests.')
        const atLoad = all.filter(h => {
          const f = ctx.files.find(x => x.path === h.path)!
          return /(^|\/)(main|index)\.[jt]sx?$/.test(f.path) || near(f, h.line - 1, /DOMContentLoaded|addEventListener\(\s*['"]load|window\.onload|useEffect\(\s*\(\)\s*=>\s*\{?\s*$/, 3, 0)
        })
        return gapIf(atLoad, n => `${n} permission requests run on page load.`, 'Permissions are requested from a person\'s action.')
      },
    },
  },
  {
    id: 'privacy-manifest',
    area: 'Privacy',
    title: 'A privacy manifest is included',
    guidance: 'Ship a PrivacyInfo.xcprivacy that declares the data collected and the required-reason APIs used (UserDefaults, file timestamps, disk space...).',
    slug: 'privacy',
    platforms: ['apple'],
    check: {
      apple: ctx => (ctx.paths.some(p => p.endsWith('.xcprivacy')) ? pass('PrivacyInfo.xcprivacy found.') : gap('No PrivacyInfo.xcprivacy in the project.')),
    },
  },
  {
    id: 'sign-in-with-apple',
    area: 'Privacy',
    title: 'Sign in with Apple sits beside other sign-ins',
    guidance: 'An app that offers third-party sign-in (Google, Facebook...) also offers Sign in with Apple, with the system button, at least as prominent.',
    slug: 'sign-in-with-apple',
    platforms: ['apple'],
    check: {
      apple: ctx => {
        const third = grep(ctx, swift, /GIDSignIn|GoogleSignIn|FBSDKLoginKit|FacebookLogin|LoginManager\(\)|TwitterKit|MSALPublicClientApplication/)
        const apple = has(ctx, swift, /SignInWithAppleButton|ASAuthorizationAppleIDProvider|ASAuthorizationAppleIDButton/)
        if (apple) return pass('Sign in with Apple is offered.')
        if (third.length === 0) return na('No third-party sign-in.')
        return gap('Third-party sign-in without Sign in with Apple.', third)
      },
    },
  },
  {
    id: 'delete-account',
    area: 'Privacy',
    title: 'Accounts can be deleted in the app',
    guidance: 'If people can create an account, let them delete it from within the app, plainly and without a detour.',
    slug: 'managing-accounts',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => accountCheck(ctx, swift),
      web: ctx => accountCheck(ctx, isScript),
    },
  },

  // ---- Patterns ----
  {
    id: 'launch-screen',
    area: 'Patterns',
    title: 'Launch looks like the first screen',
    guidance: 'Provide a launch screen that resembles the app\'s first screen (no logo splash, no text) so launch feels instant.',
    slug: 'launching',
    platforms: ['apple'],
    check: {
      apple: ctx => {
        if (!ctx.stack.ios) return na('Mac apps have no launch screen.')
        return has(ctx, config, /UILaunchScreen|UILaunchStoryboardName|INFOPLIST_KEY_UILaunchScreen_Generation|INFOPLIST_KEY_UILaunchStoryboardName/) || ctx.files.some(f => /LaunchScreen\.storyboard$/.test(f.path))
          ? pass('A launch screen is configured.')
          : gap('No launch screen configured.')
      },
    },
  },
  {
    id: 'loading',
    area: 'Patterns',
    title: 'Loading is shown, not hidden',
    guidance: 'While content loads, show progress or a placeholder (ProgressView, redacted skeleton) and let people do something else; never a blank or frozen screen.',
    slug: 'loading',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const work = grep(ctx, swift, /URLSession|\.task\s*\{|\.task\(|\.refreshable|AsyncImage\(/)
        if (work.length === 0) return na('No asynchronous loading.')
        return has(ctx, swift, /ProgressView|UIActivityIndicatorView|\.redacted\(|isLoading|ContentUnavailableView/) ? pass('Loading states are shown.') : gap(`${work.length} places load data and nothing shows progress.`, work)
      },
      web: ctx => {
        const work = grep(ctx, isScript, /\bfetch\(|axios\.|useQuery\(|useSWR\(|createResource\(/)
        if (work.length === 0) return na('No asynchronous loading.')
        return has(ctx, anyWeb, /[Ll]oading|[Ss]pinner|[Ss]keleton|aria-busy|<Suspense|isPending|<progress/) ? pass('Loading states are shown.') : gap(`${work.length} requests and no loading state.`, work)
      },
    },
  },
  {
    id: 'destructive-actions',
    area: 'Patterns',
    title: 'Destructive actions are marked and confirmed',
    guidance: 'Give destructive buttons the destructive role (red), confirm actions that cannot be undone, and prefer undo over confirmation when you can.',
    slug: 'undo-and-redo',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const deletes = grep(ctx, swift, /\.onDelete\b|modelContext\.delete|context\.delete\(|\.delete\(\s*\w|removeAll\(|"Delete|"Remove/)
        if (deletes.length === 0) return na('No destructive actions.')
        return has(ctx, swift, /role:\s*\.destructive|\.destructive\(|confirmationDialog|UIAlertAction[^\n]*\.destructive|undoManager|UndoManager/) ? pass('Destructive actions are marked or undoable.') : gap(`${deletes.length} destructive actions with no destructive role, confirmation or undo.`, deletes)
      },
      web: ctx => {
        const deletes = grep(ctx, markup, />\s*(Delete|Remove|Discard|Erase)\b[^<]*</)
        if (deletes.length === 0) return na('No destructive actions.')
        return has(ctx, isScript, /confirm\(|<Dialog|<Modal|AlertDialog|role=["']alertdialog|[Uu]ndo/) ? pass('Destructive actions are confirmed or undoable.') : gap(`${deletes.length} destructive buttons with no confirmation or undo.`, deletes)
      },
    },
  },
  {
    id: 'text-entry',
    area: 'Patterns',
    title: 'Text fields fit what they ask for',
    guidance: 'Set the keyboard type and text content type on fields (email, phone, password, one-time code) so the right keyboard and AutoFill appear; on the web, the input type and autocomplete.',
    slug: 'entering-data',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const fields = grep(ctx, swift, /\b(TextField|SecureField)\(/)
        if (fields.length === 0) return na('No text fields.')
        const hits = grep(ctx, swift, /\b(TextField|SecureField)\(/, (f, i) => {
          const line = f.lines[i]!
          const typed = near(f, i, /\.keyboardType|\.textContentType/, 0, 6)
          return !typed && (/SecureField/.test(line) || /email|e-mail|phone|password|url|website|zip|postal|code|amount|price/i.test(line))
        })
        return gapIf(hits, n => `${n} email, phone, password or number fields with no keyboard or content type.`, 'Fields set the right keyboard and AutoFill.')
      },
      web: ctx => {
        const hits: Hit[] = []
        let any = false
        for (const f of ctx.files) {
          if (!markup(f.path)) continue
          for (const t of tags(f, 'input')) {
            any = true
            const kind = /type\s*=\s*["']?(\w+)/.exec(t.text)?.[1]?.toLowerCase() ?? 'text'
            const named = /(name|id|placeholder)\s*=\s*["'][^"']*(email|phone|tel|password|zip|postal)/i.exec(t.text)?.[2]?.toLowerCase()
            const wantsType = named === 'email' ? 'email' : named === 'phone' || named === 'tel' ? 'tel' : named === 'password' ? 'password' : undefined
            const sensitive = ['email', 'password', 'tel'].includes(kind) || wantsType
            if ((wantsType && kind === 'text') || (sensitive && !/autoComplete|autocomplete/.test(t.text))) hits.push(hitAt(f, t.index))
          }
        }
        if (!any) return na('No inputs.')
        return gapIf(hits, n => `${n} inputs miss the right type or autocomplete.`, 'Inputs set type and autocomplete.')
      },
    },
  },
  {
    id: 'haptics',
    area: 'Patterns',
    title: 'Feedback is felt where it helps',
    guidance: 'Use system haptics (sensoryFeedback, UIFeedbackGenerator) to confirm meaningful moments (success, failure, a snap into place), sparingly and consistent with the system.',
    slug: 'playing-haptics',
    platforms: ['apple'],
    check: {
      apple: ctx => {
        if (!ctx.stack.ios) return na('Haptics are for iPhone and Apple Watch.')
        return has(ctx, swift, /sensoryFeedback|UI(Impact|Notification|Selection)FeedbackGenerator|CHHapticEngine/) ? pass('System haptics are used.') : review('No haptics: judge whether success, failure or selection moments would be clearer with them.')
      },
    },
    ask: 'Find the moments that complete a task, fail, or snap to a value; would system haptics make them clearer?',
  },
  {
    id: 'onboarding',
    area: 'Patterns',
    title: 'Onboarding is short and skippable',
    guidance: 'Let people start using the app right away; keep onboarding brief, teach in context rather than up front, and never ask for ratings or permissions before they have seen value.',
    slug: 'onboarding',
    platforms: ['apple', 'web'],
    ask: 'Read the first-run flow: how many screens before people can do the main task? Can they skip?',
  },
  {
    id: 'ratings',
    area: 'Patterns',
    title: 'Ratings are asked at the right moment',
    guidance: 'Request a review with the system API after people have succeeded at something, never at launch or after a failure.',
    slug: 'ratings-and-reviews',
    platforms: ['apple'],
    check: {
      apple: ctx => {
        const asks = grep(ctx, swift, /requestReview|SKStoreReviewController/)
        if (asks.length === 0) return na('The app does not ask for reviews.')
        const atLaunch = asks.filter(h => isLaunchFile(ctx.files.find(f => f.path === h.path)!))
        return gapIf(atLaunch, () => 'A review is requested at launch.', 'Reviews are requested away from launch.')
      },
    },
  },
  {
    id: 'sheets',
    area: 'Patterns',
    title: 'Sheets and modals can be dismissed',
    guidance: 'Use modality only for a focused task; give each sheet a clear way out (Done or Cancel, swipe down, Escape on the web) and a full-screen cover an explicit close button.',
    slug: 'sheets',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const sheets = grep(ctx, swift, /\.sheet\(|\.fullScreenCover\(|\.popover\(/)
        if (sheets.length === 0) return na('No sheets.')
        return has(ctx, swift, /dismiss\(\)|\\\.dismiss|presentationMode|isPresented\s*=\s*false|"(Done|Cancel|Close)"/) ? pass('Sheets have a way out.') : gap(`${sheets.length} sheets and no Done, Cancel or dismiss.`, sheets)
      },
      web: ctx => {
        const modals = grep(ctx, markup, /<dialog\b|role=["']dialog|<Modal\b|<Dialog\b/)
        if (modals.length === 0) return na('No dialogs.')
        return has(ctx, anyWeb, /Escape|onClose|onOpenChange|\.close\(\)|aria-label=["']Close/) ? pass('Dialogs close with Escape or a close button.') : gap(`${modals.length} dialogs and no close or Escape handling.`, modals)
      },
    },
  },
  {
    id: 'search',
    area: 'Patterns',
    title: 'Large collections are searchable',
    guidance: 'Where people browse a lot of content, offer search where they expect it (searchable in the navigation bar or toolbar), with suggestions and scopes when they help.',
    slug: 'searching',
    platforms: ['apple', 'web'],
    ask: 'Is there a list long enough that people would want to search it, and can they?',
  },

  // ---- Components ----
  {
    id: 'tab-bar',
    area: 'Components',
    title: 'Tab bars stay short and for navigation',
    guidance: 'Use a tab bar for top-level navigation only, with five tabs or fewer on iPhone; never for actions, never hidden on the way down a hierarchy.',
    slug: 'tab-bars',
    platforms: ['apple'],
    check: {
      apple: ctx => {
        const hits: Hit[] = []
        let any = false
        for (const f of ctx.files) {
          if (!swift(f.path)) continue
          const tabs = f.lines.map((l, i) => [l, i] as const).filter(([l]) => /\.tabItem\b|^\s*Tab\(/.test(l))
          if (tabs.length > 0) any = true
          if (tabs.length > 5) hits.push({ ...hitAt(f, tabs[0]![1]), text: `${tabs.length} tabs in ${f.path}` })
        }
        if (!any) return na('No tab bar.')
        return gapIf(hits, () => 'A tab bar has more than five tabs.', 'Tab bars have five tabs or fewer.')
      },
    },
  },
  {
    id: 'navigation',
    area: 'Components',
    title: 'Navigation is current and titled',
    guidance: 'Use NavigationStack or NavigationSplitView (not the deprecated NavigationView), give every screen a title, and keep Back where people expect it.',
    slug: 'navigation-and-search',
    platforms: ['apple'],
    check: {
      apple: ctx => {
        const old = grep(ctx, swift, /\bNavigationView\s*\{/)
        const stacks = grep(ctx, swift, /\bNavigation(Stack|SplitView|View)\b/)
        if (stacks.length === 0) return na('No SwiftUI navigation.')
        if (old.length) return gap(`${old.length} uses of the deprecated NavigationView.`, old)
        return has(ctx, swift, /\.navigationTitle\(/) ? pass('Navigation is current and titled.') : gap('Navigation with no navigationTitle anywhere.', stacks)
      },
    },
  },
  {
    id: 'alerts',
    area: 'Components',
    title: 'Alerts are rare and plainly worded',
    guidance: 'Save alerts for important information that needs a decision; title with the situation, use verbs on buttons ("Delete", not "Yes"), put Cancel where the platform puts it.',
    slug: 'alerts',
    platforms: ['apple', 'web'],
    check: {
      apple: ctx => {
        const yesNo = grep(ctx, swift, /Button\(\s*"(Yes|No)"/, (f, i) => near(f, i, /\.alert\(|UIAlertController|confirmationDialog/, 8, 0))
        if (!has(ctx, swift, /\.alert\(|UIAlertController/)) return na('No alerts.')
        return gapIf(yesNo, n => `${n} alert buttons say Yes or No instead of the action.`, 'Alert buttons name their action.')
      },
    },
    ask: 'Are alerts used only for decisions that matter? Would an inline message or undo serve better?',
  },
  {
    id: 'system-components',
    area: 'Components',
    title: 'System components over custom look-alikes',
    guidance: 'Prefer standard controls (Button, Toggle, Picker, List, Menu, toolbars) over custom imitations: people know them and they bring accessibility, Dynamic Type and new platform looks for free.',
    slug: 'components',
    platforms: ['apple', 'web'],
    ask: 'Look for hand-built switches, segmented controls, pickers or navigation that a system component already provides.',
  },
  {
    id: 'keyboard-shortcuts',
    area: 'Components',
    title: 'Common commands have keyboard shortcuts',
    guidance: 'On iPad and Mac, give frequent commands the standard shortcuts (⌘N, ⌘F, ⌘W...) through keyboardShortcut and the menu bar commands.',
    slug: 'keyboards',
    platforms: ['apple'],
    check: {
      apple: ctx => (has(ctx, swift, /\.keyboardShortcut\(|UIKeyCommand|CommandMenu|CommandGroup|\.commands\s*\{/) ? pass('Keyboard shortcuts are defined.') : ctx.stack.mac ? gap('A Mac app with no keyboard shortcuts or menu commands.') : review('No keyboard shortcuts: worth adding if the app runs on iPad with a keyboard.')),
    },
  },

  // ---- Principles ----
  {
    id: 'hierarchy',
    area: 'Principles',
    title: 'Clear hierarchy',
    guidance: 'Each screen makes its primary content and action obvious; controls sit above or around content without competing with it.',
    slug: 'design-principles',
    platforms: ['apple', 'web'],
    ask: 'For each main screen: what is the one thing people come for, and is it the most prominent?',
  },
  {
    id: 'consistency',
    area: 'Principles',
    title: 'Consistent with the platform',
    guidance: 'Behave as people expect on each platform: standard gestures, placements and terms; adapt to iPhone, iPad and Mac conventions rather than one layout everywhere.',
    slug: 'design-principles',
    platforms: ['apple', 'web'],
    ask: 'Does anything work differently from the system apps for no good reason (gestures, placement of actions, terms)?',
  },
]

function accountCheck(ctx: Ctx, which: (p: string) => boolean): Outcome {
  const signUp = grep(ctx, which, /\b(signUp|createUser|createAccount|registerUser|createUserWithEmail)\b|"Sign Up"|"Create Account"|>\s*Sign up\s*</i)
  if (signUp.length === 0) return na('No account creation.')
  return has(ctx, which, /delete\s*account|deleteAccount|deleteUser|close\s*account|"Delete Account"/i) ? pass('Accounts can be deleted.') : gap('Accounts can be created but not deleted in the app.', signUp.slice(0, 5))
}

export function ruleById(id: string): Rule | undefined {
  return RULES.find(r => r.id === id)
}

export function url(rule: Rule): string {
  return `${HIG}${rule.slug}`
}
