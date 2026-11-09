import { describe, expect, it } from 'vitest'
import { autostartDesktopEntry, quoteExecArg } from './autostart'

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
