/** Follows the macOS light/dark appearance. */
export function followSystemTheme() {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = () => document.documentElement.classList.toggle('dark', media.matches)
  apply()
  media.addEventListener('change', apply)
}
