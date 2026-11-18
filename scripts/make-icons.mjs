// Renders the committed icon PNGs from their SVG sources with Electron's Chromium, so no image
// tooling is needed. Run with `npm run make-icons`.
//   assets/icon.svg -> build/icon.png (1024px; electron-builder makes the .icns from it)
//                      build/icon-dev.png, the same with a DEV banner, the Dock icon when running from source
//   assets/tray.svg -> resources/tray/trayTemplate(@2x).png, black, used as a macOS template image
//                      resources/tray/recording(@2x).png, red, shown while recording

import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'

const root = path.resolve(import.meta.dirname, '..')
const RECORDING_RED = '#FF3B30' // macOS systemRed
const DEV_BLUE = '#0066D6' // --color-dev in globals.css

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

  // `banner` draws a label in a pill across the bottom of the 1024px app icon.
  const render = async (svg, size, out, banner) => {
    const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `)
    const url = `data:image/svg+xml;base64,${Buffer.from(sized).toString('base64')}`
    const png = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image()
      img.src = ${JSON.stringify(url)}
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = ${size}
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, ${size}, ${size})
      const banner = ${JSON.stringify(banner ?? null)}
      if (banner) {
        ctx.beginPath()
        ctx.roundRect(232, 690, 560, 190, 95)
        ctx.fillStyle = ${JSON.stringify(DEV_BLUE)}
        ctx.fill()
        ctx.lineWidth = 14
        ctx.strokeStyle = '#ffffff'
        ctx.stroke()
        ctx.fillStyle = '#ffffff'
        ctx.font = '800 140px -apple-system, "Helvetica Neue", Arial, sans-serif'
        ctx.letterSpacing = '12px'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(banner, 518, 792)
      }
      return canvas.toDataURL('image/png')
    })()`)
    fs.writeFileSync(path.join(root, out), Buffer.from(png.split(',')[1], 'base64'))
    console.log(`wrote ${out}`)
  }

  const icon = fs.readFileSync(path.join(root, 'assets/icon.svg'), 'utf8')
  await render(icon, 1024, 'build/icon.png')
  await render(icon, 1024, 'build/icon-dev.png', 'DEV')

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
