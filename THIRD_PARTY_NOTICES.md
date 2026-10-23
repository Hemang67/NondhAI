# Third-party notices

## Bundled binaries and libraries

| Component | License | Use |
|---|---|---|
| whisper.cpp (ggml-org) | MIT | local Whisper speech-to-text (`whisper-server`) |
| llama.cpp (ggml-org) | MIT | local LLM (`llama-server`, CPU and Vulkan builds) |
| sherpa-onnx / sherpa-onnx-node (k2-fsa) | Apache-2.0 | Parakeet speech-to-text, Silero VAD, later diarization |
| ONNX Runtime (Microsoft) | MIT | inference runtime used by sherpa-onnx |
| better-sqlite3-multiple-ciphers | MIT | SQLite storage (with optional SQLCipher encryption) |
| Electron, React, Tailwind CSS | MIT | app shell and UI |
| @anthropic-ai/sdk | MIT | optional Anthropic provider |

## Models (downloaded on demand, not bundled)

| Model | License |
|---|---|
| NVIDIA Parakeet (sherpa-onnx int8 exports) | CC-BY-4.0 |
| OpenAI Whisper (ggml conversions) | MIT |
| Qwen3.5 (Alibaba) | Apache-2.0 |
| LFM2.5 (Liquid AI) | LFM Open License |
| Silero VAD | MIT |
