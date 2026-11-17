# Speaker identification: evaluation evidence

How the numbers in [docs/SPEAKER_ID_AUDIT.md](../../SPEAKER_ID_AUDIT.md) were produced, and the
before/after results. Everything ran offline on the development laptop (Intel i5-1245U, 12
threads, 32 GB RAM, Windows 11), with the same diarizer code the app's speech worker runs.

## How to reproduce

```sh
# test data (dev only, never bundled; ~240 MB, kept in eval-data/, git-ignored)
#   AMI Meeting Corpus test meetings ES2004a, IS1009a, TS3003a (Mix-Headset, CC BY 4.0) with the
#   pyannote AMI-diarization-setup "only_words" reference RTTMs; Mini LibriSpeech dev-clean-2.
node scripts/speaker-eval.mjs synth --libri <LibriSpeech/dev-clean-2> --out eval-data/synth
node scripts/speaker-eval.mjs embed-bench --libri <dev-clean-2> --ami eval-data/downloads/ami --model a.onnx --model b.onnx
node scripts/speaker-eval.mjs run --data eval-data/synth --data eval-data/downloads/ami --models "<models dir>" \
     [--embedding <onnx>] [--threshold 0.5] [--refine --merge 0.4,0.5 --min-cluster 4000] --report out.json
# your own recordings (counts only; decrypted in memory under a temporary profile)
node scripts/speaker-eval.mjs real --appdata "%APPDATA%/Nondh AI" --meetings "<meetings dir>" --models "<models dir>" \
     --embedding <titanet.onnx> --limit 6 --report real.json
```

To score your real meetings against ground truth, correct a meeting's speakers in the app,
export it as **Speaker timeline (.rttm)**, put the RTTM next to a 16 kHz WAV of the same audio,
and pass that folder to `run --data`.

## Test set

| Set | What | Speakers | Purpose |
|---|---|---|---|
| AMI ES2004a, IS1009a, TS3003a | Real meetings, far-field mix, many non-native accents, natural overlap and back-channels | 4 each | Real-world diarization |
| `p2-clean`, `p5-mixed`, `p10-mixed` | Synthetic meetings from LibriSpeech voices, Opus 24 kbps like a conferencing line | 2 / 5 / 10 | Number of participants |
| `acks` | 35 % of turns are 0.3–0.8 s acknowledgements | 4 | "Yes / no / yeah" |
| `long` | Half the turns are 30–90 s monologues | 3 | Long speeches |
| `overlap` | 35 % of turns start before the previous one ends | 4 | Interruptions / overlap |
| `mics` | Each person on a different mic: clean, telephone band, noisy (15 dB SNR), reverberant, laptop, 12 kbps | 6 | Microphone quality |
| `bwswitch` | Each turn randomly wideband or narrowband | 4 | Codec bandwidth switching (hypothesis H1) |
| `x1–x3` | Same people across 3 meetings on different mics | 6 in pool | Recognition across meetings (held out) |
| `y1–y6` | 10 people, 5 per meeting, returning on other mics, newcomers | 10 in pool | Calibrating recognition thresholds |

Not covered yet: Indian-accented English with ground truth. The public set that fits (AI4Bharat
Svarah) needs a Hugging Face account agreement. Your own corrected meetings (RTTM export above)
are the intended source.

Metrics: DER with a 0.25 s collar and overlap scored, split into confusion / miss / false alarm.
"People split" counts true speakers whose speech is spread over more than one speaker found
(each ≥ 10 %). "Clusters mixing people" counts found speakers holding ≥ 10 % of more than one
true speaker. RTF is processing time ÷ audio time.

## Before: the pipeline as shipped (CAM++, sherpa clustering at 0.5)

| File | Audio | People | Speakers found | of which < 5 s | DER | Confusion | Miss | FA | People split | Clusters mixing people | RTF |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ES2004a | 17 min | 4 | 35 | 17 | 59.6% | 49.3% | 8.1% | 2.2% | 4/4 | 1 | 0.274 |
| IS1009a | 14 min | 4 | 36 | 18 | 69.9% | 61.4% | 5.2% | 3.3% | 4/4 | 3 | 0.298 |
| TS3003a | 25 min | 4 | 47 | 30 | 76.9% | 66.4% | 8.0% | 2.5% | 4/4 | 2 | 0.242 |
| acks | 8 min | 4 | 19 | 6 | 59.3% | 55.8% | 0.5% | 3.0% | 4/4 | 2 | 0.271 |
| bwswitch | 8 min | 4 | 12 | 3 | 53.3% | 49.7% | 0.2% | 3.3% | 4/4 | 2 | 0.302 |
| long | 11 min | 3 | 15 | 3 | 70.1% | 67.9% | 0.1% | 2.2% | 3/3 | 1 | 0.264 |
| mics | 10 min | 6 | 26 | 11 | 59.7% | 53.6% | 4.0% | 2.2% | 6/6 | 3 | 0.318 |
| overlap | 8 min | 4 | 25 | 15 | 62.4% | 58.9% | 0.3% | 3.2% | 4/4 | 2 | 0.379 |
| p10-mixed | 15 min | 10 | 35 | 12 | 67.8% | 64.4% | 1.9% | 1.5% | 10/10 | 3 | 0.341 |
| p2-clean | 6 min | 2 | 12 | 2 | 66.5% | 65.0% | 0.5% | 1.1% | 2/2 | 2 | 0.334 |
| p5-mixed | 10 min | 5 | 28 | 13 | 58.6% | 48.1% | 7.9% | 2.7% | 5/5 | 2 | 0.450 |
| x1 | 8 min | 4 | 21 | 13 | 61.4% | 59.4% | 0.4% | 1.5% | 4/4 | 2 | 0.209 |
| x2 | 8 min | 4 | 21 | 5 | 65.3% | 62.3% | 1.6% | 1.4% | 4/4 | 2 | 0.226 |
| x3 | 8 min | 4 | 28 | 16 | 67.4% | 65.2% | 0.5% | 1.7% | 3/4 | 2 | 0.219 |

Means: AMI DER 68.8 % with 35 extra speakers per meeting; synthetic DER 62.9 % with 17.5 extra.
Every person was split in every file. RTF values from the synthetic files were measured while
other work shared the CPU and are upper bounds.

Recognition across meetings today (the user names every speaker after each meeting; later
meetings matched with the shipped rules):

| Series | Named correctly | Named as the wrong person | Known but not recognised | Correctly left unknown |
|---|---|---|---|---|
| x (3 meetings) | 2 | **8** | 33 | 27 |
| y (6 meetings) | 13 | **27** | 32 | 33 |

Voice-matching EER over all trials: 35.7 %.

## Embedding models (why TitaNet-small)

Same-vs-different-speaker EER on fixed-length clips (`embed-bench`; 26 LibriSpeech speakers, 12
AMI meeting speakers), lower is better:

| Model (sherpa-onnx ONNX) | LibriSpeech 1 s | LibriSpeech 3 s | AMI 1 s | AMI 3 s | RTF |
|---|---|---|---|---|---|
| 3D-Speaker CAM++ (was shipped) | 39.7 % | 22.1 % | 43.5 % | 32.7 % | 0.016 |
| WeSpeaker CAM++-LM | 37.3 % | 24.5 % | 40.3 % | 27.4 % | 0.016 |
| WeSpeaker ResNet34-LM | 20.5 % | 6.6 % | 29.0 % | 12.1 % | 0.019 |
| **NeMo TitaNet-small (now shipped)** | **3.3 %** | **0.0 %** | **12.9 %** | **4.0 %** | **0.013** |

Not benchmarked: SpeechBrain ECAPA-TDNN (no sherpa-onnx build; it needs a custom export with a
matching front end, and TitaNet already met the bar), and the pyannote Community-1 and NeMo
diarization pipelines (PyTorch runtimes, not usable offline in the app; Sortformer handles at
most 4 speakers).

## After: TitaNet-small + meeting-level re-clustering (shipped settings)

Settings: sherpa first pass at 0.5, then re-clustering with merge 0.40, minimum 4 s of clear
speech per speaker, and a 5 s overlap veto (`src/shared/meeting/policy.ts`).

| File | Audio | People | Speakers found | DER | Confusion | Miss | FA | People split | Clusters mixing people |
|---|---|---|---|---|---|---|---|---|---|
| ES2004a | 17 min | 4 | 6 | 13.6% | 2.0% | 9.9% | 1.8% | 2/4 | 2 |
| IS1009a | 14 min | 4 | 4 | 17.9% | 8.4% | 7.2% | 2.3% | 3/4 | 2 |
| TS3003a | 25 min | 4 | 5 | 12.0% | 2.1% | 8.1% | 1.8% | 1/4 | 2 |
| acks | 8 min | 4 | 4 | 4.5% | 2.2% | 0.5% | 1.8% | 0/4 | 0 |
| bwswitch | 8 min | 4 | 4 | 3.6% | 0.3% | 0.1% | 3.2% | 0/4 | 0 |
| long | 11 min | 3 | 3 | 5.0% | 3.1% | 0.0% | 1.9% | 0/3 | 0 |
| mics | 10 min | 6 | 7 | 7.8% | 2.1% | 3.9% | 1.8% | 0/6 | 0 |
| overlap | 8 min | 4 | 4 | 3.0% | 0.5% | 0.3% | 2.2% | 0/4 | 0 |
| p10-mixed | 15 min | 10 | 10 | 4.2% | 1.6% | 1.8% | 0.8% | 0/10 | 0 |
| p2-clean | 6 min | 2 | 2 | 1.3% | 0.0% | 0.3% | 0.9% | 0/2 | 0 |
| p5-mixed | 10 min | 5 | 6 | 11.2% | 1.6% | 7.4% | 2.2% | 0/5 | 0 |
| x1 | 8 min | 4 | 4 | 2.2% | 0.4% | 0.4% | 1.4% | 0/4 | 0 |
| x2 | 8 min | 4 | 4 | 4.6% | 2.4% | 1.6% | 0.6% | 0/4 | 0 |
| x3 | 8 min | 4 | 4 | 2.3% | 1.0% | 0.5% | 0.8% | 0/4 | 0 |
| y1 | 6 min | 5 | 5 | 5.9% | 2.7% | 2.5% | 0.7% | 1/5 | 1 |
| y2 | 6 min | 5 | 5 | 2.7% | 0.2% | 0.9% | 1.7% | 0/5 | 0 |
| y3 | 6 min | 5 | 5 | 3.2% | 1.6% | 0.3% | 1.2% | 0/5 | 0 |
| y4 | 7 min | 5 | 5 | 6.5% | 0.6% | 5.5% | 0.5% | 0/5 | 0 |
| y5 | 6 min | 5 | 5 | 1.9% | 0.9% | 0.0% | 1.0% | 0/5 | 0 |
| y6 | 7 min | 5 | 5 | 2.0% | 0.3% | 0.1% | 1.6% | 0/5 | 0 |

### Before → after

| | Before | After |
|---|---|---|
| AMI DER (speaker-time weighted) | 68.8 % | **14.0 %** |
| AMI speaker confusion | 59.0 % | **3.7 %** |
| AMI extra speakers per meeting | +35.3 | **+1.0** |
| Synthetic DER | 62.9 % | **4.5 %** |
| Synthetic extra speakers per meeting | +17.5 | **+0.1** (exact count in 15 of 17) |
| Files where every person was split | 14 / 14 | 0 / 20 |
| Voice-matching EER (cluster vs person) | 35.7 % | **0.45 %** |
| Named as the wrong person, series x (held out) | 8 of 10 named | **0 of 6** |
| Named as the wrong person, series y | 27 of 40 named | **0 of 18** |
| Known people not recognised, x + y | 65 | 1 |

What's left on AMI is mostly **missed speech (7–10 %)**, the same as before: overlap between 3+
people and short back-channels that the pyannote 3.0 segmentation doesn't mark. It is a
segmentation limit, not identity. Synthetic sets are easier than real meetings (read speech,
clean turn-taking), so the AMI rows are the better guide to real calls.

### How the settings were chosen

- **Merge threshold** swept 0.3–0.7 × minimum speech 2–8 s (`titanet-sweep*.json`). The best
  region is 0.35–0.45 × 4–6 s and it is flat; 0.40 / 4 s keeps the "≈ 4 s" short-speaker rule
  and mixes people least.
- **Overlap veto**: at 1 s, overlap "proof" blocked correct merges. sherpa sometimes gives one
  voice two simultaneous turns (one AMI speaker's two fragments overlapped for 2.7 s). AMI DER by
  veto length: 1 s 32.3 %, 2 s 16.0 %, 3 s 15.5 %, 5 s 14.0 %, off 14.0 %. Kept at 5 s.
- **Recognition thresholds** (`calibrate`): profiles from the first ~45 % of each speaker's
  speech, probes of ~6 / 20 / 45 s from the held-out rest. The worst impostor scores were 0.535 /
  0.497 / 0.463 (shorter probes reach higher), so accept = 0.54 / 0.50 / 0.47 (0 false accepts,
  0 false rejects on the probes) and "high" = 0.62 / 0.58 / 0.55 (1.9 % of 6 s probes drop to
  "medium"). Checked independently on the meeting series: in-meeting calibration on series y gives
  0.46 at 1 % false accepts, so the shipped thresholds are stricter than needed there.
- **Voiceprint gate**: single-voice clusters had cohesion 0.74–0.95; most mixed clusters had under
  10 s of clear speech. Saving requires ≥ 10 s and cohesion ≥ 0.70. One mixed AMI cluster (61 s,
  61 % one person) still passes: cohesion alone can't catch every mixed cluster. The UI's
  "Same person as…" and per-line correction cover it.

## Processing time and memory

TS3003a (25 min), measured in a fresh process with nothing cached, 8 threads:

| | Diarization (stage 1) | Re-clustering (stage 2) | Total RTF | Peak memory of the process |
|---|---|---|---|---|
| Before (CAM++) | 327 s | 17 s (legacy cluster embeddings) | 0.229 | 732 MB |
| After (TitaNet-small + re-clustering) | 320 s | 12 s | 0.221 | **1,368 MB** |

Time is unchanged (slightly faster). **Memory is not**: the peak sits inside sherpa-onnx's
diarization pass and grows with meeting length, faster with TitaNet than with CAM++:

| Meeting length | Stage-1 peak, CAM++ | Stage-1 peak, TitaNet-small |
|---|---|---|
| 6 min | 266 MB | 404 MB |
| 25 min | 732 MB | 1,368 MB |

The thread count makes no difference (2, 4 and 8 threads within 10 MB). This is still open.
The proposed fix is to run stage 1 in blocks of about 10 minutes and let the meeting-level
re-clustering join speakers across blocks, which caps the peak at roughly the 10-minute figure
whatever the meeting's length.
