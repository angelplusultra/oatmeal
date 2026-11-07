# Oatmeal: a local, private meeting notes app

> Research and implementation plan. Written 2026-11-06, revised the same day after review (decisions in section 10) and after the first build (section 0).
> Status: v0.1 scaffold built. Phases 1–4 are implemented, and the pipeline passes end-to-end tests on recorded audio. Live capture from a real call is not yet verified.

---

## 0. What the first build found (2026-11-06)

Measured on an M5 Pro (64 GB), using a 28 s two-speaker clip and a 95 s synthetic three-person meeting. These results changed some earlier decisions.

**Moonshine: native, not WASM.** CPU while fed audio at real-time pace, continuous speech, one stream:

| Config | WASM (`@moonshine-ai/moonshine-wasm`) | Native (`libmoonshine` via koffi) |
|---|---|---|
| Medium | 2.54 cores | 1.26 cores |
| Medium, `decode_incomplete_lines=false` | 1.94 | **0.88** |
| Small, `decode_incomplete_lines=false` | 1.19 | **0.66** |
| Medium + live diarization (default cadence) | 4+ | 2.45 |
| Medium + live diarization (`analyze_cadence=3`, `cluster_cadence=10`) | — | **1.47** |

- The ASR worker loads the native library (from the official PyPI wheel, MIT) with **koffi** FFI. No compiled addon is needed, and the same TypeScript works with the `.dll` and `.so` on Windows and Linux.
- Partial-line decoding is off: lines appear when a phrase ends. That halves CPU, and live partials don't matter for notes.
- **Diarization runs live on the system channel only, at a coarse cadence.** A batch pass after the call was measured at about 10% of the call's length on 8 cores (about 6 minutes per hour), which is too slow to run by default.
- **Native calls must be synchronous.** Calling Moonshine through koffi's async API (libuv worker threads) crashed with SIGBUS after about 40 s of diarized audio. That's a stack overflow on the small worker-thread stacks. Synchronous calls in the dedicated utility process work. Moonshine's Python binding confirmed the library itself was fine.
- `libmoonshine.dylib` targets **macOS 15+**, so that's the minimum (not 14.2).
- The native 0.1.6 library pulls a newer model build (`quantized_26_11_02`) than the WASM package (`quantized_26_07_30`).
- Speaker separation on synthetic voices is mediocre: one speaker came out as three labels. Renaming speakers and regenerating notes is the fix for now. Real voices still need evaluation.

**LLM:** node-llama-cpp works inside an Electron `utilityProcess` (S6 ✓), loads Gemma 4 GGUFs, and constrains output with the JSON-schema grammar. Gemma 4 E2B prefilled 12K tokens in 2.7 s on Metal. A context only has a fixed pool of sequences, and disposed ones aren't returned, so one sequence per context is reused with its history cleared.

**Notes speed (after first user testing).** Gemma 4 E4B generates at about **37 tokens/s** on an M5 Pro through node-llama-cpp. That holds with or without a grammar, and with reasoning on or off. So notes time is mostly output length.
- Transcripts that fit in one chunk now get **one pass** that writes the final notes directly, still verified in code. Only longer meetings use map → reduce.
- The model is **preloaded** as soon as the call app releases the mic.
- A ~15 s test call went from about 10 s of notes time to about 6 s after the call ended, all included.
- Possible next steps: speculative decoding (Gemma 4 ships an MTP draft head), or E2B for very short calls.

**Grammar whitespace matters.** node-llama-cpp's default JSON-schema grammar forces newlines and 4-space indentation. With E4B, the model closed `"actionItems": [` early in 2 of 3 runs. Compact single-line JSON found every item in 3 of 3 (`scripts/eval-map.ts`), so it's what the app uses. (Note: node-llama-cpp's Gemma 4 wrapper turns reasoning on by default. Turning it off made no measurable difference here.)

**Call-end detection.** The helper now reports which apps are *playing* audio as well as using the mic. Mic released and audio stopped means the call ended, so recording stops after a 2 s grace. Mic released while audio keeps playing probably means muted, so recording continues until nobody has spoken for `autoStopSeconds` (`src/shared/call-end.ts`). This replaces a flat 15 s timer.

**Storage:** Electron 45 ships Node 24.22 with **`node:sqlite`** (FTS5 included), so there's no native database module.

**Verified end to end:** model download → recording → two-channel transcription → echo filtering → notes, using WAV files as the capture source, in both `npm run dev` and the packaged `.app`.
**Not yet verified:** the Swift `capture` path on a real call (it needs the Microphone and System Audio Recording permissions granted to the packaged app), detection with each meeting app, and Bluetooth devices.

Oatmeal is a small desktop app. It notices when you join a call, asks whether to transcribe it, transcribes it on your machine with speaker labels, and writes Granola-style notes (summary, decisions, action items) with a local LLM when the call ends. No audio, text or telemetry leaves the machine.

---

## 1. Decisions at a glance

| Area | Recommendation | Why |
|---|---|---|
| Shell | Electron 45 + React + TypeScript, built with **electron-vite** and packaged with **electron-builder** | Your preferred stack. `node-llama-cpp` publishes an Electron + React + TS template built on these tools. |
| First platform | **macOS 15+ on Apple Silicon, English only.** Windows in Phase 6, Linux later. OS-specific code sits behind interfaces from day one. | Core Audio taps (14.2+) give clean system-audio capture without the Screen Recording permission. Apple Silicon unified memory suits local LLMs. |
| Audio capture and meeting detection | A small **native helper binary** (`oatmeal-audio`, Swift on macOS) inside the app bundle, talking over stdio | No Electron or Node API reports which app is using the mic, so detection needs native code regardless. Electron's built-in macOS system-audio capture goes through screen sharing and has an open bug in the mode we need (section 3.3). |
| Speech to text | **Moonshine Voice** streaming models (Medium 245M by default, Small 123M on machines with fewer than 10 cores). The **native library is called through koffi FFI** in an Electron `utilityProcess` (see section 0; WASM used 2× the CPU) | MIT-licensed. Medium has a lower WER than Whisper Large v3 at a sixth of the size. Built for streaming. |
| Diarization | **Two channels plus Moonshine's built-in diarizer.** Mic = "You". System audio = everyone else, split into Speaker 1..N with `identify_speakers` (pyannote community-1 + VBx). | Splitting by channel answers the hardest question, you vs. them, for free. Diarization then only has to separate the remote participants. |
| Summarization runtime | **node-llama-cpp** (llama.cpp with Metal, CUDA or Vulkan) behind an `LlmEngine` interface, with an optional "OpenAI-compatible endpoint" setting for Ollama or LM Studio users | Same engine on every OS, JSON-schema-constrained output, exact token counts. MLX generates faster on Macs but isn't clearly faster at reading long input, which is most of this workload. It can be added later as a Mac-only engine (section 3.5.1). |
| Default LLM | **Gemma 4 E4B** at Q4 (about 6 GB). Gemma 4 E2B for 8 GB machines. Gemma 4 26B-A4B for 32 GB+. Qwen3.5-4B/9B as alternatives. | All Apache 2.0. E4B has a 128K context and a small KV cache (512-token sliding window on most layers). |
| Long transcripts | **Extract-then-synthesize map-reduce** over transcript chunks, with grammar-constrained JSON and evidence-timestamp checks | See section 3.5. It keeps memory and latency bounded and avoids small models' long-context quality loss. |
| Storage | SQLite (built-in `node:sqlite` + FTS5) in the app data dir. Audio is never written to disk (diarization runs live). The raw transcript is kept and exportable. | Simple, searchable, one file. |
| License | **MIT** | The standard permissive license. Compatible with every dependency (MIT, Apache 2.0, CC-BY with attribution). Includes the usual no-warranty, no-liability clause. |

---

## 2. Scope

**v1 does:**
1. Detects when a meeting app starts using the microphone (Zoom, Teams, Slack huddles, Discord, FaceTime, Webex, and Meet or other calls in a browser) and shows a small "Transcribe this call?" prompt.
2. Records the mic and system audio as two channels and shows a live transcript labelled You / Speaker 1 / Speaker 2…
3. When the call ends (the app releases the mic, or you press Stop), writes notes: title, TL;DR, key points by topic, decisions, action items (owner and due date when stated), and open questions.
4. Keeps a searchable list of past meetings. The **raw transcript** (exactly what the speech model produced, with timestamps and speakers) is always viewable and exportable as .txt, .md or .json. Speakers can be renamed, notes copied or exported as Markdown, and notes regenerated.

**Not in v1** (candidates for later): non-English meetings, keeping audio recordings, a Granola-style notepad that the LLM "enhances", custom templates, chatting with a meeting, calendar integration, recognising speakers across meetings, in-person (single-mic) diarization, Windows and Linux, cloud anything.

---

## 3. Research findings

### 3.1 Speech to text: Moonshine Voice

Moonshine AI (formerly Useful Sensors) relaunched as **Moonshine Voice** in Feb 2026. It's a C++ core on ONNX Runtime, with bindings for Python, Swift, Android and JavaScript/WASM.

| English model | Params | WER (Open ASR avg) | License |
|---|---|---|---|
| Medium Streaming | 245M | **6.65%** | MIT |
| Small Streaming | 123M | 7.84% | MIT |
| Tiny Streaming | 34M | 12.00% | MIT |
| *(Whisper Large v3, for reference)* | *1.5B* | *7.44%* | |

Findings that matter here:
- **Streaming design.** Most of the compute happens while people are still talking, so lines finalize about 50–80 ms after a phrase ends on a MacBook (Medium). Events: `LineStarted`, `LineTextChanged`, `LineCompleted`, `LineSpeakersChanged`. A completed line's text never changes again.
- **CPU only, by design.** The project measured CoreML and NNAPI and found they fragment the graph badly. The GPU therefore stays free for the LLM, which suits this app.
- **Built-in VAD** (Silero), **key terms** (bias toward names and jargon at runtime), and **word timestamps**.
- **JavaScript.** `@moonshine-ai/moonshine-wasm` (v0.1.6, Node ≥ 18) runs in Node as well as browsers. `Transcriber.load({ files })` accepts model bytes directly, so we can manage downloads ourselves rather than rely on the browser Cache API. The JS API had breaking renames recently, so **pin the version**.
- **Native path if WASM is too slow.** There's a stable C API (`moonshine-c-api.h`) and a header-only C++ wrapper, with prebuilt libraries for Windows and Linux and an SPM package for macOS. A small N-API addon or the Swift helper could call it directly (section 9, risk R1).
- **Languages.** Streaming models exist for English, Spanish, German, Japanese, Mandarin, Arabic, Vietnamese and Tagalog, all MIT. The only non-MIT STT models are the legacy non-streaming non-English ones (non-commercial license), which we won't use. **v1 is English-only** (Medium Streaming).

### 3.2 Diarization

- Moonshine's `identify_speakers` option runs **pyannote community-1** segmentation and embedding models (8.2 MB, downloaded once) plus PLDA/VBx clustering compiled into the library. Each line gets `speakerSpans` (sub-line speaker turns with `speakerIndex` and an opaque `speakerId`).
- In streaming mode it re-clusters a sliding window (`diarization_cluster_window_sec`, default 120 s, `0` = unlimited), so labels for recent lines can change (`LineSpeakersChanged`). Batch mode always uses the full history.
- The author says diarization "has room for improvement". Our design leans on it as little as possible:
  1. **Channel separation does most of the work.** Mic → "You" with certainty. System audio → remote participants. Diarization runs **only on the system channel**.
  2. **Optional final pass.** We keep a temporary 16 kHz recording of the system channel (deleted once notes are done). When the call ends, a batch diarization over the whole call can relabel speakers more consistently (Phase 0 compares this with `diarization_cluster_window_sec=0`).
  3. **Renaming in the UI** fixes the rest. Renaming "Speaker 2" to "Priya" applies everywhere and feeds the LLM prompt.
- Fallback if Moonshine's diarizer isn't good enough: `sherpa-onnx-node` (Apache 2.0, a native addon with an offline pyannote-based diarization API). It could also run Parakeet ASR if needed.
- **Attribution.** pyannote community-1 is **CC-BY-4.0**, and the PLDA was trained by BUT Speech@FIT. Credit both on an About/Licenses screen.

### 3.3 Capturing system audio on macOS, and why native code

Two jobs need code Electron doesn't provide:
1. **Detection** (section 3.4). No Electron or Node API reports which *other* app is using the mic. `systemPreferences` only covers Oatmeal's own permissions. This needs native code however we record.
2. **Recording the other participants** (system audio). Options:

| Option | Verdict |
|---|---|
| Electron `getDisplayMedia` + `audio: 'loopback'` | Electron's built-in route rides on screen sharing. Since Electron 39 it uses Core Audio taps on macOS 14.2+. Status checked with the GitHub CLI on 2026-11-06: **(a)** Issue [#52738](https://github.com/electron/electron/issues/52738) is **open**. When the app supplies the capture source itself (`useSystemPicker: false`, which a background recorder needs), the audio track arrives already ended and silent, and the macOS permission prompt never appears. Filed 2026-08-09 against Electron 43.3.0 / macOS 26.5.2 with a repro gist. A signed, notarized build behaves the same. **(b)** The related PR [#53647](https://github.com/electron/electron/pull/53647) (adds `askForMediaAccess('system-audio')`, "Refs #52738") is open and unmerged, targeted at 45.x/46.x. **(c)** The working alternative, `useSystemPicker: true`, shows macOS's screen-share picker on every call. **(d)** The custom path needs a screen source from `desktopCapturer.getSources`, which needs **Screen Recording** permission. macOS Sequoia and later re-ask for that monthly. **(e)** Electron's own docs disagree: the `session` docs still say loopback is "currently only supported on Windows". |
| ScreenCaptureKit directly | Works, but needs Screen Recording permission, with the same monthly re-prompt. |
| **Core Audio process taps** (`AudioHardwareCreateProcessTap`, macOS 14.2+) | Needs only the "System Audio Recording" permission (`NSAudioCaptureUsageDescription`). Can tap all processes or chosen PIDs. **Chosen.** |

**Helper binary vs. native addon.** The requirement is native code, not a separate process. A Node native addon (N-API via napi-rs or Objective-C++) loaded into a utility process would also work. A separate binary is preferred for three reasons:
- A crash in audio code can't take the app down.
- It can be run and tested from a terminal.
- It doesn't need rebuilding for each Electron version.

It's a few hundred lines and invisible to users.

**Revisit if Electron fixes it.** If #53647 lands and custom-source loopback works, a hybrid becomes possible: Electron records and native code only detects. That route would still need Screen Recording permission, so the tap stays the better choice on macOS. On Windows, Electron's loopback is the documented, mature path, so the Windows helper may only need to handle detection.

Reference code: **AudioTee** (MIT, Swift) already captures system audio through taps, converts it to a chosen sample rate and streams PCM to stdout, with `--include-processes` / `--exclude-processes`. We can vendor or adapt it. Apple's sample "Capturing system audio with Core Audio taps" and AudioCap cover requesting permission ahead of time.

Gotchas:
- If permission is missing, macOS delivers **zeroed buffers, not errors**. The helper must detect "N seconds of digital silence" and report a likely permission problem.
- In dev (unpackaged), TCC attributes capture to the terminal or IDE that launched Electron. The packaged app needs `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription` and the `com.apple.security.device.audio-input` entitlement under the hardened runtime. A helper spawned from inside the app bundle is attributed to the app.
- **Which processes to tap.** Tapping only the meeting app sounds tidy, but browser and Electron-based apps play audio from helper processes with different PIDs. Default to **all system audio except Oatmeal itself**. Try per-app taps in Phase 0.

### 3.4 Detecting a meeting

**macOS: poll Core Audio's per-process objects** (no permissions needed):
1. `kAudioHardwarePropertyProcessObjectList` → every process using audio.
2. For each: `kAudioProcessPropertyBundleID`, `kAudioProcessPropertyPID`, `kAudioProcessPropertyIsRunningInput` (is it capturing the mic right now?).
3. Match bundle IDs against an allowlist (Zoom `us.zoom.xos`, Teams, Slack, Discord, FaceTime, Webex, and browsers: Chrome, Safari, Arc, Edge, Firefox, Brave). Verify the exact IDs in Phase 0.

Two open-source projects do the same: the Rust crate `side-huddle` (polls every 300 ms, fires after 2 s of mic activity) and Hyprnote/Anarlog's `crates/detect` (`MEETING_APP_BUNDLE_IDS`). The older device-level property `kAudioDevicePropertyDeviceIsRunningSomewhere` is reported to miss Bluetooth mics, which is one more reason to use per-process objects. Still test with AirPods.

Edge cases and v1 decisions:
- **Browsers.** We can see "Chrome is using the mic" but not which tab. Reading window titles (`CGWindowList`) needs Screen Recording permission. **v1 doesn't try.** It prompts "Chrome is using your microphone. Transcribe?" The prompt is opt-in, so a false positive costs one click. Add "Never for this app".
- **Pre-join screens.** Zoom opens the mic on its pre-join screen. If you accept the prompt, capture just starts a few seconds early. That's harmless, so no special handling.
- **End of meeting.** The mic has been released for at least 15 s (configurable, because apps briefly release it when switching devices) → auto-stop and finalize, with a "Still in a meeting? Keep recording" toast. Always exclude Oatmeal's own PID, since our capture also holds the mic.

**Windows (later):** enumerate audio sessions on the capture endpoint (`IMMDevice::Activate(IAudioSessionManager2)` → `GetSessionEnumerator` → `IAudioSessionControl2::GetProcessId` + state, plus session-created notifications). Fallback: the registry `CapabilityAccessManager\ConsentStore\microphone\NonPackaged\*`, where `LastUsedTimeStop == 0` means in use. Both need validation.

### 3.5 Summarizing with a local LLM: the context question

You're **partly right**. The context window itself is rarely the problem. Memory, latency and small-model quality on long inputs are.

**How big is a transcript?** Conversational speech runs about 130–160 words per minute, so 8–10K words, or **about 11–14K tokens, per hour** including speaker labels. QMSum, a meeting-summarization benchmark, averages about 9K words per meeting with a maximum around 25K. A 2-hour meeting is roughly 25–30K tokens.

**Does it fit?** Yes. Gemma 4 E2B/E4B have a 128K context. Gemma 4 26B-A4B/31B and Qwen3.5 have 256–262K. Fitting isn't the issue. These are:

1. **Memory.** The KV cache grows with the context you allocate. Gemma 4 is unusually frugal: E4B uses a 512-token sliding window on 5 of every 6 layers, shares KV across its final layers, and stores K = V on global layers. Other families (Qwen, Llama) can need several GB of KV at 32K+ context. On a 16 GB Mac that's also running Zoom, Chrome and our ASR, that's the difference between working and getting killed for low memory. **Allocate only the context the current call needs** (chunk + prompt + output, about 8–12K), never "max context".
2. **Prefill latency.** The whole prompt has to be processed before the first output token. That's fast on Apple Silicon with Metal and much slower on CPU-only Windows laptops. A 30K-token single pass on weak hardware can take minutes.
3. **Quality on long inputs.** Models attend poorly to the middle of long contexts ("lost in the middle"), and Ravaut et al. (ACL 2024) showed this holds for summarization. A 2025 Frontiers study found that for **small** models, chunk → summarize → merge ("Map") beat summarizing the whole text at once ("Stuff"). BooookScore (ICLR 2024) found hierarchical merging gives more *coherent* summaries while incremental updating keeps more *detail*. For meeting notes, detail (who promised what) matters, so we extract detail per chunk and synthesize once at the end.

**The pipeline in plain terms.** In v1 the LLM does nothing during the call. When the call ends:

1. **Split** the transcript into pieces of about 6K tokens (roughly 25–30 minutes of talk). Cuts fall only between speaker turns, with a turn or two of overlap so nothing is lost at a cut.
2. **Extract** from each piece separately. The output is a structured list, not a prose summary: topics with key points, decisions, action items (task, owner, due date), open questions, and the timestamp where each one was said.
3. **Check** in code: drop any item that cites a timestamp outside its piece.
4. **Combine.** One final call reads all the lists and writes the notes: title, TL;DR, key points, decisions, deduplicated action items, open questions. The lists are far smaller than the transcript, about 0.5–1K tokens per piece.

*Example:* a 75-minute call is about 17K tokens, so it splits into 3 pieces (6K, 6K, 5K). That means 3 extract calls, then 1 combine call that reads about 2–3K tokens. A 20-minute call is a single piece, so extraction and writing happen in one call.

*Why lists rather than summaries of summaries:* every round of prose summarizing drops specifics. "Priya will send the pricing doc by Friday" is exactly the kind of detail that disappears. Lists keep it, and they're easy to merge and deduplicate.

*Why 6K:* it's a starting point. Small enough that a small model reads it reliably and memory stays low, big enough that topics aren't cut too often. Phase 0 tests 4K, 6K and 10K pieces against a single pass over the whole transcript and keeps whichever gives the best notes.

**The same pipeline in detail:**

```
transcript lines (SQLite)
   │  0. normalize: merge same-speaker turns, drop fillers (um/uh), [mm:ss] Speaker: text
   ▼
   │  1. chunk at turn boundaries, ≤ CHUNK_TOKENS (start ~6K; tune in Phase 0), 1–2 turns overlap
   ▼
   │  2. MAP (per chunk, grammar-constrained JSON, temperature ~0.2, thinking off):
   │       { topics[{title, points[], startTs}], decisions[{text, evidenceTs}],
   │         actionItems[{task, owner|null, due|null, evidenceTs}], openQuestions[] }
   ▼
   │  3. VERIFY (code, not LLM): drop/flag items whose evidenceTs isn't in that chunk;
   │       fuzzy-match owner names against known speakers
   ▼
   │  4. REDUCE (one call over all chunk notes, ~0.5–1K tokens per chunk):
   │       dedupe and merge → { title, tldr, keyPoints[], decisions[], actionItems[], openQuestions[] }
   │       (if the notes themselves exceed budget, e.g. 6h+ calls → reduce hierarchically)
   ▼
   │  5. RENDER Markdown in code (consistent formatting, links back to transcript timestamps)
   ▼
 summary (SQLite) ──► UI
```

- **Short calls** (one chunk, under ~25 minutes) do extract and synthesize in a single call.
- **Grammar-constrained JSON** (`node-llama-cpp`'s JSON-schema grammar) means a 4B model can't return malformed output. Small models fail that way often without it.
- **Evidence timestamps** are a cheap check against hallucination. Every decision and action item must cite where it was said. Code drops items that cite a time outside the chunk, and the UI makes each one clickable to jump to the transcript.
- **Caching.** Map results are keyed by `(chunk hash, model, prompt version)`. "Regenerate" and "try a bigger model" only redo what changed.
- **Live map mode** (designed in, switched on later if needed). The map step can run on each chunk *during* the call as it closes, so at the end only the last chunk and the reduce remain and notes appear within seconds. It's off by default in v1 because it keeps a ~6 GB model loaded during the call.
- **Resource policy.** Load the LLM after the call, unload it after about 60 s idle. Before loading, check free memory against the model's estimated footprint. If it won't fit, offer a smaller model or the configured endpoint. Run the LLM in its own process so an out-of-memory crash can't take the app (or the transcript) down. The transcript is saved line by line during the call, so a failed summary never loses data. "Retry" is always available.

**Model tiers** (all Apache 2.0, all GGUF through node-llama-cpp):

| Machine RAM | Default | Approx. memory | Notes |
|---|---|---|---|
| 8 GB | Gemma 4 E2B (Q4) | ~4 GB | Usable but weaker. Suggest a bring-your-own endpoint. |
| **16 GB** | **Gemma 4 E4B (Q4_K_M)** | ~5.5–6 GB | **Default.** Unsloth recommends Q8 for E-models (~9–12 GB), so compare Q4 and Q8 quality in Phase 0. |
| 32 GB+ | Gemma 4 26B-A4B (Q4) | ~16–18 GB | Mixture of experts with only 4B active per token, so quality jumps while speed stays reasonable. |
| Alternatives | Qwen3.5-4B / 9B | ~3 / ~6 GB at Q4 | 262K context. Compare in the eval. |

Gemma 4 defaults to temp 1.0 / top-p 0.95 / top-k 64. For extraction we'll use a lower temperature and check the effect in the eval. Thinking mode (`<|think|>`) stays off for map calls. Test it on the reduce call.

#### 3.5.1 What about MLX?

MLX is Apple's machine-learning framework for Apple Silicon. Recent benchmarks agree it **generates** text faster than llama.cpp on M4-class Macs, by roughly 1.4–1.8× on an M4 Max. One Qwen3.5-35B-A3B test measured about 130 vs. 71 tokens/s. Ollama switched its Apple Silicon engine to MLX in March 2026 (v0.19 preview).

It matters less for this app than it seems:
- **This workload is mostly reading, not writing.** Each call reads about 6K tokens of transcript and writes 0.5–1K. On reading (prefill), llama.cpp is competitive or faster on M1–M4. On an M1 Max with a 650-token prompt, llama.cpp was faster end to end. At 30K+ tokens on an M3 Ultra, MLX was reported about 50% slower than llama.cpp with Flash Attention. M5's Neural Accelerators change this: Apple reports 4× faster time-to-first-token than M4, both on MLX. So the answer shifts on the newest Macs.
- **Mac-only.** Since you want cross-platform eventually, llama.cpp has to exist anyway.
- **Thin TypeScript support.** The Node bindings (`@frost-beta/mlx`) are still 0.0.x. The practical MLX hosts are Python, which is heavy to bundle, or Swift.
- **No built-in structured output.** llama.cpp has JSON-schema grammars. MLX needs a third-party package for that.

**Decision:** llama.cpp for v1, behind an `LlmEngine` interface. Phase 0 (S5) times llama.cpp against MLX on the real workload on your Mac. If MLX wins clearly, there are two cheap ways to add it:
- Point Oatmeal at Ollama (MLX backend) through the existing endpoint setting.
- Host mlx-swift-lm inside the Swift helper we already ship.

Moonshine runs on the CPU, so MLX has no bearing on transcription.

### 3.6 Prior art worth reading

- **Meetily** (MIT, Tauri + Rust + Next.js): mic and system capture, Whisper or Parakeet, summaries through Ollama or external APIs. Good reference for product scope. It requires a separate Ollama install, which we avoid by bundling llama.cpp.
- **Hyprnote, now Anarlog / Char**: an open-source Granola alternative. Its `crates/detect` does mic-based meeting detection on macOS.
- **side-huddle** (Rust): a compact reference for Core Audio meeting detection and tap capture.
- **AudioTee / AudioTee.js** (MIT): system-audio capture to stdout from Swift, with a Node wrapper.

---

## 4. Architecture

```
┌──────────────────────────── Oatmeal.app ─────────────────────────────┐
│                                                                      │
│  Renderer (React)              Main process (TS)                     │
│  ┌────────────────┐  IPC  ┌──────────────────────────────┐           │
│  │ Meeting list   │◄─────►│ Tray / windows / prompt UI   │           │
│  │ Live view      │       │ MeetingOrchestrator (state)  │           │
│  │ Notes/Transcript│      │ DB (better-sqlite3 + FTS5)   │           │
│  │ Settings       │       │ ModelManager (downloads)     │           │
│  └────────────────┘       └──┬────────────┬───────────┬──┘           │
│                              │ spawn      │ fork      │ fork         │
│             ┌────────────────▼──┐  ┌──────▼────────┐ ┌▼────────────┐ │
│             │ oatmeal-audio     │  │ asr utility   │ │ llm utility │ │
│             │ (Swift helper)    │  │ process       │ │ process     │ │
│             │ • detect (always) │  │ Moonshine WASM│ │ node-llama- │ │
│             │ • capture (call)  │──►  stream: mic  │ │ cpp (Metal) │ │
│             │   mic + sys taps  │PCM  stream: sys │ │ map/reduce  │ │
│             └───────────────────┘  │  +diarization │ └─────────────┘ │
│                                    └───────────────┘                 │
└──────────────────────────────────────────────────────────────────────┘
```

**Processes:**
- **Main** owns state, the DB, windows and the tray. It never touches audio samples or model weights.
- **`oatmeal-audio` (Swift CLI)** in `Contents/Resources/bin`, signed with the app's team ID. Two modes:
  - `oatmeal-audio detect --interval 500` runs all day and prints JSON lines: `{"type":"mic-users","apps":[{"pid":123,"bundleId":"us.zoom.xos","name":"zoom.us"}]}` (only on change).
  - `oatmeal-audio capture --rate 16000 --mic default --system all --exclude-pid <oatmeal pids>` runs per call. **stdout** carries binary frames `[u8 channel][u32le nbytes][i16le PCM…]` (channel 0 = mic, 1 = system), both from the same clock. **stderr** carries JSON events (`started`, `silence-suspected`, `device-changed`, `error`).
  - `oatmeal-audio permissions [--request mic|system]` checks or requests TCC permissions.
- **ASR utility process** (`utilityProcess.fork`). The main process pipes the helper's stdout here, or the utility spawns the helper itself, so audio never crosses main. It runs two Moonshine streams: mic (no diarization) and system (`identify_speakers=true`). It posts line events to main over a `MessagePort` and writes temporary WAV/Opus files for the optional final diarization pass.
- **LLM utility process.** node-llama-cpp's docs say it must run in the *main* process (it crashes in a renderer). A `utilityProcess` is a Node environment, so it should work, but verify in Phase 0 and fall back to main if not. It loads on demand and unloads when idle.

**Cross-platform seams.** Everything OS-specific sits behind two interfaces in `src/main/platform/`:
- `MeetingDetector` emits changes in which apps are using the mic.
- `AudioSource` emits mic and system PCM frames.

On macOS both are backed by `oatmeal-audio`. On Windows, `AudioSource` might use Electron's own loopback plus `getUserMedia`, while `MeetingDetector` uses a small native helper. Transcription, storage, LLM and UI code never branch on the OS.

**Why mic capture lives in the helper rather than `getUserMedia`:** both channels share one clock (no drift alignment), no hidden renderer is needed, and one process owns every audio permission.

**Echo (speakers without headphones).** The mic picks up remote voices, which then appear twice. v1 uses a heuristic: drop a mic line if a system line overlaps it in time with normalized text similarity above ~0.6. It also suggests headphones the first time. v2: real AEC. Test whether Apple's voice processing (`AVAudioEngine.inputNode.setVoiceProcessingEnabled(true)`) in the helper cancels other apps' output (uncertain). Otherwise use WebRTC AEC3 with the system channel as reference.

---

## 5. Data model

```sql
meetings(id TEXT PK, title TEXT, source_app TEXT, started_at INT, ended_at INT,
         status TEXT CHECK(status IN ('recording','transcribed','summarizing','done','failed')),
         asr_model TEXT, llm_model TEXT, prompt_version INT, summary_json TEXT, summary_md TEXT,
         error TEXT)
segments(id INTEGER PK, meeting_id TEXT, channel INT, speaker_key TEXT,  -- 'me' | 'sys:0' | 'sys:1'…
         start_ms INT, end_ms INT, text TEXT, words_json TEXT)
speakers(meeting_id TEXT, speaker_key TEXT, display_name TEXT, PRIMARY KEY(meeting_id, speaker_key))
map_cache(key TEXT PK, json TEXT, created_at INT)            -- (chunk hash, model, prompt version)
segments_fts / meetings_fts                                 -- FTS5 for search
settings(key TEXT PK, value TEXT)
```

Files: `~/Library/Application Support/Oatmeal/{oatmeal.db, models/}`. Audio only exists in memory while it is transcribed and is never written to disk. (The end-of-call diarization pass, which would need it, was dropped as too slow; see section 0.) `segments.text` stores the raw ASR text. Filler removal only happens in the copy sent to the LLM.

---

## 6. UX (kept small)

- **Menu bar icon**: shows idle, prompt pending or recording (red dot). The menu has Start manually / Stop / Open Oatmeal.
- **Detection prompt**: a small frameless always-on-top panel at the top right, more reliable than notification actions: "**Zoom** is using your microphone. Transcribe this call? [Start] [Not now] [⌄ Never for Zoom]". It auto-dismisses after 30 s.
- **Main window**: a sidebar of meetings grouped by day, and a meeting view with **Notes | Transcript** tabs. While recording, the view shows the live transcript with "You" right-aligned and others left, a timer and a Stop button.
- **Notes view**: TL;DR, key points, decisions, action items (checkbox, owner, due, ↗ timestamp link) and open questions. Actions: Copy as Markdown, Export .md, Regenerate (choose model), Rename speakers.
- **Transcript view**: the raw transcript exactly as transcribed, with timestamps and speaker labels. Export as .txt, .md or .json.
- **First run**: permissions (mic, system audio), model download with progress (Moonshine about 250 MB, LLM about 3–6 GB, resumable, checksums), headphones tip, and a recording-consent reminder ("Some places require everyone's consent to record").
- **Settings**: detection on/off and per-app toggles; auto-stop delay; ASR model size; LLM model or custom endpoint URL; data folder; delete all data.

---

## 7. Repo layout (single package)

```
oatmeal/
├─ src/
│  ├─ main/            tray, windows, ipc, orchestrator, db, model-manager,
│  │                   platform/ (MeetingDetector, AudioSource per OS)
│  ├─ workers/         asr.ts, llm.ts (utilityProcess entry points)
│  ├─ preload/         typed contextBridge API
│  ├─ renderer/        React app
│  └─ shared/          IPC contracts, zod/JSON schemas, prompt templates, transcript utils
├─ native/macos/OatmealAudio/   Swift package → oatmeal-audio
├─ eval/               summarization eval harness + fixtures (not shipped)
├─ docs/PLAN.md
└─ electron-builder.ts / electron.vite.config.ts
```

Key dependencies: `electron@45`, `electron-vite`, `electron-builder`, `react`, `@moonshine-ai/moonshine-wasm` (pinned), `node-llama-cpp`, `better-sqlite3`, `zod`, `vitest`. Optional: Tailwind and Radix primitives for UI.

Packaging notes: keep `node-llama-cpp` and its binaries **outside the asar** and external to the bundler. Build each platform on its own CI runner (node-llama-cpp can't cross-package). Sign and notarize, including the Swift helper.

---

## 8. Roadmap

### Phase 0: spikes to settle the risky bits (1–2 weeks)
Each spike is throwaway code with a measured result.

| Spike | Question | Pass bar |
|---|---|---|
| **S1 Audio helper** | Can a signed dev build capture mic and system audio (tap) to 16 kHz PCM with only mic and system-audio permissions? | Clean two-channel capture of a Zoom call. Silence detection reports denied permission. |
| **S2 ASR performance** | Moonshine WASM in a Node utility process: real-time factor for Small/Medium, two streams, diarization on one, during a live call. Peak RAM. | Medium + diarization uses under ~35% of one machine's CPU on an M1/M2. Otherwise try the native C API, then Small. |
| **S3 Diarization quality** | Streaming (120 s window) vs. `window=0` vs. a batch pass at the end, on 3–5 recorded multi-person calls | Pick the default. Check whether speaker labels stay stable over 60 minutes. |
| **S4 Detection** | Process-object polling across Zoom, Meet (Chrome/Arc/Safari), Teams, Slack huddle, Discord, FaceTime, with AirPods | Detects start within 3 s and end within 20 s. Record the bundle IDs. |
| **S5 Summarization eval** | Public (AMI/ICSI/QMSum) and your own transcripts, 15 min to 2 h. Single pass vs. map-reduce, chunk size 4K/6K/10K, E4B Q4 vs Q8 vs Qwen3.5-4B vs 26B-A4B | Rubric: action-item recall, hallucinated items, coherence. Record latency and peak memory. Choose default model, chunk size and temperature. Also time llama.cpp vs. MLX (via Ollama or mlx-lm) on the same calls. |
| **S6 LLM process** | node-llama-cpp inside `utilityProcess` with Metal | Works, or fall back to main. |

### Phase 1: skeleton (≈1 week)
electron-vite + React + TS scaffold, tray, main window, typed IPC, SQLite migrations, settings, and a model manager with resumable downloads and progress UI.

### Phase 2: manual record and live transcript (≈2 weeks)
Swift helper `capture`, ASR utility process, two-channel live transcript with speaker labels, segments saved line by line, Stop → status `transcribed`. Echo-dedupe heuristic. Crash recovery: on restart, a meeting stuck in `recording` becomes `transcribed`.

### Phase 3: notes (≈2 weeks)
LLM utility process, the normalize → chunk → map → verify → reduce → render pipeline, map cache, notes UI, regenerate, rename speakers (the rename feeds the prompt), copy/export Markdown, FTS search.

### Phase 4: automatic detection (≈1 week)
Helper `detect`, orchestrator state machine (`idle → prompted → recording → finalizing → idle`), prompt panel, per-app ignore list, auto-stop with grace period.

### Phase 5: ship macOS v0.1 (≈1–2 weeks)
First-run onboarding, permission edge cases, signing and notarization, auto-update (GitHub Releases), licenses screen and `THIRD_PARTY_NOTICES` (pyannote attribution, dependency licenses), README, CI.

### Phase 6: Windows
Implement `MeetingDetector` with a small native helper that enumerates capture sessions. For `AudioSource`, use either Electron's built-in loopback plus `getUserMedia` or WASAPI in the same helper, whichever tests better. CPU-only prefill is slow on Windows, so default to a smaller chunk size and the E2B model on machines without a GPU, and support CUDA/Vulkan.

### Later
Notepad with "enhance" (Granola's signature feature), custom note templates, ask-the-meeting chat, calendar titles, cross-meeting speaker recognition (Moonshine speaker IDs are designed for it), live map mode, in-person mode, Linux (PipeWire).

---

## 9. Risks

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | Moonshine WASM too slow in Node for two streams plus diarization | Medium | Small model on the mic channel. A native N-API addon over the C API. Or run Moonshine inside the Swift helper (moonshine-swift) on macOS. |
| R2 | Moonshine diarization merges or splits remote speakers | Medium | Channel split, final batch pass, renaming UI, sherpa-onnx fallback. |
| R3 | Small-model notes miss or invent action items | Medium | Map-reduce, JSON grammar, evidence timestamps, eval harness, larger-model tier, BYO endpoint. |
| R4 | Memory pressure on 16 GB machines during or after calls | Medium | LLM loads only after the call, context sized per call, free-memory check, separate process, unload when idle. |
| R5 | macOS permission and TCC quirks (silent zero buffers, dev attribution) | High in dev, low shipped | Silence detection, explicit permission screen, test signed builds early (S1). |
| R6 | Echo when not using headphones | High | Dedupe heuristic and a headphones tip in v1. AEC in v2. |
| R7 | Moonshine JS API churn | Medium | Pin the version. Wrap it behind our own `AsrEngine` interface. |
| R8 | Browser meetings indistinguishable from other mic use | High (by design) | Generic prompt with per-app ignore. Window-title matching later as opt-in (needs Screen Recording). |

---

## 10. Decisions

| Question | Decision |
|---|---|
| License | **MIT** (`LICENSE` added). To stay out of trouble: keep model weights out of the repo (they're downloaded at runtime), credit pyannote (CC-BY-4.0) and include third-party license texts in `THIRD_PARTY_NOTICES`, and never copy code from GPL/AGPL projects. Reading them for ideas is fine. Hyprnote, Meetily, AudioTee and node-llama-cpp are all MIT. |
| Keep audio | No. Audio is temporary. The raw transcript is kept, viewable and exportable. |
| Non-English | Not in v1. English Medium Streaming only. |
| Intel Macs / macOS < 14.2 | Excluded for now. Cross-platform stays possible through the platform interfaces (section 4). |
| MLX | llama.cpp for v1. MLX gets re-measured in Phase 0 (section 3.5.1). |

---

## Sources

- Moonshine Voice repo, model table, licenses, diarization docs: <https://github.com/moonshine-ai/moonshine> (docs/models/available-models.md, docs/diarization-models.md, docs/api/options.md, docs/execution-providers.md, language-bindings/wasm/README.md)
- Moonshine docs: <https://moonshine-voice.readthedocs.io/en/latest/>
- Pete Warden, "Announcing Moonshine Voice" (Feb 2026): <https://petewarden.com/2026/02/13/announcing-moonshine-voice/>
- pyannote community-1 model card (CC-BY-4.0): <https://huggingface.co/pyannote/speaker-diarization-community-1>
- Electron desktopCapturer docs (Core Audio tap since 39, permissions): <https://www.electronjs.org/docs/latest/api/desktop-capturer>
- Electron issue #52738 (loopback silent with custom picker; open as of 2026-11-06): <https://github.com/electron/electron/issues/52738>
- Electron PR #53647 (`askForMediaAccess('system-audio')`; open, unmerged): <https://github.com/electron/electron/pull/53647>
- Electron session docs (`setDisplayMediaRequestHandler`, `useSystemPicker`): <https://www.electronjs.org/docs/latest/api/session>
- macOS Sequoia monthly screen-recording re-prompts: <https://www.macrumors.com/2024/08/15/macos-sequoia-screen-recording-app-permissions/>
- MLX vs llama.cpp on Apple Silicon: <https://yage.ai/share/mlx-apple-silicon-en-20260331.html>, <https://antekapetanovic.com/blog/qwen3.5-apple-silicon-benchmark/>
- Ollama on MLX (preview, v0.19): <https://registry.ollama.ai/blog/mlx>
- node-mlx (`@frost-beta/mlx`): <https://github.com/frost-beta/node-mlx>
- MLX Structured (Swift, JSON-schema constrained decoding): <https://github.com/gmh5225/mlx-swift-structured>
- Electron releases (45.2.2 stable, Nov 2026): <https://releases.electronjs.org/>
- electron-audio-loopback: <https://github.com/alectrocute/electron-audio-loopback>
- AudioTee: <https://github.com/makeusabrew/audiotee>
- Apple: Capturing system audio with Core Audio taps: <https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps>
- side-huddle detection source: <https://docs.rs/crate/side-huddle/0.2.1/source/src/platform/darwin/detect.rs>
- Hyprnote detect PR: <https://github.com/fastrepl/hyprnote/pull/1914>
- Apple forum on mic-in-use detection and Bluetooth: <https://developer.apple.com/forums/thread/741026>
- IAudioSessionManager2::GetSessionEnumerator: <https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nf-audiopolicy-iaudiosessionmanager2-getsessionenumerator>
- CapabilityAccessManager ConsentStore: <https://docs.velociraptor.app/exchange/artifacts/pages/windows.registry.capabilityaccessmanager>
- Gemma 4 (Apache 2.0, sizes, context): <https://www.theregister.com/2026/04/02/googles_gemma_4_open_weights/>, <https://en.wikipedia.org/wiki/Gemma_(language_model)>
- Unsloth Gemma 4 guide (memory, sampling, thinking): <https://unsloth.ai/docs/models/gemma-4>
- Gemma 4 architecture notes (sliding window, KV sharing): <https://jianyuh.github.io/architecture/2026/04/05/Gemma4.html>
- Qwen3.5 small models: <https://artificialanalysis.ai/articles/qwen3-5-small-models>
- node-llama-cpp Electron guide: <https://node-llama-cpp.withcat.ai/guide/electron>
- BooookScore (ICLR 2024): <https://arxiv.org/abs/2310.00785>
- Divide and summarize, SLM Map vs Stuff (Frontiers 2025): <https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1604034/pdf>
- Ravaut et al., middle-of-context in summarization (ACL 2024): <https://aclanthology.org/2024.acl-long.153.pdf>
- QMSum transcript lengths: <https://www.alphaxiv.org/abs/2609.25028.md>
- Meetily: <https://github.com/Zackriya-Solutions/meeting-minutes>
- sherpa-onnx diarization (Node API): <https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html>
