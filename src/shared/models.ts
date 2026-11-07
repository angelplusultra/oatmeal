import type { AsrModelId, LlmModelId, Settings } from './types'

export interface AsrModelInfo {
  id: AsrModelId
  name: string
  /** MOONSHINE_MODEL_ARCH_* value. */
  arch: number
  approxBytes: number
  description: string
}

export const ASR_MODELS: AsrModelInfo[] = [
  {
    id: 'medium',
    name: 'Moonshine Medium (English)',
    arch: 5,
    approxBytes: 305e6,
    description: 'Most accurate (6.65% WER). Recommended on Apple Silicon Pro/Max chips.',
  },
  {
    id: 'small',
    name: 'Moonshine Small (English)',
    arch: 4,
    approxBytes: 160e6,
    description: 'Lighter on CPU (7.84% WER). Good for MacBook Air and older Macs.',
  },
]

export interface LlmModelInfo {
  id: LlmModelId
  name: string
  /** node-llama-cpp model URI. */
  uri: string
  fileName: string
  sizeBytes: number
  minRamGB: number
  description: string
}

export const LLM_MODELS: LlmModelInfo[] = [
  {
    id: 'gemma-4-e2b',
    name: 'Gemma 4 E2B',
    uri: 'hf:unsloth/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_K_M.gguf',
    fileName: 'gemma-4-E2B-it-Q4_K_M.gguf',
    sizeBytes: 3.11e9,
    minRamGB: 8,
    description: 'Smallest and fastest. Notes are less thorough.',
  },
  {
    id: 'gemma-4-e4b',
    name: 'Gemma 4 E4B',
    uri: 'hf:unsloth/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf',
    fileName: 'gemma-4-E4B-it-Q4_K_M.gguf',
    sizeBytes: 4.98e9,
    minRamGB: 16,
    description: 'Recommended. Good notes on a 16 GB Mac.',
  },
  {
    id: 'gemma-4-26b-a4b',
    name: 'Gemma 4 26B A4B',
    uri: 'hf:unsloth/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_M.gguf',
    fileName: 'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf',
    sizeBytes: 16.95e9,
    minRamGB: 32,
    description: 'Best quality. Needs 32 GB+ of memory and a 17 GB download.',
  },
]

export function asrModel(id: AsrModelId): AsrModelInfo {
  return ASR_MODELS.find((m) => m.id === id) ?? ASR_MODELS[0]
}

export function llmModel(id: LlmModelId): LlmModelInfo {
  return LLM_MODELS.find((m) => m.id === id) ?? LLM_MODELS[1]
}

export function defaultSettings(machine: { cpuCount: number; totalMemGB: number }): Settings {
  return {
    detectionEnabled: true,
    autoStopSeconds: 30,
    ignoredApps: [],
    asrModel: machine.cpuCount >= 10 ? 'medium' : 'small',
    separateSpeakers: true,
    llmProvider: 'local',
    localModel: machine.totalMemGB < 12 ? 'gemma-4-e2b' : 'gemma-4-e4b',
    endpointUrl: 'http://localhost:11434/v1',
    endpointModel: '',
    endpointApiKey: '',
  }
}

/**
 * Meeting apps we offer to transcribe for, matched by bundle-id prefix. Helper processes inherit the
 * prefix (e.g. `com.google.Chrome.helper`). Browsers are included because Meet, Teams-web, Zoom-web etc.
 * run there; we can't tell which tab is using the mic without extra permissions.
 */
export const MEETING_APPS: { prefix: string; name: string; browser?: boolean }[] = [
  { prefix: 'us.zoom.', name: 'Zoom' },
  { prefix: 'com.microsoft.teams', name: 'Microsoft Teams' },
  { prefix: 'com.tinyspeck.slackmacgap', name: 'Slack' },
  { prefix: 'com.hnc.Discord', name: 'Discord' },
  { prefix: 'com.apple.FaceTime', name: 'FaceTime' },
  { prefix: 'com.cisco.webex', name: 'Webex' },
  { prefix: 'Cisco-Systems.Spark', name: 'Webex' },
  { prefix: 'net.whatsapp.WhatsApp', name: 'WhatsApp' },
  { prefix: 'com.google.Chrome', name: 'Google Chrome', browser: true },
  { prefix: 'company.thebrowser.Browser', name: 'Arc', browser: true },
  { prefix: 'com.apple.Safari', name: 'Safari', browser: true },
  { prefix: 'com.apple.WebKit.GPU', name: 'Safari', browser: true },
  { prefix: 'com.microsoft.edgemac', name: 'Microsoft Edge', browser: true },
  { prefix: 'org.mozilla.firefox', name: 'Firefox', browser: true },
  { prefix: 'com.brave.Browser', name: 'Brave', browser: true },
  { prefix: 'com.vivaldi.Vivaldi', name: 'Vivaldi', browser: true },
  { prefix: 'com.operasoftware.Opera', name: 'Opera', browser: true },
]

export function matchMeetingApp(bundleId: string): { name: string; browser: boolean } | null {
  const hit = MEETING_APPS.find((a) => bundleId.startsWith(a.prefix))
  return hit ? { name: hit.name, browser: !!hit.browser } : null
}
