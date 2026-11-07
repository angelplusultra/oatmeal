#!/usr/bin/env node
// Prepares native pieces that are not npm packages:
//   1. resources/moonshine/<platform>/ — the native Moonshine library + ONNX Runtime, extracted from the
//      official moonshine-voice wheel on PyPI (MIT). Checked against PyPI's published SHA-256.
//   2. resources/bin/oatmeal-audio — the macOS audio helper, built from native/macos with SwiftPM.
// Idempotent: skips work whose outputs are already up to date.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MOONSHINE_VERSION = '0.1.6'
const platformKey = `${process.platform}-${process.arch}`

// Which wheel holds the native library for each platform, and which files we need from it.
const WHEELS = {
  'darwin-arm64': { tag: 'macosx_15_0_arm64', files: ['libmoonshine.dylib', 'libonnxruntime.1.23.2.dylib'] },
  'win32-x64': { tag: 'win_amd64', files: ['moonshine.dll', 'onnxruntime.dll'] },
  'linux-x64': { tag: 'manylinux_2_34_x86_64', files: ['libmoonshine.so', 'libonnxruntime.so.1.23.2'] },
  'linux-arm64': { tag: 'manylinux_2_34_aarch64', files: ['libmoonshine.so', 'libonnxruntime.so.1.23.2'] },
}

function log(msg) {
  console.log(`[setup] ${msg}`)
}

async function fetchMoonshine() {
  const wheel = WHEELS[platformKey]
  if (!wheel) {
    log(`no prebuilt Moonshine library for ${platformKey}; transcription will not work on this platform yet`)
    return
  }
  const dest = path.join(root, 'resources', 'moonshine', platformKey)
  const stamp = path.join(dest, '.version')
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === MOONSHINE_VERSION) return

  log(`fetching moonshine-voice ${MOONSHINE_VERSION} (${wheel.tag}) from PyPI`)
  const meta = await (await fetch(`https://pypi.org/pypi/moonshine-voice/${MOONSHINE_VERSION}/json`)).json()
  const file = meta.urls.find((u) => u.filename.includes(wheel.tag))
  if (!file) throw new Error(`no wheel for ${wheel.tag} in moonshine-voice ${MOONSHINE_VERSION}`)
  const res = await fetch(file.url)
  if (!res.ok) throw new Error(`download failed: ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (sha !== file.digests.sha256) throw new Error(`checksum mismatch for ${file.filename}`)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oatmeal-moonshine-'))
  try {
    const wheelPath = path.join(tmp, file.filename)
    fs.writeFileSync(wheelPath, bytes)
    // Wheels are zip files; bsdtar (macOS, Windows 10+) and most Linux tars can read them.
    execFileSync('tar', ['-xf', wheelPath, '-C', tmp], { stdio: 'inherit' })
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(dest, { recursive: true })
    for (const name of wheel.files) {
      const src = path.join(tmp, 'moonshine_voice', name)
      if (!fs.existsSync(src)) throw new Error(`${name} not found in wheel`)
      fs.copyFileSync(src, path.join(dest, name))
    }
    const license = path.join(tmp, `moonshine_voice-${MOONSHINE_VERSION}.dist-info`, 'licenses', 'LICENSE')
    if (fs.existsSync(license)) fs.copyFileSync(license, path.join(dest, 'LICENSE'))
    fs.writeFileSync(stamp, MOONSHINE_VERSION)
    log(`moonshine native library ready in ${path.relative(root, dest)}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function newestMtime(dir) {
  let newest = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) newest = Math.max(newest, fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs)
  }
  return newest
}

function buildHelper() {
  if (process.platform !== 'darwin') return
  const pkg = path.join(root, 'native', 'macos', 'OatmealAudio')
  const out = path.join(root, 'resources', 'bin', 'oatmeal-audio')
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= newestMtime(path.join(pkg, 'Sources'))) return
  log('building oatmeal-audio (SwiftPM)')
  execFileSync('swift', ['build', '-c', 'release', '--arch', 'arm64', '--package-path', pkg], { stdio: 'inherit' })
  const binPath = execFileSync('swift', ['build', '-c', 'release', '--arch', 'arm64', '--package-path', pkg, '--show-bin-path'])
    .toString()
    .trim()
  fs.mkdirSync(path.dirname(out), { recursive: true })
  // Remove first: overwriting a signed binary in place keeps the kernel's cached code signature for that
  // inode, and macOS then kills the new binary on launch (exit 137).
  fs.rmSync(out, { force: true })
  fs.copyFileSync(path.join(binPath, 'oatmeal-audio'), out)
  fs.chmodSync(out, 0o755)
  log(`helper ready in ${path.relative(root, out)}`)
}

await fetchMoonshine()
buildHelper()
