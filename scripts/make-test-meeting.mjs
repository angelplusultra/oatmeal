#!/usr/bin/env node
// Generates a synthetic two-channel test meeting with macOS `say` voices, for end-to-end testing with
// OATMEAL_FAKE_AUDIO. "You" goes on the mic channel; two remote participants go on the system channel.
//   node scripts/make-test-meeting.mjs <outDir> [--short]
// Elsewhere it uses Piper (via uvx) and ffmpeg. Fetch the voices once into PIPER_VOICES:
//   cd <dir> && uvx --from piper-tts python -m piper.download_voices en_US-lessac-medium en_GB-alba-medium en_US-ryan-medium
//   PIPER_VOICES=<dir> node scripts/make-test-meeting.mjs <outDir>
// Output: <outDir>/mic.wav and <outDir>/system.wav (16 kHz mono 16-bit), same length, time-aligned.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const outDir = path.resolve(process.argv[2] ?? 'test-meeting')
const short = process.argv.includes('--short')
fs.mkdirSync(outDir, { recursive: true })

const VOICES =
  process.platform === 'darwin'
    ? { you: 'Samantha', priya: 'Karen', marcus: 'Daniel' }
    : { you: 'en_US-lessac-medium', priya: 'en_GB-alba-medium', marcus: 'en_US-ryan-medium' }
const CHANNEL = { you: 'mic', priya: 'system', marcus: 'system' }

// A "hop in, say a few words, leave" call.
const shortScript = [
  ['you', 'Hey Priya, quick one. Are we still on for the demo tomorrow at ten?'],
  ['priya', 'Yes, ten works. I will send the calendar invite tonight.'],
  ['you', 'Perfect, thanks!'],
]

const longScript = [
  [
    'you',
    'Hi both, thanks for joining. Today I want to cover the pricing change, the billing migration, and the hiring plan.',
  ],
  [
    'priya',
    'Sounds good. On pricing, the proposal is to raise the enterprise tier from forty to fifty dollars per seat starting in January.',
  ],
  ['marcus', 'My worry is existing customers. If we raise prices on them right away we will see churn.'],
  ['you', 'Agreed. What if we grandfather existing enterprise customers at the current price for twelve months?'],
  [
    'priya',
    'I like that. Okay, decision: existing enterprise customers keep the current price for twelve months, and new customers pay fifty dollars from January.',
  ],
  [
    'marcus',
    'Works for me. Next, billing. We still have to move from Stripe billing version one to version two before the end of January.',
  ],
  ['you', 'Marcus, can you own the migration plan and have a first draft by next Friday?'],
  ['marcus', 'Yes, I will have the migration plan draft ready by next Friday.'],
  [
    'priya',
    'One open question is whether the migration needs a maintenance window. Nobody has checked that with the support team yet.',
  ],
  ['you', 'Good point. Last topic is hiring. We want a second product designer this quarter.'],
  ['priya', 'Finance has not approved the budget yet. I will ask finance for the designer budget approval this week.'],
  ['marcus', 'And I can start drafting the job description once the budget is approved.'],
  [
    'you',
    'Great. To recap, pricing is decided, Marcus drafts the migration plan by Friday, and Priya talks to finance. Thanks everyone.',
  ],
]

const script = short ? shortScript : longScript
const RATE = 16000
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oatmeal-say-'))

function readPcm(file) {
  const buf = fs.readFileSync(file)
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'data') return buf.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk in ${file}`)
}

const tracks = { mic: [], system: [] }
let cursor = Math.round(RATE * 0.8)
script.forEach(([who, text], i) => {
  const file = path.join(tmp, `${i}.wav`)
  if (process.platform === 'darwin') {
    execFileSync('say', ['-v', VOICES[who], '-o', file, '--file-format=WAVE', `--data-format=LEI16@${RATE}`, text])
  } else {
    if (!process.env.PIPER_VOICES)
      throw new Error('set PIPER_VOICES to a directory of Piper voices (see the top of this file)')
    const raw = path.join(tmp, `${i}-piper.wav`)
    execFileSync(
      'uvx',
      ['--from', 'piper-tts', 'piper', '-m', path.join(process.env.PIPER_VOICES, `${VOICES[who]}.onnx`), '-f', raw],
      { input: text },
    )
    execFileSync('ffmpeg', [
      '-loglevel',
      'error',
      '-i',
      raw,
      '-ar',
      String(RATE),
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      file,
    ])
  }
  const pcm = readPcm(file)
  tracks[CHANNEL[who]].push({ at: cursor, pcm })
  cursor += pcm.length / 2 + Math.round(RATE * 0.9) // ~0.9 s pause between turns
})
const total = cursor + RATE

function writeWav(file, segments) {
  const data = Buffer.alloc(total * 2)
  for (const { at, pcm } of segments) pcm.copy(data, at * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([header, data]))
}

writeWav(path.join(outDir, 'mic.wav'), tracks.mic)
writeWav(path.join(outDir, 'system.wav'), tracks.system)
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`wrote ${outDir}/mic.wav and system.wav (${(total / RATE).toFixed(0)} s)`)
