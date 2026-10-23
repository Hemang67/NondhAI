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
| SpeexDSP (Xiph.Org) | BSD-3-Clause | echo cancellation and resampling, compiled into `vd-audio.exe` (`native/third_party/speexdsp/COPYING`) |
| FFmpeg (via ffmpeg-static) | GPL-3.0 (this build) | Opus encoding and audio/video import; run as a separate program. Its license and source offer ship in `node_modules/ffmpeg-static`. Fine for personal use; check the GPL before redistributing the installer. |
| TipTap / ProseMirror | MIT | note editor |
| docx | MIT | Word export |
| marked, DOMPurify | MIT; Apache-2.0 or MPL-2.0 | rendering model answers safely |
| @modelcontextprotocol/sdk, zod | MIT | MCP server |

## Models (downloaded on demand, not bundled)

| Model | License |
|---|---|
| NVIDIA Parakeet (sherpa-onnx int8 exports) | CC-BY-4.0 |
| OpenAI Whisper (ggml conversions) | MIT |
| Qwen3.5 (Alibaba) | Apache-2.0 |
| LFM2.5 (Liquid AI) | LFM Open License |
| Silero VAD | MIT |
| pyannote segmentation 3.0 (sherpa-onnx export) | MIT |
| 3D-Speaker CAM++ voice embeddings | Apache-2.0 |
| BGE small en v1.5 (BAAI) | MIT |
