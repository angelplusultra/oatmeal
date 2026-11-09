// Renders the committed icon PNGs from their SVG sources with Electron's Chromium, so no image
// tooling is needed. Run with `npm run make-icons`.
//   assets/icon.svg -> build/icon.png (1024px; electron-builder makes the .icns from it)
//   assets/tray.svg -> resources/tray/trayTemplate(@2x).png, black, used as a macOS template image
//                      resources/tray/recording(@2x).png, red, shown while recording

import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'

const root = path.resolve(import.meta.dirname, '..')
const RECORDING_RED = '#FF3B30' // macOS systemRed

app.dock?.hide()
// No top-level await: in an ESM main script it holds back the ready event and the app hangs.
app
  .whenReady()
  .then(main)
  .catch((err) => {
    console.error(err)
    app.exit(1)
  })

async function main() {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('data:text/html,')

  const render = async (svg, size, out) => {
    const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `)
    const url = `data:image/svg+xml;base64,${Buffer.from(sized).toString('base64')}`
    const png = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image()
      img.src = ${JSON.stringify(url)}
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = ${size}
      canvas.getContext('2d').drawImage(img, 0, 0, ${size}, ${size})
      return canvas.toDataURL('image/png')
    })()`)
    fs.writeFileSync(path.join(root, out), Buffer.from(png.split(',')[1], 'base64'))
    console.log(`wrote ${out}`)
  }

  await render(fs.readFileSync(path.join(root, 'assets/icon.svg'), 'utf8'), 1024, 'build/icon.png')

  // The glyph draws in currentColor, so setting `color` on the root recolors it.
  const tray = fs.readFileSync(path.join(root, 'assets/tray.svg'), 'utf8')
  for (const [name, color] of [
    ['trayTemplate', '#000'],
    ['recording', RECORDING_RED],
  ]) {
    const svg = tray.replace('<svg ', `<svg color="${color}" `)
    await render(svg, 18, `resources/tray/${name}.png`)
    await render(svg, 36, `resources/tray/${name}@2x.png`)
  }
  app.exit(0)
}
