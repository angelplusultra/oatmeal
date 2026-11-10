import { describe, expect, it } from 'vitest'
import { autostartDesktopEntry, launcherDesktopEntry, quoteExecArg } from './autostart'

describe('launcher entry', () => {
  it('opens the AppImage with its icon', () => {
    const entry = launcherDesktopEntry(
      '/home/me/Applications/Oatmeal.AppImage',
      '/home/me/.local/share/icons/oatmeal.png',
    )
    expect(entry).toContain('\nExec="/home/me/Applications/Oatmeal.AppImage" %U\n')
    expect(entry).toContain('\nIcon=/home/me/.local/share/icons/oatmeal.png\n')
    expect(entry).not.toContain('--hidden')
  })
})

describe('autostart entry', () => {
  it('launches the given path hidden', () => {
    expect(autostartDesktopEntry('/opt/Oatmeal/oatmeal')).toContain('\nExec="/opt/Oatmeal/oatmeal" --hidden\n')
  })

  it('quotes paths per the Desktop Entry spec', () => {
    expect(quoteExecArg('/home/me/My Apps/Oatmeal.AppImage')).toBe('"/home/me/My Apps/Oatmeal.AppImage"')
    // `$` → `\$` inside quotes, then the backslash is escaped again for the string value.
    expect(quoteExecArg('/a$b')).toBe('"/a\\\\$b"')
    expect(quoteExecArg('/a"b')).toBe('"/a\\\\"b"')
    expect(quoteExecArg('/a\\b')).toBe('"/a\\\\\\\\b"')
    expect(quoteExecArg('/100%')).toBe('"/100%%"')
  })
})
