# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Oatmeal is an Electron menu-bar app for macOS (15+, Apple Silicon) and Linux (developed on Omarchy: Hyprland + PipeWire). It detects calls, transcribes the mic and system audio on-device with Moonshine, and writes meeting notes with a local LLM (Gemma 4 via node-llama-cpp). Privacy is the product: audio is never written to disk, and nothing goes online except model downloads and the update check (`src/main/updater.ts`: electron-updater against this repo's GitHub Releases, off with `settings.autoUpdate`). The production renderer CSP blocks all network access. Keep it that way.

## Commands

```bash
npm run dev          # runs `setup` (fetch libmoonshine, build Swift helper), then electron-vite with HMR
npm run build        # setup + build main, workers, preload, renderer into out/
npm run typecheck    # tsc for tsconfig.node.json (main/preload/workers/shared) and tsconfig.web.json (renderer/shared)
npm run lint         # biome check (lint + format + import order); `npm run format` applies fixes
npm test             # vitest run (src/**/*.test.ts, node environment)
npx vitest run src/shared/summarize.test.ts        # one test file
npx vitest run -t "reuses a cached result"         # tests whose name matches
npm run dist:mac:local  # ad-hoc signed .app in dist/mac-arm64/ (needed to test real permission dialogs)
npm run dist:linux      # AppImage + Arch .pacman in dist/; dist:linux:dir for dist/linux-unpacked/
```

**Website.** `website/` is a standalone Astro site with its own `package.json` (not an npm workspace): `cd website && npm i && npm run dev`. It imports the icon and screenshots from `assets/` and `docs/screenshots/`, and `.github/workflows/website.yml` deploys it to GitHub Pages on pushes to main that touch those paths.

Biome (`biome.json`) lints and formats TS/JS/JSON/CSS; shadcn's generated `components/ui/` is excluded. Lint, typecheck and tests are the checks. `.github/workflows/ci.yml` runs all three on pushes to main and on PRs.

**Releases.** `package.json` `version` is the source of truth (semver; 0.x until the app is stable). `npm version patch|minor|major` (or `prerelease --preid beta`) commits, tags `vX.Y.Z` and pushes (`postversion`). The tag triggers `.github/workflows/release.yml`: it checks the tag matches `package.json`, builds the macOS (macos-15) and Linux (ubuntu) packages, and publishes a GitHub Release with generated notes; tags with a `-` suffix become pre-releases. The macOS app is ad-hoc signed unless the `CSC_LINK`/`CSC_KEY_PASSWORD` secrets are set, and notarized when `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` are too. Its `aur` job then pushes the `oatmeal-notes-bin` AUR package (`packaging/aur/PKGBUILD`, filled in by `packaging/aur/publish.sh`), and is skipped until the `AUR_SSH_PRIVATE_KEY` secret exists. The AUR package repackages the release's `.pacman` and installs the command as `oatmeal-notes`, because the unrelated AUR package `oatmeal-bin` owns `/usr/bin/oatmeal` and provides `oatmeal`. Never list `oatmeal` in its conflicts. To check a release locally on Arch, run `packaging/aur/publish.sh <version>`, then `makepkg` in the directory it prints.

`npm run setup` (`scripts/setup.mjs`) is idempotent. It puts `libmoonshine` + ONNX Runtime from the PyPI wheel (SHA-256 checked) into `resources/moonshine/<platform>/` (on Linux it needs `bsdtar`, since GNU tar can't read zips), and on macOS rebuilds `resources/bin/oatmeal-audio` with SwiftPM whenever `native/macos/OatmealAudio/Sources` is newer than the binary. Both outputs are gitignored. The app icon (`build/icon.png`) and the tray PNGs (`resources/tray/`) are committed. `npm run make-icons` renders them from `assets/icon.svg` and `assets/tray.svg`.

Dev scripts that need a real GGUF and a recorded meeting DB: `npx tsx scripts/eval-map.ts <oatmeal.db> <model.gguf> [runs]` and `npx tsx scripts/eval-notes.ts <oatmeal.db> <model.gguf> [maxSegments]`.

### End-to-end without a real call

```bash
npm run build && npm run make-test-meeting -- /tmp/meeting
OATMEAL_USER_DATA=/tmp/oatmeal-test OATMEAL_SETUP=asr OATMEAL_AUTOSTART=1 \
OATMEAL_FAKE_AUDIO="mic=/tmp/meeting/mic.wav,system=/tmp/meeting/system.wav,speed=1.5" \
OATMEAL_SCREENSHOT_DIR=/tmp/oatmeal-shots OATMEAL_EXIT_AFTER_NOTES=1 npx electron .
```

This plays WAVs as the two capture channels, transcribes, writes notes, saves screenshots and quits. `src/main/dev.ts` lists every `OATMEAL_*` hook. For example, `OATMEAL_LLM_MODEL_PATH` reuses an existing GGUF, and `OATMEAL_DEMO_PROMPT=1|accept` fakes Zoom taking the mic.

On Linux, `make-test-meeting` uses Piper voices through `uvx` and ffmpeg instead of `say` (see the script header).

In `npm run dev`, macOS gives mic and system-audio permission to the app that launched Electron. It must declare both `NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription`. VS Code, Cursor and T3 Code do. Ghostty only declares the mic, so system audio comes through silent. Missing permission produces zeroed buffers, not errors.

## Architecture

Four kinds of process. Audio samples and model weights never enter the main process.

- **`oatmeal-audio`** (Swift CLI, `native/macos/OatmealAudio`). `detect` prints JSON lines when the set of processes using the mic or playing audio changes. `capture` writes framed 16 kHz PCM to stdout (`[u8 channel][u32le count][i16le…]`, 0 = mic, 1 = system via a Core Audio process tap) and JSON status lines to stderr. `permissions [--request mic|system]` checks or requests TCC access. The tap's aggregate device is clocked by the output device, so with a Bluetooth headset its input streams start with the headset's mic: `SystemAudioCapture` reads only the last (tap) buffer, turns the headset's streams off with `kAudioDevicePropertyIOProcStreamUsage` (opening them drops the headset into its call profile and changes the sample rate), and rebuilds when the format changes. The main process runs `detect` and `permissions`. The ASR worker spawns `capture`.
- **Linux has no helper.** `src/main/pulse.ts` + `detector.ts` replace `detect` (`pactl subscribe`, then `pactl -f json list` of streams and clients; `bundleId` is the executable name). `PipeWireSource` in `workers/asr/sources.ts` replaces `capture` with two `pw-record` processes (mic, and `stream.capture.sink=true` for the default output's monitor). Permissions are always "granted". On Hyprland, `windows.ts` adds a window rule via `hyprctl eval` (Lua config, Hyprland 0.56+) matching the panel's fixed title. On Omarchy, `main/omarchy.ts` watches `~/.local/state/omarchy/current` and `shared/omarchy.ts` maps the theme's `colors.toml` (and Hyprland's rounding) onto the Pantry CSS tokens, which `renderer/src/lib/theme.ts` sets inline on `<html>`, live on every `omarchy theme set`.
- **Main** (`src/main`). `index.ts` wires everything together. `Orchestrator` is the state machine (`idle → starting → recording → stopping → idle`), plus the call/notes floating panel, echo filtering, the notes queue and model downloads. Until `settings.onboarded` is true, the main window shows the first-run setup (`components/onboarding.tsx`) and detected calls aren't offered. `MeetingDetector` debounces helper output into per-app started/stopped events, and `shared/call-end.ts` tells "left the call" from "muted". `Store` (`db.ts`) is `node:sqlite` with FTS5. `WindowManager` manages the main window and the always-on-top prompt panel (`prompt.html`). `AppTray` is the menu-bar icon.
- **ASR utility process** (`src/workers/asr`). It loads `libmoonshine` through koffi FFI and runs one streaming transcriber per channel. Diarization runs only on the system channel, at a coarse cadence. It emits `line` / `speaker` / `activity` events. **Every FFI call must stay synchronous.** koffi's async calls crashed with SIGBUS, a stack overflow on libuv worker threads.
- **Updates** (`src/main/updater.ts`). electron-updater checks GitHub Releases 30 s after launch and every 6 h, downloads in the background, and installs on exit (Squirrel.Mac on macOS; AppImage only on Linux, pacman installs update through pacman). The AppImage installs no launcher entry, so on each launch `refreshLauncherEntry()` (`login-items.ts`) writes `~/.local/share/applications/oatmeal.desktop` and copies the icon (shipped as `resources/icon.png`), keeping it pointed at the current file across updates. The tray and Settings offer "Restart to update", refused while recording. `release.yml` must upload `dist/*.yml` and `*.blockmap` alongside the packages, since that's the update feed.
- **LLM utility process** (`src/workers/llm`). It runs node-llama-cpp (Metal) or an OpenAI-compatible endpoint (`clients.ts`), downloads GGUFs, preloads when the call app releases the mic, and unloads after 60 s idle. Context size is set per request, never at the model maximum.

### Typed message plumbing (change both sides together)

- **Renderer ↔ main**: `src/shared/api.ts` is the contract. A new invoke method needs three things: an entry in `OatmealInvoke`, its name in `INVOKE_METHODS` (the preload builds `window.oatmeal` from this array), and an implementation in `src/main/ipc.ts`. Main → renderer events are `OatmealEvents`, sent with `broadcast()` from `index.ts` to every window. The renderer subscribes through the hooks in `src/renderer/src/hooks/use-oatmeal.ts` (`useEvent`, `useMeeting`, …).
- **Main ↔ workers**: `src/shared/protocol.ts` defines `AsrRequests`/`AsrEvents` and `LlmRequests`/`LlmEvents`. Workers implement them with `serve<…>()` / `emit()` in `src/workers/rpc.ts`. Main calls them with `WorkerClient.request()` (`src/main/worker-client.ts`), which spawns lazily, respawns on the next request after a crash, and re-runs `onSpawn` (the ASR worker's `init`).

### Notes pipeline (`src/shared/summarize.ts`)

This module is pure logic, and the `LlmClient` is injected so tests use a fake. Segments go through `buildTurns` (merge same-speaker lines, drop echo, strip fillers) and then `chunkTurns` (~6K tokens). A transcript that fits one chunk gets **one pass**. Longer ones go map per chunk → verify → reduce. Verification happens in code: an item whose evidence timestamp falls outside its chunk is dropped. Map results are cached per meeting in `map_cache`, keyed by chunk hash, model and `PROMPT_VERSION`. **Bump `PROMPT_VERSION` whenever prompts or schemas change.** Output is grammar-constrained with the compact single-line JSON grammar in `workers/llm/grammar.ts`. node-llama-cpp's default indented grammar made Gemma close arrays early, so don't switch back.

### Conventions and constraints

- `src/shared` compiles under both tsconfigs and is imported by main, workers and the renderer. Keep it free of Node and Electron imports. Most unit tests live there.
- Path aliases: `@shared/*` everywhere, `@/*` for `src/renderer/src/*`.
- Windows are sandboxed with context isolation. The preload must build as CommonJS (`index.cjs`), as set in `electron.vite.config.ts`.
- DB migrations go at the end of the `MIGRATIONS` array in `db.ts`, tracked by `PRAGMA user_version`. Never edit an existing entry.
- Speaker keys are `me` (mic), `them` (system line not yet diarized), and `sys:N`. Display names live in `meetings.speaker_names`, and renames feed the notes prompt.
- The UI is Tailwind v4 + shadcn (`radix-nova` style, `components.json`). Generated primitives are in `src/renderer/src/components/ui/`.
- Nothing brings a window forward unasked. Recording runs in the background, and when notes are ready the panel offers "View notes". Keep this when changing the orchestrator or window code.
- In packaged builds, native binaries (node-llama-cpp, koffi) must stay in `asarUnpack`. The helper, `libmoonshine` and tray icons ship through `extraResources`, and `paths.ts` resolves them from `process.resourcesPath` when packaged and `./resources` in dev.
