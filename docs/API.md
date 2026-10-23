# Nondh AI local API

Turn it on in **Settings → Integrations → Local API**. It listens on `127.0.0.1:47821` only, and every request needs `Authorization: Bearer <token>` ("Copy token" in Settings; also in `%APPDATA%\Nondh AI\api.json` while the API is on). Requests with any Host other than `127.0.0.1` or `localhost` are refused.

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/health` | `{ ok, recording }` |
| GET | `/v1/search?q=&limit=` | Hybrid keyword + semantic hits across meetings, notes, dictations |
| GET | `/v1/meetings?q=&limit=` | Meetings, newest first |
| GET | `/v1/meetings/:id` | Meeting with speakers, transcript lines, summary |
| GET | `/v1/meetings/:id/markdown` | `{ markdown }`: summary + transcript |
| GET | `/v1/meetings/:id/transcript?format=txt\|srt\|vtt` | Plain text or subtitles |
| POST | `/v1/meetings/start` `{ kind: "call"\|"room", title? }` | Starts recording (the REC indicator shows as usual) |
| POST | `/v1/meetings/stop` | `{ id }` |
| POST | `/v1/meetings/import` `{ paths: [...] }` | `{ ids }`: queued for transcription |
| POST | `/v1/ask` `{ question, meetingId? }` | `{ answer, cloud }`: one meeting, or all meetings |
| GET | `/v1/notes?q=` · `/v1/notes/:id` | Notes |
| POST | `/v1/notes` `{ title, text }` | New note |
| GET | `/v1/dictations?q=&limit=` | Dictation history |

```powershell
$t = (Get-Content "$env:APPDATA\Nondh AI\api.json" | ConvertFrom-Json).token
Invoke-RestMethod -Headers @{ Authorization = "Bearer $t" } "http://127.0.0.1:47821/v1/search?q=pricing"
```

## MCP server (Claude Code and other AI assistants)

The MCP server uses this API, so keep the API on. Copy the exact command from **Settings → Integrations → MCP server**. For a default install it looks like this:

```
claude mcp add nondh -e ELECTRON_RUN_AS_NODE=1 -- "%LOCALAPPDATA%\Programs\Nondh AI\Nondh AI.exe" "%LOCALAPPDATA%\Programs\Nondh AI\resources\app.asar\out\main\mcp.js"
```

Tools: `search`, `list_meetings`, `get_meeting`, `list_notes`, `get_note`, `recent_dictations`, `ask_meetings`. All are read-only.
