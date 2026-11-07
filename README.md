<img src="assets/icon.svg" width="64" height="64" alt="">

# Oatmeal

A small, private meeting-notes app for macOS. When you join a call in Zoom, Meet, Teams, Slack, Discord or FaceTime, Oatmeal offers to transcribe it. When the call ends, it writes notes: a summary, decisions, action items and open questions.

Everything runs on your Mac: speech-to-text with [Moonshine](https://github.com/moonshine-ai/moonshine), notes with [Gemma 4](https://ai.google.dev/gemma) through [llama.cpp](https://github.com/ggml-org/llama.cpp). Audio is never saved, and nothing is uploaded. Oatmeal only goes online to download models.

> **Status:** early. The full pipeline works end to end. Live capture from a real call still needs testing on more setups.

## Features

- **Call detection.** Notices when a meeting app starts using the microphone and shows a small "Transcribe this call?" panel. Recording runs in the background, with a red menu-bar icon and no windows. It stops about 2 seconds after the app releases the mic and goes quiet. If you're only muted, it keeps recording.
- **Notes ready.** When the notes are written, the same panel offers **View notes** or **Dismiss**. Nothing opens until you ask.
- **Two-channel transcription.** Your microphone is "You". Everyone else comes from system audio and can be split into Speaker 1, Speaker 2… Click a name to rename it.
- **Notes.** Map-reduce summarization with grammar-constrained JSON. Every decision and action item links back to the moment it was said.
- **Your data.** Raw transcripts are viewable and exportable as .txt, .md or .json, and searchable. Notes copy or export as Markdown.

## Requirements

- macOS 15 or later on Apple Silicon
- Node.js 22.12+ and npm
- Xcode Command Line Tools (Swift 5.9+), to build the audio helper

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` first runs `npm run setup`, which:

1. downloads the native Moonshine library from the official `moonshine-voice` wheel on PyPI (checksum-verified) into `resources/moonshine/`
2. builds the Swift audio helper into `resources/bin/oatmeal-audio`

In the app, open **Settings** to download the speech model (~280 MB) and the notes model (Gemma 4 E4B, 5 GB, or E2B / 26B-A4B). Then allow the two permissions.

**Permissions in development.** macOS gives microphone and system-audio access to whatever launched Electron, so run `npm run dev` from an app that declares both permissions in its Info.plist (`NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription`). T3 Code, VS Code and Cursor do. Ghostty only declares the microphone, so system audio comes through silent. Terminal.app declares neither. Use **Settings → Permissions → Allow**, and macOS will ask on behalf of that app.

To see the real permission flow, with "Oatmeal" in the dialogs, build the app and run it from Finder:

```bash
npm run dist:mac:local   # ad-hoc signed app in dist/mac-arm64/Oatmeal.app
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run with hot reload |
| `npm run build` | Build main, workers, preload and renderer into `out/` |
| `npm test` | Unit tests (transcript shaping, echo filtering, summarization pipeline, storage) |
| `npm run typecheck` | Type-check all code |
| `npm run dist:mac:local` | Package an ad-hoc signed `.app` for local use |
| `npm run dist:mac` | Package a signed `.dmg` + `.zip` (needs a Developer ID certificate) |
| `npm run make-test-meeting -- <dir>` | Generate a synthetic two-channel meeting with macOS voices |

### End-to-end testing without a real call

```bash
npm run build
npm run make-test-meeting -- /tmp/meeting
OATMEAL_USER_DATA=/tmp/oatmeal-test OATMEAL_SETUP=asr OATMEAL_AUTOSTART=1 \
OATMEAL_FAKE_AUDIO="mic=/tmp/meeting/mic.wav,system=/tmp/meeting/system.wav,speed=1.5" \
OATMEAL_SCREENSHOT_DIR=/tmp/oatmeal-shots OATMEAL_EXIT_AFTER_NOTES=1 \
npx electron .
```

This plays the WAV files as the two capture channels, transcribes them, writes notes, saves screenshots and quits. Other hooks are documented in `src/main/dev.ts` (e.g. `OATMEAL_LLM_MODEL_PATH` to use an existing GGUF, `OATMEAL_DEMO_PROMPT=1` to show the call prompt).

## How it works

```
oatmeal-audio (Swift)  ──PCM──▶  ASR utility process  ──lines──▶  main process  ──▶  React UI
  • mic users (detect)            libmoonshine via koffi             SQLite (node:sqlite + FTS5)
  • mic + system tap (capture)    one stream per channel             meeting state machine
                                                                     │
                                  LLM utility process  ◀──transcript─┘
                                  node-llama-cpp (Metal), map → verify → reduce
```

- **`native/macos/OatmealAudio`**: a Swift CLI. `detect` polls Core Audio's per-process objects to see which apps are capturing the mic. `capture` records the mic (AVAudioEngine) and system audio through a Core Audio process tap (macOS 14.2+; needs no Screen Recording permission) as 16 kHz PCM.
- **`src/workers/asr`**: native Moonshine through FFI. Partial-line decoding is off, and speaker separation runs only on the system channel, at a coarser cadence to save CPU.
- **`src/shared/summarize.ts`**: the notes pipeline. It splits the transcript into ~6K-token chunks, extracts structured notes per chunk, drops items whose timestamps fall outside their chunk, then merges everything into the final notes.
- **`src/main/orchestrator.ts`**: ties detection, prompting, recording, echo filtering, storage and the notes queue together.

## Credits and licenses

Oatmeal is MIT licensed. It builds on:

- [Moonshine Voice](https://github.com/moonshine-ai/moonshine) (MIT): speech-to-text
- [pyannote speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) (CC-BY-4.0), via Moonshine; PLDA by BUT Speech@FIT
- [Gemma 4](https://ai.google.dev/gemma) (Apache 2.0): notes model, downloaded at runtime
- [llama.cpp](https://github.com/ggml-org/llama.cpp) and [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) (MIT)
- [koffi](https://koffi.dev) (MIT), [Electron](https://www.electronjs.org) (MIT), [shadcn/ui](https://ui.shadcn.com) (MIT)
