# Speaker identification: audit and improvement plan

Written 2026-11-17 against `main` @ b655a59. **Status: phases 0–5 implemented** on branch
`feat/speaker-id`; results in [evidence/speaker-id](evidence/speaker-id/README.md).

| | Before | After |
|---|---|---|
| AMI real meetings: DER / extra speakers per meeting | 68.8 % / +35 | 14.0 % / +1 |
| Synthetic meetings (2–10 people, acks, overlap, mics): DER / extra speakers | 62.9 % / +17.5 | 4.5 % / +0.1 |
| Voice-matching EER | 35.7 % | 0.45 % |
| Wrong names across meetings (2 series) | 35 of 50 names | 0 of 24 |

What changed against this plan while implementing it:
- **R0 was found in Phase 0**: the embedding model itself was the deepest cause, so the model
  benchmark (planned as Phase 5) ran first, and the app now uses TitaNet-small.
- **Cannot-link is a 5 s veto, not 1 s**: sherpa sometimes gives one voice two simultaneous
  turns, and a 1 s veto blocked correct merges (AMI DER 32 % → 14 % when fixed).
- **Open: memory.** Processing time is unchanged, but sherpa's diarization pass peaks higher with
  TitaNet and grows with meeting length (25 min: 1.37 GB vs 0.73 GB). Proposed fix: run stage 1
  in ~10-minute blocks and let the meeting-level re-clustering join speakers across blocks.
- **Not done** (optional, no evidence they matter yet): R11 energy gate for one-word echoes, R12
  capture-drift instrumentation, calendar attendee count as a speaker-count ceiling, detecting
  the user's own voice on the system track. Indian-accented English with ground truth needs your
  corrected meetings (Speaker timeline export) or a gated dataset.

## TL;DR

- Diarization is **not** done per audio chunk. After the call, one global pass runs over the whole
  system track (calls) or the mixed track (room/import). The "too many speakers" problem happens
  *inside* that global pass. sherpa-onnx turns every (10 s window, local speaker) pair into a CAM++
  embedding, some from as little as ~0.17 s of speech. It then clusters them with **complete
  linkage** and **no minimum cluster size**. Every outlier embedding (a "yes", a codec glitch, a
  burst of crosstalk) becomes a new, permanent speaker.
- The app's own log confirms it. Recent calls produced a new cluster every ~15–40 s of audio:
  **16 speakers in a 3.7-minute call, 44 in a 21-minute call.** The cluster count grows with call
  length, not with the number of people. That pattern points to over-splitting, not to real
  participants.
- Cross-meeting naming makes the split worse. Each person can be given to only one cluster, so the
  second fragment of a known person is matched to the *next-best* known person, if that one scores
  above an uncalibrated 0.55. That produces false identities.
- The confusing speaker list has a separate, simple cause. Speakers are sorted by their database
  key as text (`c0, c1, c10, c11, c2 … me`). "Speaker N" numbers are also given out before empty
  clusters are dropped, which leaves gaps.
- Plan: (0) build an evaluation harness and baseline. (1) Fix the UI ordering and the word mapping.
  (2) Add a meeting-level re-clustering stage after sherpa, with clean-speech embeddings, average
  linkage, cannot-link constraints and small-cluster reassignment. (3) Add calibrated multi-sample
  voice profiles. (4) Add a manual merge/correct UI. (5) Benchmark alternative embedding models,
  and swap only if the numbers justify it.

---

## 1. How it works today

```
vd-audio.exe (WASAPI)                                   speechWorker (utilityProcess, sherpa-onnx)
  mic  (eCommunications default) ─► 16 kHz mono ─► mic.pcm ─┐
  loopback (eConsole default)     ─► 16 kHz mono ─► system.pcm┤   live: Silero VAD → Parakeet → "Me"/"Others"
  [speex AEC on mic, 300 ms tail]  lock-step 10 ms frames     │
                                                              ▼  after stop (MeetingService.process)
                         final pass: VAD → Parakeet per segment → words with timestamps   (per track)
                         diarize(system.pcm | mixed.pcm):
                           sherpa OfflineSpeakerDiarization
                             pyannote-seg-3.0 on 10 s windows → local speakers per window
                             CAM++ embedding per (window, local speaker)       ← ≥10 frames (~0.17 s)
                             complete-linkage AHC, cosine distance, cut at 0.5 ← no min cluster size
                             → turns {start,end,cluster}
                           + one CAM++ embedding per cluster (turns ≥ 800 ms, ≤ ~60 s, concatenated)
                         assembleTranscript:
                           call: mic words → "me" (after text echo removal); system words → cluster by word midpoint
                           room/import: enrolled voice picks the "me" cluster; rest matched to people
                           labelClusters: greedy, one person per cluster, accept ≥ 0.55, else "Speaker N"
                         → meeting_lines, meeting_speakers (+ cluster embedding)
rename in UI → people + voiceprints (cluster embedding, newest 8 per person)
```

## 2. Evidence from this machine

From `%APPDATA%\Nondh AI\logs\nondh.log` (counts only; no transcript content was read). All of
these are calls, diarized on the system track:

| Call length | Clusters from diarizer | Speakers shown (had words) | Turns | Diarize time |
|---|---|---|---|---|
| 3.7 min | 16 | 15 | 70 | 37 s |
| 5.7 min | 19 | 19 | 108 | 173 s |
| 7.9 min | 12 → **13 on re-process** | 12 → 11 | 94 → 95 | 111 s |
| 9.9 min | 18 | 16 | 147 | 134 s |
| 16.8 min | 33 | 32 | 401 | 256 s |
| 19.1 min | 36 | 32 | 403 | 202 s |
| 21.2 min | 44 | 38 | 437 | 386 s |

Observations:
- The cluster count scales with duration, which is the signature of a length-dependent over-split.
- "Clusters" minus "speakers shown" is the number of clusters that got no words. Those clusters
  still used up a "Speaker N" number, which explains the gaps (Speaker 1, 3, 4…).
- The same audio re-processed after the Opus round-trip gave a different cluster count. The
  clustering is unstable near its threshold.
- `docs/evidence/phase2/README.md` already recorded JFK being over-split into 3 clusters in a
  2-voice file.

I did **not** decrypt or analyse the meeting recordings themselves. They are encrypted at rest
with the app's DPAPI key. Phase 0 runs the per-cluster analysis inside the app, if you agree.

## 3. Root causes

Ranked by how much each one contributes to the symptoms you reported. Impact: H/M/L.

### R0 — The CAM++ embedding barely separates people (found in Phase 0) — **H, the deepest cause**
- **Where:** [registry.ts](../src/main/models/registry.ts) (`campplus-speaker-embedding`), used by
  sherpa's clustering and by every cross-meeting match.
- **Measured** (`scripts/speaker-eval.mjs embed-bench`; 26 LibriSpeech speakers, 12 AMI meeting
  speakers; same-vs-different-speaker EER, lower is better):

  | Model (sherpa-onnx ONNX) | LibriSpeech 1 s | LibriSpeech 3 s | AMI 1 s | AMI 3 s | CPU (RTF) |
  |---|---|---|---|---|---|
  | 3D-Speaker CAM++ (shipped) | 39.7 % | 22.1 % | 43.5 % | 32.7 % | 0.016 |
  | WeSpeaker CAM++-LM | 37.3 % | 24.5 % | 40.3 % | 27.4 % | 0.016 |
  | WeSpeaker ResNet34-LM | 20.5 % | 6.6 % | 29.0 % | 12.1 % | 0.019 |
  | **NeMo TitaNet-small** | **3.3 %** | **0.0 %** | **12.9 %** | **4.0 %** | **0.013** |

- **Why it breaks:** CAM++ vectors share a large common component (the mean vector is 0.84–0.92
  of a typical embedding's length). Raw cosine therefore puts different people at a median of
  0.75 and the same person at 0.86. A cluster of "one person" ends up holding several voices,
  while one person's short windows fail to link up. The fixed 0.55 match threshold accepts
  almost anyone. Both CAM++ builds behave the same, so this is not one bad export.
- **Also measured:** the embedding is gain-invariant (×0.1 → cos 0.998), so loudness
  normalisation is unnecessary. Silence is not neutral: 2 s of padding on each side of 4 s of
  speech → cos 0.93. That confirms R7 (silence in enrollment).
- **Fix:** switch the voice model to TitaNet-small (40 MB, already published by sherpa-onnx, the
  same runtime). Re-calibrate all thresholds for it. Re-derive named people's voices from
  retained meeting audio (old samples can't be converted between models).

### R1 — Complete-linkage clustering over tiny window embeddings (fragmentation) — **H**
- **Where:** [speechWorker.ts `diarize()`](../src/main/speech/speechWorker.ts#L186-L195) →
  sherpa-onnx `OfflineSpeakerDiarization` (`fast-clustering.cc`,
  `offline-speaker-diarization-pyannote-impl.h`); threshold set in
  [speechService.ts `diarize()`](../src/main/speech/speechService.ts#L210).
- **Today:** sherpa embeds every (10 s window, local speaker) pair that has ≥ 10 frames (~0.17 s)
  of non-overlapped speech. It clusters all of them with `HCLUST_METHOD_COMPLETE` on cosine
  distance and cuts at 0.5 (the worker default of 0.6 is overridden by the service).
- **Why it breaks:** complete linkage merges two groups only when their *least* similar pair is
  within the threshold. One speaker contributes hundreds of window embeddings, and many of them
  come from < 1 s of speech, codec bandwidth switches or crosstalk. So there is almost always one
  bad pair, and the groups never merge. Longer meetings mean more embeddings, more bad pairs and
  more clusters, which matches the log.
- **Fix:** keep sherpa for segmentation and first-pass clustering, and treat its output as
  **deliberately over-segmented**. Add a meeting-level second stage (Phase 2, §4). It re-embeds
  only clean speech of ≥ 1 s, merges with **average linkage** over cluster-level evidence, uses
  cannot-link constraints from detected overlap, and folds small clusters into large ones. The
  stage-1 threshold and the stage-2 merge threshold are calibrated on the evaluation set, not
  guessed.
- **Expected impact:** the largest single improvement in speaker count. Target: shown speakers
  ≤ true speakers + 1 on ≥ 90 % of evaluation meetings. Cost: tens of seconds of extra CAM++ time
  on a 20-minute call, against the 200–400 s diarization takes today.

### R2 — Every cluster becomes a speaker; no minimum size or reassignment — **H**
- **Where:** [speakers.ts `labelClusters()`](../src/shared/meeting/speakers.ts#L59-L84),
  [assemble.ts](../src/shared/meeting/assemble.ts#L36-L56); sherpa has no `min_cluster_size`.
- **Today:** a cluster made of a single 0.4 s "yes" gets its own "Speaker N". pyannote's own
  pipeline reassigns small clusters to the nearest large centroid; the sherpa port leaves that
  step out.
- **Why it breaks:** short acknowledgements become separate identities, which is exactly the
  "Yes/No/Yeah" symptom.
- **Fix:** a cluster with too little clean speech can never become a speaker by itself (Phase 2).
  Its turns are reassigned to the best large cluster by embedding similarity. When the evidence is
  weak, the line is flagged `speaker?` instead of getting a new ID. Adjacency in time is **never**
  used as merge evidence.
- **Expected impact:** H on spurious IDs. Trade-off: someone who speaks for less than ~4 s in the
  whole meeting gets folded into another speaker with a `speaker?` flag rather than getting their
  own ID. One click fixes it, and a voice that short can't be identified reliably anyway.

### R3 — Cluster profile embedding: hard 800 ms gate, overlap not excluded — **M**
- **Where:** [speechWorker.ts `diarize()`](../src/main/speech/speechWorker.ts#L197-L230).
- **Today:** one embedding per cluster, taken from the longest turns (≥ 800 ms, up to ~60 s)
  concatenated together. If every turn is < 800 ms, the embedding is `null` and the cluster can
  never be matched to a known person. Turns are used whole, including stretches where another
  diarized speaker overlaps.
- **Why it breaks:** long turns are exactly where other people back-channel, so the profile picks
  up their voice. That embedding is then saved as a voiceprint when you name the speaker (R6).
  Null embeddings force "Speaker N".
- **Fix:** compute several embeddings per cluster on clean 3–6 s pieces: overlapped regions
  removed, 100 ms trimmed from each edge, sampled across the whole meeting rather than only the
  longest turns. Combine them into a duration-weighted mean of L2-normalised vectors, plus a
  **cohesion** score (mean similarity of the pieces to the centroid) used as a quality signal.
- **Expected impact:** M. Cleaner profiles, fewer contaminated voiceprints, and a quality number
  to gate on.

### R4 — One-person-per-cluster greedy naming assigns fragments to the wrong people — **H (false IDs)**
- **Where:** [speakers.ts `labelClusters()`](../src/shared/meeting/speakers.ts#L59-L77).
- **Today:** clusters claim people strongest-first, and a claimed person is removed from the pool.
- **Why it breaks:** combined with R1, Priya's second fragment can't be Priya, so it is matched
  against everyone else. It becomes "Mark" if Mark scores ≥ 0.55. Correct fragmentation thus turns
  into a false identity.
- **Fix:** score every cluster against every person, then assign with an explicit "unknown"
  option. When two clusters both match the same person, have no cannot-link between them, and
  both pass the calibrated threshold, **merge** them (identity-guided merge). Never reassign a
  fragment to the next person.
- **Expected impact:** H on false identity matches whenever voiceprints exist.

### R5 — Uncalibrated thresholds; margin ignored for acceptance; max over samples — **H (false IDs)**
- **Where:** [speakers.ts `MATCH` / `matchVoice()`](../src/shared/meeting/speakers.ts#L40-L52);
  room-mode "me" in [assemble.ts](../src/shared/meeting/assemble.ts#L61-L74).
- **Today:** a fixed 0.55 accept threshold. The best-vs-second-best margin only changes the label
  from "high" to "medium" and never rejects a match. A person's score is the **max** over all
  their samples.
- **Why it breaks:** the max over N samples rises with N, so people with more saved samples steal
  more matches. The same threshold is applied to a 5 s cluster and a 5-minute cluster, even
  though short-cluster embeddings are far noisier. None of it was tuned on real meeting audio.
- **Fix:** score = weighted mean of the top-k sample similarities (k ≤ 3, weighted by sample
  quality); I'll benchmark this against person-centroid scoring and keep whichever has the lower
  error rate. Accept thresholds are **calibrated per cluster-duration bucket** (4–10 s, 10–30 s,
  30 s+) to a target false-accept rate on impostor trials from the evaluation set. The margin
  becomes a hard acceptance condition, and the confidence level comes from calibrated score plus
  margin.
- **Expected impact:** H on false matches; a modest rise in "unknown" for short clusters (by
  design).

### R6 — Voiceprints saved without quality checks — **M**
- **Where:** [ipc.ts `meetings:renameSpeaker`](../src/main/ipc.ts#L232-L249),
  [meetings.ts `addVoiceprint()`](../src/main/storage/meetings.ts#L366-L377).
- **Today:** every rename stores that cluster's embedding, whatever its duration or purity. The
  newest 8 meeting samples are kept per person.
- **Why it breaks:** one contaminated or tiny cluster poisons a person's profile, and later
  meetings inherit the error (the phase-2 evidence shows "Phoebe" absorbing JFK). Keeping only
  the newest 8 throws away good old samples in favour of bad new ones.
- **Fix:** save only when clean speech ≥ ~10 s and cohesion passes (both calibrated), and store
  `quality` and `speech_ms` with each sample (migration 6). Keep up to N per person, chosen by
  quality and diversity, and average near-duplicates. The UI says "voice saved" or "not enough
  clear speech to remember this voice".
- **Expected impact:** M on cross-meeting consistency over time.

### R7 — Enrollment audio doesn't match meeting audio — **M (room/import mode)**
- **Where:** [PeoplePage.tsx `Enrollment`](../src/renderer/src/pages/PeoplePage.tsx#L55-L105) →
  [recorder.ts](../src/renderer/src/recorder.ts#L34-L36) →
  [ipc.ts `people:enroll`](../src/main/ipc.ts#L331-L340).
- **Today:** enrollment records through Chromium `getUserMedia` with **noise suppression and AGC
  on**, from Chromium's default device. Meetings record raw WASAPI (no noise suppression or AGC)
  from the **communications** default device, which can be a different microphone. The whole
  recording, silences included, goes into one embedding.
- **Why it breaks:** a channel and processing mismatch lowers same-speaker similarity, so "me" is
  missed in room recordings or lands on the wrong cluster. Silence frames dilute CAM++'s
  statistics pooling.
- **Fix:** turn off noise suppression and AGC for enrollment, trim with VAD, and average embeddings
  over 3–6 s windows. Better still, also allow **"This is me"** on any room-meeting speaker; that
  sample comes from real meeting audio.
- **Expected impact:** M for in-person and imported meetings; none for calls (the mic channel
  already identifies you there).

### R8 — Word-to-speaker mapping jitters at turn boundaries — **M**
- **Where:** [words.ts `tokensToWords()`](../src/shared/meeting/words.ts#L8-L27),
  [speakers.ts `clusterAt()` / `linesFromSegments()`](../src/shared/meeting/speakers.ts#L87-L163).
- **Today:** a word's end is set to the *next word's start*, so trailing pauses count as part of
  the word, and the last word in a segment is stretched to 200–1200 ms. The speaker is chosen at
  the word's **midpoint**, so a word followed by a pause is placed partly in the next person's
  turn. When turns overlap, `active[0]` (array order) wins rather than the largest overlap. There
  is no smoothing, and unmatched words get the key `"unknown"`, which isn't a real speaker row.
- **Why it breaks:** the first or last word of a sentence flips to the neighbouring speaker. That
  creates one-word lines and "same person, two IDs" runs.
- **Fix:** estimate each word's span from its token count (Parakeet frames are 80 ms), capped at
  the next word's start. Assign by **largest temporal overlap** with turns. Apply conservative
  smoothing: a one-word run under 500 ms, whose own turn is under 500 ms and which sits between
  two runs of the same speaker, takes the surrounding speaker and is flagged `speaker?`. Words
  with no turn nearby take the segment's majority speaker and are flagged, instead of `"unknown"`.
- **Expected impact:** M on word-level speaker accuracy and line fragmentation. Negligible CPU
  (also replaces the current O(words × turns) scan with a sweep).

### R9 — Speaker list order, numbering gaps, "Unknown" — **H (the "confusing order" symptom)**
- **Where:** [meetings.ts `speakers()`](../src/main/storage/meetings.ts#L225) (`ORDER BY
  speaker_key`), [speakers.ts `labelClusters()`](../src/shared/meeting/speakers.ts#L78-L82),
  [assemble.ts filter](../src/shared/meeting/assemble.ts#L56),
  [MeetingsPage.tsx](../src/renderer/src/pages/MeetingsPage.tsx#L423).
- **Today:** speakers are sorted by key as text (`c0, c1, c10, c11, c2, …, me, others`). Cluster
  ids from sherpa are not in first-appearance order. "Speaker N" is assigned before clusters with
  no words are removed. `"unknown"` lines can't be renamed or picked in the per-line menu.
- **Fix:** order speakers as **Me first, then by first line**. This is done in the query, so
  existing meetings are fixed without re-processing. Number "Speaker N" only over speakers that
  have lines, in chronological order. Unassigned words get a real speaker row ("Unassigned"),
  which can be renamed and reassigned.
- **Expected impact:** fixes the ordering symptom outright; no cost.

### R10 — Re-processing uses Opus-decoded audio — **L**
- **Where:** [audioFiles.ts `encodeOpus` / `restorePcm`](../src/main/meeting/audioFiles.ts#L19-L44).
- **Today:** after processing, only Opus at 24–32 kbps (VoIP mode) is kept, and re-processing
  decodes it again. The log shows 12 → 13 clusters for the same call.
- **Fix:** no format change. Make the clustering robust (R1, R2) so small acoustic changes don't
  flip decisions, and record the audio source with each voiceprint so the evaluation can measure
  any PCM-vs-Opus shift.
- **Expected impact:** L.

### R11 — One-word echoes on the mic stay labelled "Me" — **L**
- **Where:** [echo.ts](../src/shared/meeting/echo.ts#L19) (`minRun: 2`).
- **Today:** text echo removal needs ≥ 2 matching words, on purpose, so a real "yes" from you isn't
  dropped. A leaked one-word "yes" from the far end therefore appears twice, once as Me.
- **Fix (optional, Phase 6):** an energy gate for single-word matches. Drop the mic word only when
  the mic is much quieter than the system track at that moment and the text matches. Only on
  speakers (not headphones), and only with evaluation evidence.
- **Expected impact:** L; affects speaker-mode setups only.

### R12 — Track alignment edge cases — **L, to verify**
- **Where:** [vd-audio.c main loop](../native/vd-audio/vd-audio.c#L391-L402).
- **Today:** the loopback track is padded with silence when it is > 150 ms behind the wall clock.
  If the real packets then arrive, they are appended after the padding, so the system track runs
  late by that amount from then on. Clock drift between devices isn't measured.
- **Why it matters:** this does not affect diarization (one track). It affects echo matching
  (2.5 s window) and overlap flags across tracks.
- **Fix:** Phase 0 logs `mic.samplesOut`, `sys.samplesOut` and the wall clock at stop. Fix only if
  drift > ~200 ms shows up.

### H1 — Hypothesis: codec bandwidth switching splits one person into several clusters
Teams, Meet and Zoom switch between wideband and narrowband when the network changes. The same
voice then looks spectrally different, which CAM++ can turn into separate clusters, and complete
linkage won't join the two modes. This is unverified. Phase 0 logs per-turn high-band energy
(> 4 kHz) per cluster to confirm or rule it out. If confirmed, stage-2 merging handles it, because
average linkage tolerates two modes.

### Checked and working correctly
- The mic and system tracks are captured separately and stay in lock step. In calls, "Me" comes
  from the mic channel, not from voice matching, and that part is reliable.
- Remote speakers are diarized from the system track only, and room/import from the mixed track.
- Resampling: speex quality 5 to 16 kHz, channels averaged to mono. CAM++, pyannote and Parakeet
  all receive 16 kHz mono float in [-1, 1].
- Gain: CAM++'s filterbank features are mean-normalised, so loudness differences barely matter.
  No extra normalisation is needed, apart from logging clipping.
- sherpa excludes overlapped frames from *its own* window embeddings (R3 concerns NondhAI's
  separate per-cluster embedding).
- Cosine maths is correct. Means should be taken over **L2-normalised** vectors; `meanVector()` is
  currently unused.
- Transcript lines never create identities. IDs come only from clusters, so splitting into
  sentences or chunks doesn't add speakers. It only causes the word-boundary jitter covered in R8.

---

## 4. Proposed architecture (offline pass only; live view unchanged)

```
sherpa OfflineSpeakerDiarization (unchanged lib, stage 1, tuned to over-segment)
        │ raw turns {start,end,c}
        ▼
[new] src/shared/meeting/diarization/refine.ts   (pure TS, unit-tested; embeddings injected)
  1. clean pieces per raw cluster: turns − overlap with other clusters, trim 100 ms, keep ≥ 1 s,
     split into 3–6 s, ≤ ~40 s per cluster sampled across the meeting
  2. embed pieces (worker's single CAM++ extractor) → L2-normalise
  3. cluster stats: centroid (duration-weighted), cohesion, cleanMs, firstMs, talkMs
  4. large = cleanMs ≥ L_min (calibrated, ~4 s); small = the rest
  5. average-linkage AHC over large clusters, stop at τ_merge (calibrated)
       cannot-link: clusters with ≥ 1 s of simultaneous speech (pyannote saw both at once)
       optional ceiling: calendar attendee count (stops merging early, never forces merges)
  6. small clusters → best large cluster by embedding (≥ 1 s) with margin; weak → flag uncertain
  7. relabel 0..K-1 by first substantial appearance
        │ refined turns + clusters {centroid, pieces[], cleanMs, cohesion, firstMs, talkMs}
        ▼
[changed] speakers.ts identity matching
  score(cluster, person) = quality-weighted top-k mean   (vs. centroid: chosen by EER)
  accept iff score ≥ τ(duration bucket) AND margin ≥ m  (both calibrated)
  one-to-many allowed → identity-guided merge of fragments (respecting cannot-link)
  confidence from calibrated score + margin; otherwise "Speaker N" (numbered after line assignment)
        ▼
[changed] word mapping (overlap-based, smoothed) → lines → meeting_speakers (ordered by first line)
```

Kept as-is: model management and registry, the worker protocol style, the SQLite repos, the live
transcript, the capture binary, the ASR pass and summaries.

## 5. Implementation phases

Each phase is small, ships with tests, and is evaluated before the next one starts.

### Phase 0 — Measure first (no behaviour change)
- `src/shared/meeting/eval/der.ts`: DER (0.25 s collar, overlap scored) using Hungarian mapping;
  confusion, miss and false-alarm split; fragmentation and purity; word-level speaker accuracy;
  identity metrics (false-accept, false-reject, EER, unknown rate). Pure TS, unit-tested.
- `scripts/eval-diarization.mjs`: runs the **same** worker code path in plain Node (sherpa-onnx-node
  is N-API) over a folder of `*.wav` + `*.rttm`. Records RTF and peak RSS, and writes a JSON and
  Markdown report to `docs/evidence/speaker-id/`.
- `scripts/make-eval-set.mjs`: builds synthetic conversations from single-speaker clips with
  ffmpeg: 2/5/10 speakers, 0.3–0.8 s acknowledgements, long monologues, 10–30 % overlap,
  interruptions, Opus 24 k / telephone band-pass / SNR 10–20 dB / reverb, and the same speakers
  across several "meetings".
- Export RTTM from a meeting (`export.ts`), so a meeting **you correct in the UI** becomes ground
  truth. This is how real recordings, including Indian-accented English, enter the evaluation
  without anyone hand-labelling audio.
- Worker log: per-cluster speech duration, turn count and high-band ratio (H1); vd-audio drift at
  stop (R12).
- **Output:** baseline report for the current pipeline.

### Phase 1 — Low-risk fixes (R8, R9)
- `meetings.ts speakers()`: order Me first, then by first line.
- `speakers.ts`: overlap-based word assignment, smoothing, no `"unknown"` key;
  `labelClusters` numbering runs after line assignment.
- `words.ts`: bounded word spans.
- `assemble.ts`: chronological "Speaker N" with no gaps; "Unassigned" speaker row.
- Tests: extend `meetingSpeakers.test.ts`, `meetingAssemble.test.ts`; legacy-ordering test in
  `meetingRepo.test.ts`.

### Phase 2 — Meeting-level re-clustering (R1, R2, R3)
- New `refine.ts` (§4). The worker returns raw turns plus piece embeddings; refinement runs in the
  worker; the protocol gains `pieces`, `cleanMs`, `cohesion`, `talkMs`.
- One CAM++ extractor shared by refinement and enrollment (today two are loaded).
- Calibrate stage-1 threshold, `τ_merge` and `L_min` on the evaluation set; record the curves in
  the report.
- Tests: synthetic embedding fixtures (two modes of one speaker merge; overlapping speakers don't;
  a 0.5 s cluster is absorbed; adjacency alone never merges).

### Phase 3 — Voice profiles and calibrated matching (R4, R5, R6, R7)
- `speakers.ts`: new scorer, per-bucket thresholds, margin gate, assignment with unknown, and
  identity-guided merge.
- Migration 6 (additive, §6). `PeopleRepo`: quality-aware retention and dedupe.
- `ipc.ts`: gate voiceprint saving on rename; VAD-trimmed windowed enrollment. `recorder.ts`: an
  option to turn off noise suppression and AGC (enrollment only; dictation unchanged).
- Calibrate per-bucket thresholds to a target false-accept rate (proposal: 1 %) from
  cross-meeting trials.

### Phase 4 — Correction UI (same visual design, existing `Card` / `Badge` / `Button`)
- SpeakersPanel: **Merge into…** (re-keys lines, deletes the merged row, recomputes the
  centroid). Renaming a speaker to a name already used in the meeting offers to merge.
- A confidence badge on each speaker row; "voice saved" or "not enough clear speech". In room
  meetings: **This is me**.
- People page: sample count and quality per person; remove a single sample.

### Phase 5 — Model benchmark (§7); adopt only on clear wins

### Phase 6 — Optional, evidence-driven: R11 energy gate, R12 alignment fix, system-track
"my voice leaked in" detection.

## 6. Database changes (migration 6, additive only)

```sql
ALTER TABLE voiceprints      ADD COLUMN quality   REAL;     -- 0..1; NULL = legacy, default weight
ALTER TABLE voiceprints      ADD COLUMN speech_ms INTEGER;  -- clean speech behind the sample
ALTER TABLE meeting_speakers ADD COLUMN first_ms  INTEGER;  -- chronological order
ALTER TABLE meeting_speakers ADD COLUMN talk_ms   INTEGER;
ALTER TABLE meeting_speakers ADD COLUMN margin    REAL;     -- best − second-best person score
```

No rows are rewritten and no columns dropped; existing meetings and voiceprints keep working.
Ordering also works for meetings processed before the migration, because it falls back to the
first line.

## 7. Model evaluation

Every candidate below loads through the **existing** `SpeakerEmbeddingExtractor` /
`OfflineSpeakerDiarization` and model registry, unless noted otherwise. Downloads are for the
benchmark machine only; nothing new ships unless it wins.

| Candidate | Fits current runtime? | Notes | Plan |
|---|---|---|---|
| 3D-Speaker CAM++ (current) | yes | 28 MB, fast | baseline |
| WeSpeaker ResNet34-LM | yes (sherpa ONNX) | the embedding family pyannote's pipelines use | benchmark |
| NVIDIA NeMo TitaNet (small/large) | yes (sherpa ONNX) | the practical NeMo component | benchmark |
| SpeechBrain ECAPA-TDNN | needs a custom ONNX export plus sherpa metadata, with a matching filterbank front end | risky to get exactly right | only if the above don't beat CAM++ |
| pyannote **Community-1** pipeline | reference code is PyTorch | powerset segmentation, WeSpeaker embeddings, **VBx** clustering; CC BY 4.0 | run in Python as an offline upper bound; port what wins (embedding via ONNX; VBx in TS if Phase-2 AHC falls short) |
| NeMo diarization (MSDD / Sortformer) | no (NeMo/PyTorch runtime) | Sortformer models handle up to 4 speakers, so they fail the 5/10-person requirement | reference only |

Adoption bar: lower DER **and** lower false-accept rate at equal unknown rate on the real-meeting
subset, with RTF and RAM within about +20 %. **Caveat:** voiceprints are model-specific (the
`model` column). Switching the embedding model means re-deriving samples from retained meeting
audio for confirmed speakers, or re-enrolling. The cost of that is part of the decision.

## 8. Test plan

| Scenario | Source | Key metrics |
|---|---|---|
| 2 / 5 / 10 participants | synthetic + AMI / VoxConverse subsets + your corrected meetings | DER, confusion, hyp/ref speaker count |
| Short acknowledgements | synthetic 0.3–0.8 s inserts | spurious-speaker rate, word-level accuracy |
| Long speeches | synthetic monologues, real meetings | fragmentation (splits per true speaker) |
| Interruptions / overlap | synthetic 10–30 % overlap | DER (overlap scored), overlap flag precision |
| Indian-accented English | your corrected meetings; synthetic built from an Indian-English speech corpus | all of the above, reported separately |
| Mic quality | ffmpeg band-pass, Opus, noise, reverb variants | DER and identification drift per condition |
| Same person across meetings | same speakers, different conditions | false-accept, false-reject, EER, unknown rate |
| Latency | all | diarize + refine RTF, peak RSS of the worker |

Unit tests (vitest) cover the DER metric, refinement, word mapping, the scorer and calibration
helpers, migration 6, and repo merge. Synthetic sets are easier than real meetings, so the report
always shows real and synthetic results side by side.

## 9. Performance

| Change | CPU | RAM |
|---|---|---|
| Stage-2 refinement | + CAM++ on ≤ ~40 s per cluster plus small-cluster audio: about +5–15 % of current diarize time | ≈ 0; one extractor shared (−1 CAM++ instance) |
| AHC over clusters | negligible (K ≤ ~50) | negligible |
| Word-mapping sweep | faster than today | — |
| Matching / profiles | negligible | negligible |

Today the system-track final pass (ASR) is the largest processing cost: 580 s for a 21-minute
call. That is out of scope here, but the evaluation report will show it alongside the speaker
work.

## 10. Decisions needed before implementation
1. **Real recordings:** may the evaluation decrypt and analyse your stored meetings *inside the
   app* (results stay local; only statistics go into the report)? Could you correct 2–3 meetings
   in the UI so they become ground truth?
2. **Dev-only downloads:** public evaluation audio (AMI / VoxConverse subsets, a few hundred MB)
   and 2–3 candidate embedding models (tens of MB each), on the dev machine only, never bundled.
3. **Short-speaker trade-off:** is it acceptable that someone with < ~4 s of total speech is folded
   into another speaker with a `speaker?` flag rather than given their own ID?
