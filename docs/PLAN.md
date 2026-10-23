# Nondh AI — Plan

A personal, offline-first Windows desktop app for **dictation into any app** and **recording + transcribing meetings** (including calls I only join). Cloud AI is optional and always uses my own keys.

## Decisions (agreed 2026-10-23)

| Topic | Decision |
|---|---|
| Name | Nondh AI — tagline "Darek vaat ni nondh." |
| Cloud LLM | Anthropic (summaries, Q&A, assistant). Others (OpenAI, Groq, Gemini, OpenRouter, any OpenAI-compatible) selectable. |
| Dictation cleanup | Local small LLM via llama.cpp by default, so it works offline. Cloud optional. |
| Speech-to-text | Local only by default. Cloud STT is opt-in per provider, with a visible "sent to cloud" marker. |
| Hotkeys | Dictate `Ctrl+Win` (hold = push-to-talk, double-tap = toggle), Translate `Ctrl+Win+T`, Assistant `Ctrl+Win+A`, Meeting `Ctrl+Win+M`. All rebindable. |
| Native code | Build our own helpers from source with VS 2022 Build Tools + CMake. |
| Languages | English. Translate target is a setting (default Spanish). |

## Target machine

i5-1245U (10C/12T, 15 W), 32 GB RAM, Intel Iris Xe, **no CUDA**. Consequences:

- **Default dictation engine: Parakeet TDT 0.6B (int8, sherpa-onnx, CPU).** Much faster than real time on CPU, strong English WER. This is how we hit the ~2 s target.
- **Whisper (whisper.cpp)** is the second engine (multilingual, translate). CPU build from upstream releases; a self-built **Vulkan** build is benchmarked against CPU and used only if it wins.
- **Local LLM**: small instruct model (1–4B, Q4) on llama.cpp; CPU vs Vulkan benchmarked. Long meeting summaries default to the cloud LLM when a key is configured, otherwise run locally (slow, shown with progress).
- Models live on a configurable data drive (D: on this machine, C: is tight).

## Architecture

```
┌──────────── Electron main (TypeScript) ─────────────┐
│ tray · windows · settings · secrets (safeStorage)   │
│ hotkey + paste  ◄── stdio ──► vd-input.exe (C)      │  low-level kbd hook, SendInput paste,
│ dictation controller · meeting controller           │  focused-app info
│ storage (SQLite, FTS5, optional SQLCipher)          │
│ providers: STT / LLM (local servers + cloud HTTP)   │
│ MCP server · localhost HTTP API (Phase 4)           │
└───────┬───────────────────────┬─────────────────────┘
        │ IPC (typed preload)   │ utilityProcess / child processes
┌───────▼────────┐   ┌──────────▼──────────────────────────────────┐
│ Renderer(s)    │   │ speech worker: sherpa-onnx-node (Parakeet,   │
│ React+Tailwind │   │   VAD, diarization, speaker embeddings)      │
│ +shadcn/ui     │   │ whisper-server.exe · llama-server.exe        │
│ indicator pill │   │ vd-audio.exe (C): WASAPI mic + loopback,     │
│ control panel  │   │   AEC (WebRTC AEC3), 16 kHz PCM out          │
│ meeting window │   │ ffmpeg (Opus encode, file import)            │
└────────────────┘   └──────────────────────────────────────────────┘
```

Why these choices:

- **electron-vite + TypeScript everywhere** (the reference is JS): typed IPC contracts catch most of the bugs this kind of app has.
- **sherpa-onnx-node in an Electron `utilityProcess`** instead of the reference's websocket server: no ports, no extra exe, inference never blocks the main process, and the same library also does VAD, diarization and embeddings.
- **whisper-server / llama-server as child processes** (as the reference does): upstream prebuilt binaries, OpenAI-style HTTP, easy CPU/Vulkan swap.
- **Our own small C helpers** rather than prebuilt third-party binaries. `vd-input` is needed because Electron's `globalShortcut` has no key-up event (no push-to-talk) and can't bind modifier-only chords like `Ctrl+Win`. Phase 1 dictation records the mic in the renderer (`getUserMedia` + AudioWorklet), which is simplest and good enough. Meetings use `vd-audio` for synchronized mic + loopback + AEC.
- **No Qdrant sidecar.** Vectors are stored in SQLite and searched brute-force (cosine, fast at personal scale), fused with FTS5 via Reciprocal Rank Fusion.
- **`better-sqlite3-multiple-ciphers`** (a drop-in better-sqlite3 fork) gives an optional encrypted-at-rest DB without changing code later.
- **Sync-ready schema**: UUID primary keys, `created_at` / `updated_at` / `deleted_at` (soft delete) on every user table. No sync is built.

## Data model (initial)

- `dictations(id, created_at, raw_text, clean_text, mode[dictate|translate|assistant], engine, model, duration_ms, latency_ms, app_name, cloud_used)`
- `meetings(id, title, started_at, ended_at, kind[call|room|import], audio_path, audio_expires_at, status, summary_json, calendar_event_id)`
- `segments(id, meeting_id, start_ms, end_ms, channel[mic|system|mixed], speaker_id, text, raw_text, confidence, overlap, is_final)`
- `speakers(id, display_name, is_me, created_at)` and `voiceprints(id, speaker_id, embedding BLOB, model, source_meeting_id, quality)`
- `meeting_speakers(meeting_id, local_label, speaker_id, match_confidence, confirmed)`
- `notes(id, folder_id, title, body_json, body_text, source_type, source_id)`, `folders(id, name, parent_id)`
- `embeddings(owner_type, owner_id, chunk_idx, vector BLOB, text)`, plus FTS5 tables over dictations, segments and notes
- `dictionary(id, term, replacement, kind[name|jargon|replace])`, `settings` in a JSON file, secrets in `safeStorage` files

## Phases and definition of done

### Phase 1 — Dictation
Tray app (auto-start, resident) · listening indicator pill · `vd-input` hotkeys (PTT + toggle) · record → STT → cleanup → paste into the focused app with clipboard restore · model manager (Whisper tiny→large-v3-turbo, Parakeet) · cloud STT (OpenAI/Groq/Gemini/compatible) · cleanup pipeline (fillers, punctuation, self-corrections, lists, custom dictionary; rule-based pre-pass + LLM) with raw view · translate hotkey · searchable history with re-copy · secrets via safeStorage.
**Done when:** hotkey in Notepad, Chrome, Slack and VS Code pastes clean text ≤ ~2 s after I stop talking, on the local model. Latency is logged per dictation as evidence.

### Phase 2 — Meetings
`vd-audio`: WASAPI mic + loopback as separate synchronized tracks · echo handling in layers (AEC3 when on speakers, echo-leak correlation gate, text-level duplicate drop; learned from the reference's design) · meeting detection (process list + mic-session events for Zoom/Teams/Meet/Webex/Slack/Discord) with toast · always-visible REC indicator + consent reminder with copy button · chunked crash-safe recording (PCM chunks + journal; recovery on start) → Opus · live transcript window, final pass after the call · speakers: channel = me/others, diarization of the loopback track, voice enrollment, voiceprint matching with confidence, rename + remember, overlap/uncertain marking · room mode · file import (drag-drop, batch) · summary (key points, decisions, action items with owners, open questions) · Q&A per meeting and across meetings · export MD/TXT/DOCX/SRT/VTT · retention + delete settings.
**Done when:** a real 30-min Zoom call I didn't host, on headphones and on speakers, gives me labeled as me, distinct others, no doubled echo text, usable summary.

### Phase 3 — Notes, search, assistant
Notes + folders (rich text, TipTap) · meeting/dictation → note · FTS5 + local semantic search (small ONNX embedding model) with keyword fallback · AI actions (summarize, rewrite, tasks, follow-up email) · assistant hotkey (edit selection in place / floating answer / paste at cursor / optional screenshot context) · LLM provider settings.

### Phase 4 — Integrations
Google + Microsoft calendar (titles, attendees, speaker-name hints) · local MCP server (search/read transcripts and notes) · localhost token-protected HTTP API · electron-builder NSIS installer (unsigned), auto-start, update path.

### Out of scope
Cloud sync, teams, web sharing, SSO/SCIM, enterprise policy, mobile.

## Privacy

Local by default; every cloud call is visible (badge in UI + `cloud_used` recorded). The recording indicator is never hidden while recording. Consent reminder at every recording start. Delete one meeting's audio / all audio / everything. Optional encryption at rest for the DB (SQLCipher) and recordings (AES-GCM, key in safeStorage).

## Testing

Vitest for non-UI logic: transcript merging, echo/duplicate policy, speaker assignment and voiceprint matching, cleanup pipeline (rule pass + prompt building + output guards), storage and migrations, chunk recovery. Each phase ends with an on-machine run, recorded evidence (logs, transcripts, screenshots) in `docs/evidence/`, and a git commit.

## Reference usage

