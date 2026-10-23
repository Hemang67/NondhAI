# Video library and editor (v0.4.0): evidence

Verified on 2026-10-23 on the development laptop, against a separate test profile (`NONDH_USER_DATA`), seeded with one synthetic meeting:
- Three screen clips: a fake settings page showing a fake password and API key, a moving test pattern, and a closing slide.
- 40 s of tone audio.
- Five transcript lines from two speakers.

The profile and all generated media were deleted afterwards.

## Automated

- `npm test`: 147 passing. New suites:
  - `videoProject`: timeline, cuts, subtitles from the transcript, SRT.
  - `videoSensitive`: secret detection, Luhn, blur tracking, crop mapping, de-duplication.
  - `videoRender`: the FFmpeg graph.
  - `videoRenderFfmpeg`: a real FFmpeg export of a merge that uses every feature; checks for a 9 s 576×324 H.264 + AAC MP4.
  - `videoRepo`: storage.
- The real-FFmpeg test caught two bugs the graph tests could not, both fixed:
  - The boxblur chroma radius is capped by the half-size chroma planes.
  - drawtext expands `%` in text files, so it now uses `expansion=none`.

## In the app

| Check | Result |
|---|---|
| Library lists the meeting's 3 recordings; ticking them and pressing **Merge 3 selected…** opens a confirm dialog listing order and length | ✔ nothing is merged until confirmed |
| Merge → editor with 3 parts on the timeline; subtitles placed from the transcript (a line starting before the clip is clipped to it) | ✔ |
| Playback crosses from recording #1 to #2 at 0:08 with meeting audio in step; seeking anywhere | ✔ after moving media to the loopback server (below) |
| **Find sensitive info** (Windows OCR, 19 frames) → 2 suggestions, over the password and the API key, shown redacted (`hu•••r2`) with Blur / Dismiss | ✔ |
| Export with progress (0% → 46% → Exported) → 19 s, 960×540 H.264 + AAC. Frames show the blurred secrets, text elements, speaker-labelled subtitles, and the 640×360 / 1280×720 clips scaled into the frame | ✔ |
| Export with "Encrypt recordings" on → `edit-….mp4.enc` (ciphertext on disk); still plays and seeks in the app | ✔ |
| Deleting the meeting's recordings also deletes exported videos | ✔ |
| Media server rejects: no token (404), wrong token (404), foreign Host header (403), path traversal (404), POST (405) | ✔ |

## Media playback fix

Clips are now served from `http://127.0.0.1:<random port>/<per-run secret>/…`, no longer from the `vd-audio://` custom protocol.

Through the custom protocol, Chromium's player:
- failed to seek into a response it had abandoned part-way (`FFmpegDemuxer: data source error`);
- stalled at the end of a short 206 answer without asking for the next range.

Over HTTP, both work: continuous playback, seeking, and audio and video together.
