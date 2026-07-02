# LaluKit — status & backlog

## v1.2.2 — shipped & verified (2026-06-13)

**Precise word-level subtitle timing — text appears and disappears with the voice.** Default ON; toggle "Precise timing (word-level)" in the Subtitles panel (next to VAD/Translate).
- [x] Wired into the real transcription job: whisper runs with `-ml 1 -sow -wt 0.01` (word-level segments) → `buildLinesFromWords` regroups words into readable lines (split on >0.7s gap / 6s / 42-col width / sentence-end, CJK counted double, 30ms lead-in / 80ms trail-out, never overlapping) → `detectSpeechRegions` (ffmpeg `silencedetect=-32dB:0.28`) → `tightenToSpeech` hard-clamps every boundary into speech and splits any line straddling >0.5s of internal silence. Logged per run ("N words -> M lines -> K after speech clamp"). e2e asserts the flags reach the binary and that real-audio boundaries hug the speech.
- [x] **Waveform strip behind every transcript row** (`SegWave`): the audio around the line with the line's own span highlighted, so timing that hugs the speech is visible at a glance (reuses the already-computed waveform peaks; theme-aware canvas).
- [x] **"Tighten to speech" button** on the transcript toolbar: clamps existing/imported/legacy segment boundaries to detected speech (`snapSegmentsToSpeech`, count preserved 1:1), cancellable job, undo-able, success toast.
- [x] **Translation stays 1:1**: tightened timestamps are never touched — the translate step only attaches `translation` text to the same segment objects by id (strict id contract from v1.2.1). Re-verified: sync-guard + bilingual-compose e2e green.

**Real-video defect found & fixed (the reason we run on a real episode).** `scripts/verify-precise-timing.mts` (user's NNTINF EP13, large-v3-turbo on CUDA) measures dead air trapped inside each subtitle against an *independent*-threshold energy detector (-30dB vs the pipeline's -32dB clamp), precise ON vs OFF.
- [x] Found: whisper smears *brief* utterances — shouts (`バンデッドバン!`), short CJK phrases where `--split-on-word` finds no break — across long music/action spans as a *single* coarse entry. `buildLinesFromWords` bounded multi-word lines (the 6s flush) but let a single oversized entry through: real lines of **26s, and one of 56.8s** (`約束しただろう` / "I promised" parked on screen for nearly a minute). The synthetic-English e2e never triggered it.
- [x] Fixed: cap on-screen duration at `MAX_LINE_SEC`, anchored at the (reliable) start, trimming the smeared tail. Multi-word lines are unaffected; `tightenToSpeech` only shrinks single-word lines so the cap holds. Unit test added (the real 26.4s case).
- [x] Re-verified across four windows of the real episode: **zero lines over 6s** (raw whisper had 4–9 per slice, longest 56.8s), precise traps no more loose lines than raw, text preserved 1:1 (692/692, 675/675, 70/70 chars). Note: on anime, energy-based dead-air is confounded by continuous background music (an energy detector reads music as "speech"), so line-bounding + loose-line count are the honest indicators — both reported by the harness.

**Verification**: 48 engine e2e all green (the precise-timing test strengthened with the duration-cap + Tighten-button snap cases; real-Whisper boundary-hug + CUDA paths exercised); real-video sweep PASS. Installer: `dist/LaluKit-Setup-1.2.2.exe`.

## v1.2.1 — shipped & verified (2026-06-12)

**Regression 1 — hallucinations still reported.** Investigation: full-episode runs on TWO real episodes with the v1.2 build showed zero survivors even under stricter rules, pointing to the report coming from a stale dev main-process (needs restart for main changes). Hardened anyway, three layers deeper:
- [x] Silero **v6.2.0** bundled (latest ggml release); aggressive params `-vt 0.60 -vspd 250 -vsd 300 -vp 200`. Note: v6 detects sung vocals as speech → OP themes transcribe as lyrics instead of gapping (documented; instrumentals/silence still gate).
- [x] Explicit decode flags on every run, verified in-log and by e2e assertion on the live command line: `-mc 0 -tp 0.0 -tpi 0.2 -et 2.4 -lpt -1.0 -nth 0.6 -sns` (entropy-thold = whisper.cpp's compression-ratio analog; no such flag exists in whisper.cpp).
- [x] Tiered post-filter: reject (>50% n-gram on ≥16 chars, cps>60 runaway, triple-duplicates) / **suspicious → re-transcribed at temp 0.4, kept only if clean** (>25% short-gram, cps>25, short high-coverage bursts) — real exclamations (だめだめだめ!) and screams (うわあああ) survive; cap 32 repairs/run. Toast + chip report "N removed, M repaired".
- [x] Verified: 2 full episodes (332+364 lines) + music-heavy slice with VAD off — zero hallucination survivors everywhere; counts logged.

**Regression 2 — Arabic out of sync.** Diagnosis: translations were always stored on the same segment objects (boundaries 1:1 by construction); the real attack surface was an LLM reply with shifted ids being applied to neighboring lines — perceived as time drift. Plus a genuine boot race found during verification (renderer hydrate could overwrite a just-changed backend; main read stale settings).
- [x] Strict batch id contract: reply must contain exactly the sent id set (count + set match, duplicates rejected, numeric-string ids coerced); one corrective retry, then the batch fails wholesale — a misaligned reply is NEVER applied. e2e: persistent off-by-one mock → zero applied + exactly one retry; fixed-on-retry mock → clean mapping.
- [x] Final sync guard in the job: any foreign id aborts with `translate-sync` (nothing modified); log records "timing drift 0.000s, boundaries preserved 1:1".
- [x] Click-time config travels with the run call (renderer → main), eliminating the settings-race class entirely.
- [x] Player overlay picks the active line by bisecting currentTime over the SAME composed objects.
- [x] Verified end-to-end through the real app pipeline (offline NLLB): transcribe → translate → drift 0.0000s, Arabic on identical timestamps, Both view; plus a burn-"Both" pixel test proving subtitles render exactly inside speech windows and not in gaps.


## v1.2 — shipped & verified (2026-06-12)

**Whisper hallucination loops — fixed at three layers, verified on the real episode:**
- [x] Silero VAD v5 (whisper.cpp native ggml integration, 0.8 MB bundled): only detected speech reaches Whisper; timestamps map back to the original timeline. "Skip non-speech (VAD)" toggle, default ON.
- [x] Decoder hardening: `-mc 0` (no cross-segment conditioning), `-tp 0` with fallback ladder, `-sns` (suppress non-speech tokens) — defaults already matched the spec's entropy/logprob/no-speech thresholds.
- [x] Repetition cleaner: n-gram (1–6 chars) + word-loop detector drops lines >40% repetition and collapses triple-duplicate lines; UI shows a yellow "N lines auto-cleaned" chip. 8 unit cases (JA/EN/AR real text kept, loops flagged).
- [x] REAL verification (`scripts/verify-anime.mts`, user's Nanatsu no Taizai EP13, large-v3-turbo on CUDA): VAD off → 121 lines/1 cleaned/0 loops in output; VAD on → 27 clean dialogue lines, OP music = gap (minutes 3–4 empty), 4 s for 8 min. e2e: silence-padded speech keeps exact timestamps (first ≥ 4 s skipped).

**Real Arabic translation:**
- [x] Online backends: **Claude (default, claude-sonnet-4-6)**, OpenAI, DeepL, Google — 15-segment batches with ±3 lines of context, meaning-preserving system prompt (natural conversational Arabic, no transliteration, names kept, concise), per-batch retry/backoff, Retry-After honored, auth/quota/net mapped to localized messages, failed segments reported and re-runnable.
- [x] Offline fallback: NLLB-200-distilled-600M via transformers.js/onnxruntime (~600 MB auto-download with progress, then fully local). Real ja→ar run: "あ、おさらばだ。なあ、なあ、どうする?" → "-أجل، ماذا تفعل؟" (Arabic script, no romanization).
- [x] Keys encrypted with safeStorage/DPAPI, main-process only; Settings → Translation tab with per-provider walkthroughs, model pickers, Test-connection round-trip, target-language picker.
- [x] Bilingual UX: stacked original+Arabic rows (both editable, undo-able), Original/Arabic/Both view toggle driving overlay, burn-in, soft-attach and SRT/VTT export (bilingual = Arabic above source); export filenames carry `.ar` / `.ar-bilingual` suffixes.
- [x] Verification: mock-server e2e for all four adapters (batching, context, prompt content, 429 retry, 401 mapping, progress 34/34) + gated real-NLLB test; 43 e2e total, 14 smoke scenarios, all UI automations green; settings-stress re-verified with the new Translation tab in the walk.

**v1.2 notes / deferred:**
- Live Claude/OpenAI/DeepL/Google calls were verified against protocol-accurate mocks (no API key exists on this machine); the Test-connection button gives users a one-click live check.
- NLLB e2e is gated behind `LALU_E2E_NLLB=1` (600 MB download) — run once locally, kept out of routine CI-style runs.


## v1.1 — shipped & verified (2026-06-12)

**P1 bugs** (each reproduced with synthesized-input automation, fixed, re-verified):
- [x] App freeze after Settings — root cause: framer-motion layout-projection nodes (Segmented thumb / Toggle knob) deadlocking AnimatePresence exits, leaving an invisible click-eating overlay. Fixed with CSS-driven animations + zombie-proof always-mounted backdrop. `auto:settings-stress-heavy`: 6/6 cycles, 0 ghosts.
- [x] Timeline didn't seek — three stacked causes: media:// served ranges as bare 200 (unseekable element), stale fit-zoom mapping on resize, ungrabbable playhead. `auto:scrub`: click 5.6→5.6 exact, drag samples track pointer, playhead drag exact.
- [x] Arabic subtitles — bundled Noto Sans (Arabic) via `fontsdir`, e2e proves the bundled font file loads and pixels render; overlay uses `unicode-bidi: plaintext` with per-line direction; RTL transcripts default to the bundled font.
- [x] GPU — whisper.cpp CUDA 12 build bundled w/ runtime DLLs (verified `ggml_cuda_init … RTX 4070 Ti` through the app pipeline), per-session CPU fallback; NVENC tuned (p5/p6, lookahead, AQ) and default-on with per-job fallback; status bar reflects the truly-used backend.

**P2 polish**: top-right stacking toasts (4 s, 4 variants, actions), custom tooltips with shortcut chips on all icon buttons, command palette (Ctrl+K, fuzzy), status bar (file · accel · live job), timeline hover thumbnails, waveform playback pulse, whole-window dashed drop frame, transcribing skeletons, CSS-only control animations.

**P3 features**: undo/redo (50 steps), split at playhead (S; snapping moved to G), shift-click multi-select + batch delete, per-range speed (0.25–4×, atempo-chained audio) & volume, loudness normalization, watermark (text/PNG, 9-pos, opacity, scale, Arabic-safe via textfile+bundled font), aspect crop with live on-player guide + pan, extract audio (mp3/wav), GIF (two-pass palette), reverse, `.lalukit` projects (save/open/drop/Ctrl+S/O), 60 s auto-save + crash-restore offer, recents with thumbnails, batch transcription (multi-drop on Subtitles → sequential SRTs with overall progress).

**P4 Arabic-first**: Windows display language detected on first run, Cairo UI typeface for Arabic, full translations for every new string, RTL mirroring with LTR-pinned timeline/transport/timecodes.

**Verification**: 38 engine e2e tests, 14 smoke screenshot scenarios, 4 input-automation suites (`auto:scrub`, `auto:settings-stress`, `auto:settings-stress-heavy`, `auto:edit-ops`) — all green. Packaged build smoke-tested (exit 0, NVENC + CUDA in production paths). Installer: `dist/LaluKit-Setup-1.1.0.exe` (484 MB incl. CUDA runtime).

## v1.2 backlog (deliberately deferred)

- Batch **move** of multi-selected ranges (delete shipped; group-drag needs gap-aware clamping).
- Range handles "sticking" at common percentages (snapping covers the practical need).
- Hover-*expanding* scrollbars (styled thin/rounded/hover-tint shipped; width animation needs overlay scrollbars).
- Per-clip volume in **merge** (per-range volume in cut shipped).
- Effects path keeps first audio track only — multi-track effect mapping.
- Whisper VAD option (silero) for long silent-heavy files.
- Marquee (rubber-band) selection on the timeline.
- True smart-cut (stream-copy middle + re-encoded GOP edges) as a third engine.
