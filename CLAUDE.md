# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Nondh AI is an offline-first Windows desktop app (Electron + React + TypeScript) for dictation,
meeting recording/transcription with speaker identification, screen recording and video editing.
Design notes: `docs/PLAN.md`. Speaker-identification audit and calibration: `docs/SPEAKER_ID_AUDIT.md`
and `docs/evidence/speaker-id/README.md`.

## Commands

```sh
npm install                 # postinstall rebuilds native deps for Electron
npm run build:native        # compiles native/ C helpers into resources/bin (needs VS 2022 Build Tools, C++)
npm run dev                 # electron-vite dev; in shells started from VS Code, unset ELECTRON_RUN_AS_NODE first
npm run typecheck           # tsc for tsconfig.node.json (main/preload/shared/test/scripts) and tsconfig.web.json (renderer)
npm test                    # vitest run (all of test/**/*.test.ts, Node environment)
npx vitest run test/meetingSpeakers.test.ts          # one file
npx vitest run test/meetingSpeakers.test.ts -t "merges"   # one test by name
npm run build               # electron-vite build → out/
npm run dist                # native + build + NSIS installer → release/
npm run release             # after bumping "version" and committing: builds, tags, publishes a GitHub Release (needs gh)
```

There is no lint script; `npm run typecheck` and the tests are the checks. Under heavy CPU load
(e.g. while the speaker evaluation runs) a few slow tests (store adoption/encryption, .docx
reading) can exceed vitest's 5 s timeout; re-run them alone before treating that as a failure.

Speaker evaluation harness (dev only; data and models live in git-ignored `eval-data/`):

```sh
node scripts/speaker-eval.mjs synth --libri <LibriSpeech/dev-clean-2> --out eval-data/synth
node scripts/speaker-eval.mjs run --data eval-data/synth --data eval-data/downloads/ami --models "<models dir>" \
     --embedding eval-data/models/nemo_en_titanet_small.onnx --refine --merge 0.4 --min-cluster 4000 --cannot-link 5000
node scripts/speaker-eval.mjs embed-bench --libri <dev-clean-2> --ami <dir> --model a.onnx --model b.onnx
node scripts/speaker-eval.mjs calibrate --model <onnx> --libri <dev-clean-2> --ami <dir> --check 0.54,0.5,0.47
node scripts/speaker-eval.mjs real --appdata "%APPDATA%/Nondh AI" --meetings "<meetings dir>" --models "<models dir>" --embedding <onnx> --limit 6
```

`scripts/speaker-eval.mjs` bundles `scripts/speaker-eval/*.ts` with esbuild and runs it in Node
(`real` runs under Electron to unwrap the DPAPI audio key; it decrypts recordings in memory and
reports counts only). `run` caches sherpa's stage-1 output and piece embeddings in
`eval-data/cache`, so stage-2 sweeps are fast. A meeting corrected in the app and exported as
"Speaker timeline (.rttm)" is ground truth for `run`.

## Architecture

### Processes

- **Main process** (`src/main/index.ts`): creates every service and passes them to
  `registerIpc` as an `AppContext` (`src/main/ipc.ts`). Tray, hotkeys, windows, meeting detection,
  start-up sequence (model downloads → speech warm-up → crash recovery → voice re-derivation).
- **Renderer** (`src/renderer`): one React bundle for every window; `src/renderer/src/main.tsx`
  picks the page from the URL hash (`#/pill`, `#/meeting-live`, …, default `Panel`).
- **Preload** (`src/preload/index.ts`) exposes `window.vd.invoke/send/on` and **rejects any channel
  not listed** in `INVOKE_CHANNELS` / `EVENT_CHANNELS` / `SEND_CHANNELS` (`src/shared/ipc.ts`). A new
  IPC call needs its type in `InvokeMap`, its name in the channel list, and a `handle(...)` in `ipc.ts`.
- **Speech worker**: an Electron `utilityProcess` (`src/main/speech/speechWorker.ts`, its own
  electron-vite entry) owning sherpa-onnx: Parakeet ASR, Silero VAD, diarization and speaker
  embeddings. Messages are typed in `workerProtocol.ts`; `SpeechService` is the main-side client.
- **Child processes**: `whisper-server` and `llama-server` (llama.cpp, Qwen) from `resources/bin`;
  native helpers `vd-audio.exe` (WASAPI mic + loopback as two lock-step 16 kHz tracks, SpeexDSP
  echo cancellation) and `vd-input.exe` (keyboard hook, paste) built from `native/`.
- **MCP server** (`src/mcp/server.ts`, separate entry): stdio server that talks to the running app
  through the token-protected local HTTP API (`src/main/api`), never to the database directly.

### Code layout rules

- `src/shared` is pure TypeScript usable in Node (this is what the tests cover); `src/main` may
  import `electron`. Tests import `@shared/...` (alias in `vitest.config.ts`) and `src/main`
  modules that don't load Electron (storage repos, registry, diarizer). Keep decision logic in
  `src/shared` so it stays testable.
- Storage (`src/main/storage`): `better-sqlite3-multiple-ciphers`, optional SQLCipher encryption,
  soft deletes (`deleted_at`) everywhere. `migrations.ts` is **append-only**: entry *i* upgrades
  `user_version` *i → i+1`; never edit an existing entry, add a new one.
- Models (`src/main/models/registry.ts`): `MODELS`, `REQUIRED_MODELS` and `neededModels(settings)`
  decide what the app downloads at start-up; `modelManager.ts` does resumable downloads into a
  user-chosen models folder.
- Some source files use CRLF line endings; preserve them when editing.

### Meeting pipeline (spans many files)

1. **Capture** (`meeting/meetingService.ts`, `audioCapture.ts`): `vd-audio` frames go to
   `mic.pcm` / `system.pcm` (fsynced; `journal.json` for crash recovery) and to live speech
   streams. The live view labels lines "Me"/"Others" only; no diarization while recording.
2. **After stop** (`MeetingService.process`): final ASR pass per track → diarization of the
   system track (calls) or the only track (room/import) → `assembleTranscript` → lines and
   speakers saved → audio compressed to Opus (optionally AES-GCM encrypted) → summary.
3. **Diarization** (`src/main/speech/diarizer.ts`, shared with the eval harness): stage 1 is
   sherpa-onnx `OfflineSpeakerDiarization` (pyannote segmentation 3.0 + **NeMo TitaNet-small**
   embeddings, deliberately fine-grained). Stage 2 is `src/shared/meeting/refine.ts`: clean 1–6 s
   pieces per fragment are embedded, fragments are merged by average piece similarity, small
   fragments are folded into large ones (flagged `uncertain` when weak), and speakers are numbered
   by first appearance. Overlap in time only blocks a merge after 5 s of continuous simultaneous
   speech (sherpa can give one voice two overlapping turns).
4. **Assembly** (`src/shared/meeting/assemble.ts`, `speakers.ts`): in calls everything on the mic
   is "me" (after text echo removal in `echo.ts`). `identify()` names clusters from saved
   voiceprints using `MATCH_POLICY` (per-speech-bucket thresholds, margin over the runner-up,
   explicit unknown, fragments of one known person merged rather than given to someone else).
   `linesFromSegments` assigns each word by temporal overlap with turns, with continuity in
   overlaps and smoothing of one-word jitter.
5. **Voice memory**: naming a speaker saves a voiceprint only if `voiceprintToSave` accepts it
   (enough clear speech, consistent voice, made by the current model). Voiceprints and meeting
   speakers are tagged with `SPEAKER_MODEL`; after a model change, `MeetingService.rederiveVoices`
   rebuilds named people's voices from retained meeting audio on start-up.

**Calibrated constants**: `src/shared/meeting/policy.ts` (`DIARIZATION`, `MATCH_POLICY`) and
`VOICE_SAVE` in `speakers.ts` were measured for TitaNet-small with the harness. Changing the
embedding model means bumping `SPEAKER_MODEL`/`SPEAKER_EMBEDDING_ID` in `registry.ts` and
re-running `run` (sweep) and `calibrate`; thresholds don't carry over between models.

Other features: dictation (`src/main/dictation`, `src/shared/hotkeyMachine.ts`,
`src/shared/cleanup/` rules + optional LLM cleanup), screen recording (`src/main/screen`), video
editor (`src/main/video`, `src/shared/video`, FFmpeg via `ffmpeg-static`), notes and hybrid
FTS5 + vector search (`src/main/search`), calendars (`docs/CALENDAR.md`), local API (`docs/API.md`).

### Data and privacy

User data lives under Electron `userData` (`%APPDATA%/Nondh AI`) and a configurable data/models
folder. Secrets use Electron `safeStorage` (DPAPI) in `<userData>/secrets`. Cloud LLM/STT is
opt-in with the user's own keys and marked "cloud" in the UI; keep new features local by default.
