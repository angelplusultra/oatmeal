/**
 * Linux stand-in for `oatmeal-audio detect`: which processes are recording from a mic and which are
 * playing audio, read from PipeWire through its PulseAudio interface (`pactl`).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DetectedApp } from '@shared/types'

export interface AudioProcess extends DetectedApp {
  input: boolean
  output: boolean
}

interface PaObject {
  index: number
  client?: string
  source?: number
  corked?: boolean
  properties: Record<string, string>
}

/**
 * Turns `pactl -f json list` output into one entry per process. `bundleId` is the executable name, which
 * MEETING_APPS matches on Linux. Streams recording from a monitor (screen-share audio, our own system
 * capture) don't count as using the mic. Native PipeWire streams keep process info on their client only.
 */
export function parseAudioStreams(
  sinkInputs: PaObject[],
  sourceOutputs: PaObject[],
  sources: PaObject[],
  clients: PaObject[],
): AudioProcess[] {
  const monitors = new Set(sources.filter((s) => s.properties['device.class'] === 'monitor').map((s) => s.index))
  const clientProps = new Map(clients.map((c) => [String(c.index), c.properties]))
  const byPid = new Map<number, AudioProcess>()
  const add = (stream: PaObject, kind: 'input' | 'output') => {
    if (stream.corked) return
    const props = { ...clientProps.get(String(stream.client)), ...stream.properties }
    const pid = Number(props['application.process.id'])
    const binary = props['application.process.binary']
    if (!pid || !binary) return
    const entry = byPid.get(pid) ?? {
      pid,
      bundleId: binary,
      name: props['application.name'] ?? binary,
      input: false,
      output: false,
    }
    entry[kind] = true
    byPid.set(pid, entry)
  }
  for (const s of sinkInputs) add(s, 'output')
  for (const s of sourceOutputs) if (!monitors.has(s.source ?? -1)) add(s, 'input')
  return [...byPid.values()]
}

const run = promisify(execFile)

export async function listAudioProcesses(): Promise<AudioProcess[]> {
  const list = async (what: string) =>
    JSON.parse((await run('pactl', ['-f', 'json', 'list', what], { maxBuffer: 16 << 20 })).stdout) as PaObject[]
  const [sinkInputs, sourceOutputs, sources, clients] = await Promise.all(
    ['sink-inputs', 'source-outputs', 'sources', 'clients'].map(list),
  )
  return parseAudioStreams(sinkInputs, sourceOutputs, sources, clients)
}
