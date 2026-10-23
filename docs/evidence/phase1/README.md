# Phase 1 evidence — dictation (2026-10-23)

Machine: i5-1245U, 32 GB RAM, Intel Iris Xe (no CUDA), Windows 11 Pro 26300.

## How it was tested

End-to-end in the real app (`npm run dev`), with two test-only switches so no person had to be at the keyboard:

- `NONDH_FAKE_MIC=<wav>`: Chromium's fake audio device plays a WAV file into `getUserMedia` (the clips are Windows text-to-speech).
- `NONDH_E2E=1`: the native key hook accepts synthetic key presses. A PowerShell script focuses the target app, holds Ctrl+Win for the length of the clip, and releases it.

Everything after the microphone is the real path: native hook → hotkey state machine → recorder → Parakeet (streamed, VAD-split) → cleanup → clipboard + Ctrl+V → clipboard restore → history.

## Results

`latency` = release of the hotkey → text pasted. Engine: Parakeet Unified EN 0.6B int8, 8 threads.

| Target | Spoken (≈6 s) | Pasted | Latency |
|---|---|---|---|
| Win32 text box | "Um, let's meet on Tuesday, no, Wednesday at three to review the pricing deck with Priya." | Let's meet on Wednesday at 3 to review the pricing deck with Priya. | 241 ms |
| Chrome (textarea) | same | same | 278 ms |
| VS Code (editor) | same | same | 618 ms |
| Win32 text box | "Things to buy for the offsite, first coffee, second name badges, third a projector cable." | Things to buy for the off-site:<br>1. Coffee<br>2. Name badges<br>3. A projector cable | 370 ms |
| Win32 text box (translate hotkey) | same list | (Spanish, via local Qwen3.5 2B) | 7.5 s |

- Clipboard: set to a sentinel before each Chrome/VS Code run; after the paste it was the sentinel again.
- Screenshots: `win32-textbox.png`, `chrome.png`.
- Raw log lines: `dictation-log.txt`. Read it with these notes:
  - The 06:44 line logged `app=Notepad`. Notepad grabbed focus while it was still loading and the paste went nowhere; none of the open Notepad tabs were changed (checked through UI Automation).
  - The 06:46 list run (5.0 s, `llm=true`) came before the rule-based list formatter. With it, the same clip takes 370 ms (06:48).
  - The 06:49 translate run pasted English text after the model's output was rejected. That was a bug: a failed translation now pastes nothing and shows "Translation failed". The translation prompt was also rewritten; 06:52 is a correct translation.
  - The `aborted` lines at 06:51–06:53 were real key presses (vk 0xC0) during the hold. Any other key while the chord is held cancels, by design.

## Local LLM measurements (cleanup/translation)

llama-bench, Q4_K_M:

| Model | Backend | Prompt t/s | Gen t/s |
|---|---|---|---|
| Qwen3.5 2B | CPU (8 threads) | 54 | 10.3 |
| Qwen3.5 2B | Vulkan (Iris Xe) | 219 | 11.3 |
| LFM2.5 1.2B | CPU | 83 | 23.0 |
| LFM2.5 1.2B | Vulkan | 437 | 26.4 |

LFM2.5 is faster, but in a 6-case cleanup check it answered or dropped text in 4 cases. Qwen3.5 2B followed the rules. Default: Qwen3.5 2B on Vulkan, used only when the instant rules can't handle the text ("auto").

## Not yet verified on this machine

- Slack: I didn't paste into your real Slack workspace. Please try it yourself.
- A real microphone and a human voice (the hotkey is real; the audio came from a file).
- Double-tap "lock" mode, the Whisper engine inside the app (the server API was checked on its own: 1.1 s for the 6 s clip with base.en), model download from the Models page, cloud speech-to-text and cloud cleanup (no API keys saved yet).
- Start at login: only applies to the installed build (Phase 4 packaging).
