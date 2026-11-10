/** Passed by the Linux autostart entry so a login launch stays in the tray (macOS uses `wasOpenedAtLogin`). */
export const HIDDEN_FLAG = '--hidden'

/**
 * Quotes one Exec= argument per the Desktop Entry spec: wrap in double quotes, backslash-escape `"`, `` ` ``,
 * `$` and `\` inside them, then escape backslashes again because Exec is a string value. `%` becomes `%%`.
 */
export function quoteExecArg(arg: string): string {
  return `"${arg.replace(/[\\"`$]/g, '\\$&')}"`.replace(/\\/g, '\\\\').replace(/%/g, '%%')
}

/** XDG autostart entry (`~/.config/autostart/oatmeal.desktop`) that launches `execPath` hidden. */
export function autostartDesktopEntry(execPath: string): string {
  return `[Desktop Entry]
Type=Application
Name=Oatmeal
Exec=${quoteExecArg(execPath)} ${HIDDEN_FLAG}
Terminal=false
`
}
