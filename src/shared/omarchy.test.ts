import { describe, expect, it } from 'vitest'
import { omarchyTheme, parseColors } from './omarchy'

describe('omarchy theme', () => {
  it('maps the current colors.toml format', () => {
    const colors = parseColors(`mode = "dark"

accent = "#7aa2f7"
background = "#1a1b26"   # page
foreground = "#a9b1d6"
dark_background = "#13141c"
red = "#f7768e"
`)
    const theme = omarchyTheme(colors, 0)!
    expect(theme.dark).toBe(true)
    expect(theme.background).toBe('#1a1b26')
    expect(theme.tokens).toMatchObject({
      primary: '#7aa2f7',
      'primary-foreground': '#1a1b26', // dark text reads better on this light accent
      sidebar: '#13141c',
      destructive: '#f7768e',
      radius: '0px',
    })
  })

  it('reads older terminal-style themes, inferring light mode from the background', () => {
    const theme = omarchyTheme(
      parseColors(`accent = '#1e66f5'\nbackground = '#eff1f5'\nforeground = '#4c4f69'\ncolor1 = '#d20f39'`),
    )!
    expect(theme.dark).toBe(false)
    expect(theme.tokens.live).toBe('#d20f39')
    expect(theme.tokens.radius).toBeUndefined()
  })

  it('drops anything that is not a hex color, and needs the three base colors', () => {
    const colors = parseColors(`background = "#000000"\nforeground = "url(http://x)"\naccent = "#ffffff"`)
    expect(colors).toEqual({ background: '#000000', accent: '#ffffff' })
    expect(omarchyTheme(colors)).toBeNull()
  })
})
