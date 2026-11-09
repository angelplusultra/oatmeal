import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type OmarchyTheme, omarchyTheme, parseColors } from '@shared/omarchy'

const CURRENT = path.join(os.homedir(), '.local/state/omarchy/current')

/**
 * Follows the Omarchy desktop theme. `omarchy theme set` replaces `current/theme` with a fresh directory and
 * then rewrites `current/theme.generation`, so watching `current` (which stays put) sees every switch. Does
 * nothing off Omarchy, and `current()` stays null.
 */
export class OmarchyThemeWatcher {
  private theme: OmarchyTheme | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly onChange: (theme: OmarchyTheme) => void) {
    if (process.platform !== 'linux' || process.env.OATMEAL_NO_OMARCHY_THEME || !fs.existsSync(CURRENT)) return
    this.theme = this.read(undefined)
    fs.watch(CURRENT, () => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => void this.reload(), 150)
    }).on('error', (error) => console.warn('[omarchy] theme watch stopped:', error.message))
    void this.reload() // picks up Hyprland's rounding
  }

  current(): OmarchyTheme | null {
    return this.theme
  }

  private read(rounding: number | undefined): OmarchyTheme | null {
    try {
      return omarchyTheme(parseColors(fs.readFileSync(path.join(CURRENT, 'theme/colors.toml'), 'utf8')), rounding)
    } catch {
      return null // mid-switch, or a theme without colors.toml: keep the current colors
    }
  }

  // ponytail: rounding is only re-read on theme switches, so a hand edit to Hyprland's config shows on the next one.
  private async reload() {
    const theme = this.read(await hyprRounding())
    if (!theme || JSON.stringify(theme) === JSON.stringify(this.theme)) return
    this.theme = theme
    this.onChange(theme)
  }
}

function hyprRounding(): Promise<number | undefined> {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    execFile('hyprctl', ['getoption', 'decoration:rounding', '-j'], { timeout: 1000 }, (error, stdout) => {
      try {
        const value = JSON.parse(stdout).int
        resolve(!error && Number.isInteger(value) && value >= 0 ? value : undefined)
      } catch {
        resolve(undefined)
      }
    })
  })
}
