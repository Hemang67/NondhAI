# Phase 2 evidence — meetings (2026-10-23)

## What was run on this machine

| Test | How | Result |
|---|---|---|
| Live call capture | Started a call recording through the local API, played a 36 s two-voice conversation through the speakers (Windows TTS), stopped it | `vd-audio` recorded mic and loopback as separate, aligned tracks (AB13X USB headset). The final pass transcribed the system track word for word: 11 segments, diarization, Opus encoding and a local summary, 29 s after stopping. The mic track stayed empty (headset), so nothing was doubled. |
| Crash recovery | Two meetings left in `recording` state with PCM files on disk (as after a crash), then the app was started | Both found at startup (`recovering meeting … 12 s of audio`), processed, encoded, marked "recovered after a crash" |
| Echo removal (speakers) | Mic track = my voice + the far end delayed 60 ms through a simulated room response; system track = the far end | Raw mic: 15 echoed words dropped; after SpeexDSP AEC: 10 dropped. The far-end sentence appears once, under the other speaker, never as "Me". Leftovers: one stray word ("three"), and in the raw-mic case the speech recognizer garbled my overlapping words ("Premya"). |
| AEC alone (offline mode, `vd-audio --aec-file`) | Same simulation | 8.6 dB echo reduction in the far-end-only window. Not enough on its own, which is why text-level removal also runs. |
| Diarization, real speech | sherpa-onnx's 4-speaker recording | 4 speakers found at thresholds 0.4, 0.5 and 0.6 |
| Diarization, hard case | JFK (1961, reverberant) alternating with a LibriSpeech narrator | Over-split JFK into 3 clusters in one file and merged both voices in another. CAM++ rates their later turns 0.83–0.93 alike, so the voice model itself can't separate this pair. Synthetic Windows TTS voices also cluster poorly (70–80 % purity). |
| Voice memory | Named a cluster "Phoebe" through the app's own IPC, then imported a second file | Recognized automatically as Phoebe, 0.82 similarity, "high" confidence. In that file the diarizer had merged JFK into the same cluster, so his lines were wrongly labeled too. See the limitation below. |
| File import | API and IPC import of WAV files | Decoded with FFmpeg, processed like an in-person meeting |
| Summary and Q&A | Local Qwen3.5 2B | Summary with key points, decisions, action items and open questions. Cross-meeting question ("What price per seat… who is updating the spreadsheet?") answered correctly ($30, Speaker 3 by Friday). |
| Local API security | `curl` without a token, and with a foreign Host header | 401 and 403 |

`processing-log.txt` has the app's log lines for these runs.

## Known limitations

- Speaker confidence comes from the voice match only. If the diarizer merges two people into one cluster, both get the same label at the same confidence. Fixing a line is one click (hover the line → pick the speaker), and renaming teaches the right voice.
- In-person and imported recordings have only one channel, so "me" comes from voice enrollment, not the channel. Calls use the channel and are reliable.
- The real definition-of-done test (a 30-minute Zoom call you didn't host, on headphones and on speakers) needs you on a real call. It hasn't been run.
