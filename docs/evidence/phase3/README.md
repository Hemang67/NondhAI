# Phase 3 evidence — notes, search, assistant (2026-10-23)

Driven through the app's own IPC (Chrome DevTools protocol on localhost, test-only `NONDH_DEBUG_PORT`) and, for the assistant, the real hotkey path (`NONDH_E2E` + `NONDH_FAKE_MIC`).

| Feature | Result |
|---|---|
| Folders and notes | Created a "Projects" folder and a note inside it; listing by folder and FTS5 search ("spreadsheet") return it. Fixed a layout bug in the folder list during the test. |
| Meeting → note, dictation → note | Both created notes with the source linked. The meeting note carries the summary and transcript in Markdown. |
| AI action "Extract tasks" (local Qwen3.5 2B) | 5.1 s; all four tasks found. It left out the owners; a cloud model does better here. |
| Hybrid search | "cost of licenses" finds the pricing meetings by meaning alone (no shared words); "who sends the spreadsheet" ranks the exact line first ("words + meaning"). MiniLM was replaced by BGE-small after it failed to separate related from unrelated text (0.19 vs 0.13 similarity). |
| Assistant, no selection | "Make this more formal and polite." with nothing selected → the floating panel asks for the text to rewrite (correct). |
| Assistant, edit selection in place | Text selected in a Chrome textarea, Ctrl+Win+A, "Make this more formal and polite." → replaced 2.4 s after release with: *"Could you please send me the report as soon as possible, as we require it prior to the call? Thank you."* The user's clipboard was the same before and after. Crop: `assistant-edit-result.png`. |
| Cross-meeting Q&A | See Phase 2 (answered from transcripts with the local model). |

Two failed attempts in `assistant-log.txt` (`selection: none`) were caused by the test harness, not the app. An Alt tap used to focus the window moved Chrome's focus to its menu button, and WinForms multiline text boxes don't support Ctrl+A. The harness was fixed by clicking into the field the way a person would. The app was also made more robust here: it now confirms its clipboard marker is in place and polls for the copy instead of waiting a fixed 180 ms.

Not verified: the screenshot-as-context option. It only applies to cloud vision models, and no API key is saved yet.
