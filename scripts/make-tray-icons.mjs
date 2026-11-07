#!/usr/bin/env node
// Generates the menu bar icons as PNGs (no image tooling needed): an outline ring for idle (a macOS
// template image, tinted by the system) and a red dot for recording. Output: resources/tray/.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'tray')
fs.mkdirSync(out, { recursive: true })

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size)
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Coverage of a pixel by a ring/disc, with 4x4 supersampling for smooth edges.
function coverage(x, y, size, inner, outer) {
  let hits = 0
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      const dx = x - 0.5 + (i + 0.5) / 4 - size / 2
      const dy = y - 0.5 + (j + 0.5) / 4 - size / 2
      const d = Math.hypot(dx, dy) / (size / 2)
      if (d <= outer && d >= inner) hits++
    }
  return hits / 16
}

const ring = (x, y, size) => [0, 0, 0, Math.round(255 * coverage(x, y, size, 0.5, 0.82))]
const dot = (x, y, size) => {
  const a = Math.max(coverage(x, y, size, 0, 0.5), coverage(x, y, size, 0.66, 0.86) * 0.9)
  return [235, 64, 52, Math.round(255 * a)]
}

for (const [name, fn] of [
  ['trayTemplate', ring],
  ['recording', dot],
]) {
  fs.writeFileSync(path.join(out, `${name}.png`), png(16, fn))
  fs.writeFileSync(path.join(out, `${name}@2x.png`), png(32, fn))
}
console.log(`wrote tray icons to ${out}`)
