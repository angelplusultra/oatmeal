import type { OmarchyTheme } from '@shared/omarchy'

/**
 * Follows the desktop: the Omarchy theme's colors when there is one (Linux), otherwise Pantry in the system's
 * light/dark appearance. Omarchy colors go on <html> inline, so they win over both Pantry variants.
 */
export function followSystemTheme() {
  const root = document.documentElement
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  let omarchy: OmarchyTheme | null = null
  let applied: string[] = []
  const apply = () => {
    root.classList.toggle('dark', omarchy ? omarchy.dark : media.matches)
    for (const name of applied) root.style.removeProperty(`--${name}`)
    applied = Object.keys(omarchy?.tokens ?? {})
    for (const name of applied) root.style.setProperty(`--${name}`, omarchy!.tokens[name])
  }
  const setOmarchy = (theme: OmarchyTheme | null) => {
    omarchy = theme
    apply()
  }
  apply()
  media.addEventListener('change', apply)
  void window.oatmeal.getOmarchyTheme().then(setOmarchy)
  window.oatmeal.on('omarchy-theme', setOmarchy)
}
