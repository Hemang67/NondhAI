# Phase 4 evidence — integrations and packaging (2026-10-23)

| Item | Result |
|---|---|
| Installer | `release/Nondh AI-Setup-0.1.0.exe` (180 MB, NSIS, per-user, unsigned) plus `latest.yml` for updates. Contents: Electron app, llama.cpp (Vulkan build, also used for CPU), whisper-server, vd-input, vd-audio, FFmpeg. Models are not bundled; they download on first use. |
| Packaged app, tested from `release/win-unpacked` (same files the installer contains) | Starts; Parakeet loads in the bundled speech worker; local LLM and embeddings start; dictation hotkey → paste into a text box in 267 ms; live call capture (vd-audio loopback) → transcript + Opus; file import (FFmpeg) → diarized transcript; local API answers. |
| MCP server | MCP client SDK → `Nondh AI.exe` (as Node) → `mcp.js`: lists 7 tools; `search`, `list_meetings` and `get_meeting` return real data. Also tested from the dev build. |
| Local API | Token required (401 without it), foreign Host refused (403); endpoints in `docs/API.md` exercised in Phases 2–4. |
| Updates | electron-updater "generic" feed (folder or URL) set in Settings → Updates. Builds emit `latest.yml`. **Not exercised end to end**: that needs a second, higher-version build. |
| Start at login | Registered via Windows login items with `--hidden` in the installed app (skipped in dev builds). Not verified, because the installer was not run on this machine. |
| Calendar | Google and Microsoft OAuth (PKCE, loopback) and event fetch are implemented. **Not tested**: it needs your client IDs (`docs/CALENDAR.md`). |

A harness note: empty-paste results in earlier test runs came from the test script's Alt tap putting WinForms and Chrome into menu focus. Clicking the field first, the way a person would, fixed it. The app's paste path was not changed for this.
