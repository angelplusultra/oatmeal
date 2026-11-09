/**
 * Omarchy theme support: turns the desktop's `~/.local/state/omarchy/current/theme/colors.toml` into Oatmeal's
 * CSS color tokens (the ones `globals.css` defines for Pantry), so the app follows `omarchy theme set` live.
 */

/** What main sends the renderer: whether to use the `.dark` variant, and the CSS variables to override. */
export interface OmarchyTheme {
  dark: boolean
  /** Page color, for the BrowserWindow before it paints. */
  background: string
  tokens: Record<string, string>
}

/**
 * Reads the flat `key = "#rrggbb"` lines of colors.toml. Only hex colors are kept: the values end up in CSS, and
 * a theme is someone else's file. `mode` is kept too.
 */
export function parseColors(toml: string): Record<string, string> {
  const colors: Record<string, string> = {}
  for (const [, key, value] of toml.matchAll(/^\s*([a-z0-9_]+)\s*=\s*["']([^"']*)["']/gim)) {
    if (/^#[0-9a-f]{6}$/i.test(value) || (key === 'mode' && /^(dark|light)$/.test(value))) colors[key] = value
  }
  return colors
}

/** WCAG relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const mix = (a: string, percent: number, b: string) => `color-mix(in oklab, ${a} ${percent}%, ${b})`

/**
 * Maps a theme onto Oatmeal's tokens, or null when it lacks the three colors every Omarchy theme has. Both
 * colors.toml formats work: the current one (`mode`, `red`, `dark_background`, …) and the older terminal-style
 * one (`color0`–`color15`, `selection_background`, no `mode`). Everything else is mixed from background,
 * foreground and accent, since the optional shades vary a lot between themes.
 */
export function omarchyTheme(colors: Record<string, string>, rounding?: number): OmarchyTheme | null {
  const { background: bg, foreground: fg, accent } = colors
  if (!bg || !fg || !accent) return null
  const dark = colors.mode ? colors.mode === 'dark' : luminance(bg) < 0.2
  const pick = (name: string, ansi: number) => colors[name] ?? colors[`color${ansi}`] ?? accent
  const red = pick('red', 1)
  const green = pick('green', 2)
  const yellow = pick('yellow', 3)
  const blue = pick('blue', 4)
  const magenta = pick('magenta', 5)
  const cyan = pick('cyan', 6)
  // Text on an accent fill: whichever of the theme's two text colors reads better on it.
  const onAccent = contrast(accent, bg) >= contrast(accent, fg) ? bg : fg
  const card = dark ? mix(bg, 95, fg) : mix(bg, 50, '#ffffff')
  const sidebar = colors.dark_background ?? mix(bg, 94, dark ? '#000000' : fg)
  const hover = colors.selection ?? colors.selection_background ?? mix(fg, 12, bg)
  const subtle = mix(fg, 8, bg)
  const border = mix(fg, 12, 'transparent')

  const tokens: Record<string, string> = {
    background: bg,
    foreground: fg,
    card,
    'card-foreground': fg,
    popover: card,
    'popover-foreground': fg,
    primary: accent,
    'primary-foreground': onAccent,
    secondary: subtle,
    'secondary-foreground': fg,
    muted: subtle,
    'muted-foreground': mix(fg, 65, bg),
    accent: hover,
    'accent-foreground': fg,
    destructive: red,
    border,
    input: mix(fg, 16, 'transparent'),
    ring: accent,
    sidebar,
    'sidebar-foreground': fg,
    'sidebar-primary': accent,
    'sidebar-primary-foreground': onAccent,
    'sidebar-accent': hover,
    'sidebar-accent-foreground': fg,
    'sidebar-border': border,
    'sidebar-ring': accent,
    brand: accent,
    'brand-foreground': onAccent,
    'brand-soft': mix(accent, 18, bg),
    'brand-text': accent,
    'app-icon': accent,
    'app-icon-foreground': onAccent,
    live: red,
    'live-soft': mix(red, 18, bg),
    faint: mix(fg, 35, bg),
    track: mix(fg, 12, bg),
    'card-shadow': 'none',
    'chart-1': accent,
    'chart-2': green,
    'chart-3': red,
    'chart-4': blue,
    'chart-5': magenta,
    'speaker-1': green,
    'speaker-2': red,
    'speaker-3': blue,
    'speaker-4': magenta,
    'speaker-5': cyan,
    'speaker-6': yellow,
  }
  // Corners follow Hyprland's window rounding: sharp on Omarchy's default of 0.
  // ponytail: capped at Pantry's 10px, since the scale goes up to 2.6× for large surfaces.
  if (rounding !== undefined) tokens.radius = `${Math.min(rounding, 10)}px`
  return { dark, background: bg, tokens }
}
