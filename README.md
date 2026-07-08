# LaluKit

Precision video cutting, merging and AI subtitles — in a fast, beautiful desktop app that runs **fully offline**. No accounts, no uploads, no telemetry.

![stack](https://img.shields.io/badge/Electron-React%20%2B%20TypeScript-2ea) ![engines](https://img.shields.io/badge/engines-FFmpeg%20%2B%20whisper.cpp-f60) ![gpu](https://img.shields.io/badge/GPU-CUDA%20%2B%20NVENC-76b900)
![LaluKit home screen](Screenshot(1).png)
![LaluKit timeline editor](Screenshot(2).png)
![LaluKit subtitles workspace](Screenshot(3).png)

## Why this stack

LaluKit is **Electron + React + TypeScript**, with **FFmpeg** (BtbN GPL build) and **whisper.cpp** (CPU + CUDA builds) bundled as native sidecar binaries driven over stdio. Electron was chosen because video tooling lives and dies by its UI, and the web platform gives a canvas-rendered timeline, hardware-accelerated `<video>` preview with full codec coverage, and a mature design toolchain that no native Windows framework matches for this effort budget. Shipping FFmpeg/whisper as separate processes (rather than language bindings) keeps the heavy lifting crash-isolated, trivially cancellable (kill the process tree), and upgradeable by swapping one exe. electron-builder then packs everything — app, FFmpeg, both whisper builds, fonts — into a single NSIS installer with no external prerequisites; only Whisper *models* download on first use, since they range from 78 MB to 3 GB.

## GPU acceleration

- **Transcription** runs on the bundled **CUDA 12 build of whisper.cpp** when an NVIDIA GPU is present (all required CUDA DLLs are bundled — no CUDA Toolkit install needed). If CUDA can't initialize, the job transparently falls back to the bundled CPU build and the session stays on CPU.
- **Encoding** prefers **NVENC** (`h264_nvenc`, preset p5/p6, look-ahead + spatial AQ) when available, with QSV/AMF as alternates and automatic per-job fallback to libx264. Hardware encoding is on by default and can be toggled per export or in Settings.
- The **status bar** always shows what's really in use (e.g. `GPU · CUDA + NVENC`), updated from the actual backend each transcription reports.

Requirements for GPU mode: NVIDIA GPU with CUDA 12-capable driver (any recent GeForce driver). Everything still works on CPU-only machines.

## Features

### Precision cutting
- Open MP4, MOV, MKV, AVI, WebM and more (drag & drop or picker). Formats the preview can't play directly get a fast background proxy — **editing and export always use the original file**.
- Zoomable timeline with thumbnails, audio waveform, hover scrub-preview thumbnails, magnetic snapping (`G`), and a grabbable playhead. Click or drag anywhere to seek — live, frame-accurate.
- Any number of ranges; **split at playhead (`S`)**, shift-click **multi-select** for batch delete, drag edges or whole ranges.
- **Per-range speed (0.25×–4×) and volume**, applied sample-accurately at export with pitch-corrected audio.
- **Keep** mode joins the selected ranges; **Remove** mode deletes them. Discarded regions are veiled.
- Two engines: **Frame-exact** (re-encode, lands on the exact frames — verified by automated tests) and **Lossless** (instant stream-copy, range starts snap to visible keyframe markers).
- Export extras: **loudness normalization** (EBU R128), **watermark** (PNG or text — Arabic-safe — with 9-position grid, opacity, size), **aspect-ratio crop** (16:9 · 9:16 · 1:1 · 4:5 · 21:9) with a live dashed guide on the player and pan control.
- **Undo / redo** for every editing operation (50 steps, `Ctrl+Z` / `Ctrl+Shift+Z`).

### Merge
- Drop multiple clips, drag to reorder, numbered filmstrip preview of the output order.
- Matching clips concatenate **losslessly in seconds**; mixed resolutions/framerates/codecs normalize automatically (silent audio injected for mute clips). The plan panel explains which path runs and why.

### AI subtitles (offline Whisper, GPU-accelerated)
- Arabic, English and ~100 other languages with auto-detect and optional translate-to-English. **Batch mode**: drop several videos onto the Subtitles workspace to transcribe them all sequentially, writing an `.srt` next to each.
- **Anti-hallucination (v1.2.1)**: three stacked defenses. (1) The bundled **Silero VAD v6** model (whisper.cpp's native integration) gates non-speech with aggressive settings (threshold 0.60, 250 ms minimum speech, 200 ms padding) — silence and instrumentals become clean gaps, timestamps map back to the original timeline. (2) Decoding runs with explicit hallucination-resistant flags, visible verbatim in the log (`-mc 0 -tp 0.0 -tpi 0.2 -et 2.4 -lpt -1.0 -nth 0.6 -sns`; whisper.cpp's entropy threshold is its analog of OpenAI's compression-ratio check). (3) A tiered post-filter: unmistakable garbage (>50% repeated n-grams on long lines, or runaway text like 170+ characters in one second) is dropped; *suspicious* lines (>25% short-gram repetition, abnormal chars-per-second) are **re-transcribed at higher temperature** and only dropped if the retry hallucinates too — so real exclamations like `だめだめだめ!` and screams like `うわあああ` survive. A toast and a yellow chip report "*N removed, M repaired*" after every run. Verified on two full real anime episodes (~700 lines): zero hallucination lines in the output.
- Model picker (Tiny → Large v3 / Turbo) with size/RAM/speed/accuracy trade-offs. Models download with progress + ETA and **resume after interruption**.
- **Precise timing (word-level, v1.2.2)** — on by default. Whisper emits word-level timestamps; lines are rebuilt into readable captions and then **hard-clamped to energy-detected speech**, so text appears and disappears with the voice instead of stretching into silence, and a line straddling a pause is split. A brief utterance that whisper smears across a long musical stretch — common on anime shouts and on CJK, where `--split-on-word` has no boundary to break on — is bounded to a readable on-screen duration (anchored at its reliable start) rather than parked for tens of seconds. Toggle it off to keep whisper's longer segments. A **"Tighten to speech"** button applies the same speech-clamp to any existing or imported transcript (timestamps only, segment count preserved 1:1).
- Full transcript editor: inline text editing (RTL-aware), timestamp edits, split/merge/add/delete, click-to-seek, follow-playback, and a **mini waveform behind each line** showing the surrounding audio with the line's own span highlighted — tight timing is visible at a glance.
- Export **SRT** and **VTT** (UTF-8; BOM on SRT so legacy players render Arabic).
- **Burn-in** with live-styled preview — rendered by libass with the **bundled Noto Sans / Noto Sans Arabic fonts** (`fontsdir`), so Arabic shaping and bidi are correct on any machine, independent of installed system fonts. When a transcript comes back in an RTL language, the style defaults to the bundled Arabic font automatically.
- **Soft subtitles**: attach as a selectable track (`mov_text`/SRT/WebVTT by container) with proper language tags.

### Real translation to Arabic (v1.2)

The Subtitles workspace has a **"Translate to Arabic"** button (target language configurable). Translation is *meaning-based*, never transliteration: `あ、おさらばだ。なあ、なあ、どうする?` becomes natural Arabic like `أه، وداعاً. هيا، ماذا سنفعل؟` — not `أ، أوسارابا…`.

| Backend | Quality | Needs | Notes |
| --- | --- | --- | --- |
| **Anthropic Claude** (default) | Best — meaning, tone, cultural context | API key | Segments are sent in batches of 15 **with 3 surrounding lines of context** and a system prompt enforcing natural conversational Arabic (no khutbah register for casual dialogue, names kept as names, concise for timing). Model selectable (`claude-sonnet-4-6` default). |
| OpenAI GPT | Strong | API key | Same context-aware batch protocol (`gpt-4o-mini` default). |
| DeepL | Good NMT | API key | Free keys (`…:fx`) auto-route to the free endpoint. |
| Google Translate | Broad | API key | Cloud Translation v2. |
| **NLLB-200 offline** | Decent | nothing | 600M distilled model (~600 MB) auto-downloads on first use, then translates fully offline on the CPU. The free, no-key fallback. |

- Keys are stored **encrypted with Windows DPAPI** (`safeStorage`), never leave the main process, and are only ever sent to the provider you selected. Settings → Translation has per-provider setup walkthroughs and a **Test connection** button that round-trips a sample line.
- **Timing is guaranteed 1:1 (v1.2.1)**: translations attach to the *same* segment objects by id — never merged or split. Each LLM batch is validated against a strict id contract (same count, same id set); a misnumbered reply gets one corrective retry and is otherwise rejected wholesale, never applied misaligned. A final sync guard aborts if any returned id doesn't exist in the transcript, and the log records the 0.000 s drift check. The player picks the active line by bisecting `currentTime` over those same objects, so the Arabic can't drift from the audio.
- Live progress ("Translating 12/127…"), cancellable; rate limits honor `Retry-After`, transient errors retry with backoff, failed segments are reported and can be re-run without losing finished ones; auth/quota problems produce clear localized messages.
- After translation every line shows **both original and Arabic stacked**, each independently editable. A **view toggle (Original / Arabic / Both)** drives the player overlay, **burn-in**, soft-attach and SRT/VTT export alike — bilingual export stacks the Arabic line above its source, exactly what gets burned.

**Cost ballpark (Claude `claude-sonnet-4-6`)**: a 1-hour video ≈ 800–1000 segments ≈ 60–70 API calls ≈ ~75k input + ~25k output tokens ≈ **$0.60**. A 24-min episode ≈ **$0.25**. `claude-haiku-4-5` is roughly 4× cheaper; DeepL/Google bill per character; NLLB is free.

### Tools
- **Extract audio** to MP3/WAV · **GIF export** (10/15/24 fps, 480/720/1080 wide, loop control, two-pass palette) · **Reverse** a range or whole clip (≤5 min) — all range-aware and cancellable.
- **Projects**: save the whole editing state to a `.lalukit` file (`Ctrl+S`), reopen by file, drop, or `Ctrl+O`. **Auto-save every 60 s** with a restore offer after a crash.
- **Command palette** (`Ctrl+K`): fuzzy search over every action.

### Player & shortcuts
`Space` play/pause · `J/K/L` shuttle · `←/→` seek 1 s (`Shift` 5 s) · `[` `]` ±1 frame · `I/O` mark in/out · `N` new range · `S` split · `Del` delete selected · `G` snapping · `M` mute · `Home/End` · `Ctrl+K` palette · `Ctrl+Z` undo · `?` shortcut overlay.

### Design
- Dark (default) and light themes with animated cross-fade; tooltips with shortcut chips on every icon button; toast notifications (top-right, stackable, auto-dismiss); skeleton loaders; status bar with file info + acceleration + live job progress.
- Full **English and Arabic UI**. Arabic mode is detected from Windows on first launch, uses the bundled **Cairo** typeface, mirrors the whole layout RTL — while the timeline, transport and all timecodes/numbers stay LTR, as time should.
- Friendly, localized error messages for corrupt files, missing audio, full disks, failed downloads, GPU failures — never a raw stack trace. Logs at `%APPDATA%\LaluKit\logs\lalukit.log`.

## Develop

```powershell
npm install          # first `npm run dev` fetches engine binaries (~650 MB incl. CUDA whisper)
npm run dev          # launch with hot reload
```

```powershell
npm run setup:bins   # (re)download FFmpeg, whisper (CPU+CUDA) and fonts; --no-cuda to skip the CUDA build
npm run typecheck    # strict TS across main/preload/renderer
npm run e2e          # 38 engine tests: real cuts (frame-counted), merges, GPU whisper
                     # transcription of synthesized speech, burn-in pixel checks with the
                     # bundled Arabic font, watermarks, crop, GIF, reverse, cancellation
npm run smoke        # boots the app into 14 scenarios, screenshots each, fails on console errors
node scripts/smoke.mjs auto:scrub auto:settings-stress-heavy auto:edit-ops
                     # UI automation with synthesized input: timeline seeking, modal stress,
                     # split/undo/redo/multi-select/palette
```

## Build the installer

```powershell
npm run dist
```

Produces `dist/LaluKit-Setup-<version>.exe` bundling the app, FFmpeg/FFprobe, whisper-cli (CPU **and** CUDA + its CUDA runtime DLLs) and the Noto fonts. The CUDA payload makes the installer large (~600 MB); pass `--no-cuda` to `setup:bins` before building for a slim CPU-only installer.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Status bar says CPU on an NVIDIA machine | Update the GPU driver (CUDA 12 needs a recent one). Check the log for `CUDA whisper failed`. |
| “Engine binaries are missing” on the home screen | Run `npm run setup:bins` (dev only — the installer always bundles them). |
| Model download fails or is slow | Press the button again — downloads resume. If `huggingface.co` is blocked, place `ggml-<model>.bin` into `%APPDATA%\LaluKit\models` manually. |
| Transcription out-of-memory | Pick a smaller model or close other apps — Large v3 needs ~4.7 GB free RAM (GPU mode needs similar VRAM headroom). |
| Export fails immediately with a disk message | Free space on the target drive; LaluKit pre-checks before encoding. |
| Hardware encoder errors | LaluKit falls back to software automatically once per job; disable “Use hardware encoder” to pin CPU. Update GPU drivers to re-enable. |
| Arabic subtitles look wrong in another player | Burned-in output is rendered into pixels and plays everywhere (verified in libass + VLC-compatible H.264). For *soft* subtitles, the player must support the track format (`mov_text` in MP4). |
| Preview is a converted proxy (“Preparing preview…”) | Normal for codecs Chromium can't decode (e.g. 10-bit HEVC). Exports still come from the original. |
| Antivirus flags the bundled exes | They're unmodified official builds (BtbN FFmpeg, ggml-org whisper.cpp); allow-list them. |
| Whisper writes repeated characters on songs/silence | Shouldn't happen with **Skip non-speech (VAD)** on (the default). If you disabled VAD for lyrics, the repetition cleaner still drops loops and shows the yellow auto-cleaned chip. |
| "Translate" says no key is saved | Add a key in Settings → Translation (per-provider instructions inline), or pick the **Offline (NLLB)** backend which needs none. |
| Translation key rejected / quota errors | The toast names the cause: `auth` → re-check the key; `quota` → wait or switch backends. Finished segments are kept, re-running only retries the failed ones. |
| Offline translation stuck at "model %" | First use downloads ~600 MB from huggingface.co; check connectivity, then retry — the download caches in `%APPDATA%\LaluKit\models\nllb-cache`. |
| Where are my logs? | `%APPDATA%\LaluKit\logs\lalukit.log`, or Settings → About → Open log. |

## Known limitations (v1.2.2)

- LLM translation quality was protocol-verified against a mock Anthropic/OpenAI server (request shape, context, batching, retries, id-contract violations) plus real offline-NLLB Japanese→Arabic runs through the full app pipeline (0.000 s timing drift); live-API quality depends on the model you select.
- Silero **v6** detects sung vocals as speech, so opening themes transcribe as lyrics rather than becoming gaps (instrumentals and silence still gate out); the hallucination filter guarantees no loops either way. Toggle VAD off entirely if you prefer raw whisper behavior.
- Precise timing leans on whisper's word timestamps. In sung/instrumental stretches whisper can smear a brief line across a long span; precise timing caps it to a readable duration anchored at its start rather than guessing the true end, and on wall-to-wall music the energy-based speech clamp is conservative (the detector reads music as speech). Toggle precise timing off for whisper's raw segments.
- Suspicious-segment repair is capped at 32 re-transcriptions per run to bound time; beyond the cap, suspicious lines are dropped (counted in the report).

- Per-range speed/volume, watermark, crop and loudness need the **Frame-exact** engine (Lossless is a pure stream copy by definition).
- When effects are active, exports keep the **first audio track** only; the plain path preserves all tracks.
- Multi-selected ranges support batch **delete**; batch *move* is planned for v1.2.
- GIF ≤60 s, Reverse ≤5 min (memory-bounded by design).
- Merge accepts video clips only (extract audio first to include an audio-only source).

## Privacy

Everything — playback, cutting, merging, transcription — happens on your machine. The only network access is downloading Whisper models (and, for developers, the engine binaries) when you ask for them.

## License notes

LaluKit's own code is MIT. It bundles [FFmpeg](https://ffmpeg.org) (GPL build by BtbN), [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) with NVIDIA CUDA runtime libraries (redistributed per NVIDIA's CUDA EULA redistributable terms), and Noto fonts (OFL). Whisper models are MIT-licensed by OpenAI. UI fonts: Inter, JetBrains Mono, Cairo, Noto Sans Arabic (all OFL).

---

## About this project

Built solo by **Jarallah Al-Jarallah**, a Computer Science graduate from Majmaah University. I designed the architecture, the FFmpeg/whisper.cpp integration strategy, the Arabic RTL UI, and drove every feature decision — using Claude Code as an AI pair-programmer throughout development.

📧 jarallahx@gmail.com  
🔗 [LinkedIn](https://www.linkedin.com/in/jarallah-al-jarallah)  
🔗 [GitHub](https://github.com/Jarallahx)
