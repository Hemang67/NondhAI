# Nondh AI

Offline-first dictation and meeting transcription for Windows. Third-party notices: `THIRD_PARTY_NOTICES.md`.

- **Dictation**: hold `Ctrl+Win`, speak, release. Clean text is pasted into the focused app, and your clipboard is put back afterwards. Double-tap to lock recording on. `Ctrl+Win+T` translates; `Ctrl+Win+A` is the assistant (edits selected text, or answers).
- **Meetings**: `Ctrl+Win+M`, the tray, or the "call detected" prompt. Your mic and the call audio are recorded as separate tracks, with echo removal, a live transcript, then speaker separation, voice memory, a summary, Q&A and exports.
- **Notes and search**: rich-text notes in folders, keyword + semantic search, AI actions.
- **Integrations**: local API and MCP server (`docs/API.md`), Google/Microsoft calendar (`docs/CALENDAR.md`).

Everything runs locally by default (Parakeet / Whisper / Qwen via llama.cpp). Cloud providers are optional, use your own keys, and are marked "cloud" wherever they're used.

## Develop

```
npm install
npm run build:native   # needs VS 2022 Build Tools (C++)
npm run dev            # in shells inherited from VS Code: unset ELECTRON_RUN_AS_NODE first
npm test
npm run dist           # → release/Nondh AI-Setup-x.y.z.exe
```

Bundled binaries live in `resources/bin` (git-ignored): `llama/` (llama.cpp Vulkan build), `whisper/Release/` (whisper.cpp), plus `vd-input.exe` and `vd-audio.exe` built from `native/`. Models download from the app's Models page into the models folder you choose.

Design: `docs/PLAN.md`. Evidence per phase: `docs/evidence/`.
