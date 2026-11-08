import { describe, expect, it } from 'vitest'
import { parseAudioStreams } from './pulse'

const proc = (pid: number, binary: string) => ({ 'application.process.id': String(pid), 'application.process.binary': binary, 'application.name': binary })

describe('parseAudioStreams', () => {
  it('merges input and output per process, skipping corked streams and monitor recordings', () => {
    const sources = [
      { index: 61, properties: { 'device.class': 'monitor' } },
      { index: 63, properties: { 'device.class': 'sound' } },
    ]
    const clients = [{ index: 7, properties: proc(300, 'pw-record') }]
    const result = parseAudioStreams(
      [
        { index: 1, corked: false, properties: proc(100, 'chromium') },
        { index: 2, corked: true, properties: proc(200, 'spotify') },
      ],
      [
        { index: 3, source: 63, corked: false, properties: proc(100, 'chromium') },
        // Native PipeWire stream: process info only on the client.
        { index: 4, source: 63, client: '7', corked: false, properties: {} },
        // Screen-share audio from the sink monitor isn't mic use.
        { index: 5, source: 61, corked: false, properties: proc(400, 'obs') },
      ],
      sources,
      clients,
    )
    expect(result).toEqual([
      { pid: 100, bundleId: 'chromium', name: 'chromium', input: true, output: true },
      { pid: 300, bundleId: 'pw-record', name: 'pw-record', input: true, output: false },
    ])
  })
})
