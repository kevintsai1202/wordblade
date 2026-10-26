# WordBlade

Cut lecture videos by editing words, Resolve-style, with subtitles, privacy masking and voice fixes powered by Meta's models.

Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Indie Developer track, Oct 26 – Nov 4, 2026).

> Status: planning. The specification is in [docs/spec.md](docs/spec.md) (Traditional Chinese). Development starts at the hackathon kickoff.

## What it does

- **Media pool and multi-track timeline**: import videos, images, music and sound effects; main track, overlay tracks (picture-in-picture, alpha video) and audio tracks with auto-ducked music.
- **Resolve-style editing**: ripple timeline, DaVinci Resolve shortcuts (J/K/L, I/O, Ctrl+B, ripple delete, frame step, undo/redo), and transcript-driven cutting.
- **Fast subtitles**: Muse Voice Transcribe, word-level timing rebuilt from the audio, readable subtitle lines (tuned for English), SRT or burned-in.
- **Privacy masking**: type what to hide; SAM 3.1 segments and tracks it; mosaic, blur or solid fill.
- **AI proofreading**: Muse Spark flags mis-heard terms and repeated phrases.
- **Voice fixes**: re-voice a mis-spoken phrase in your own voice (Fish Audio).
- **Effects**: animation plugins run in a sandbox; **Vibe effects** where Muse Spark writes a new animation plugin from one sentence (and an optional frame); **Flat to 3D** with camera moves you can describe in words; transitions.
- **Export**: MP4 with hardware encoders and SRT.

## Architecture

Tauri 2 desktop app (React 19 + TypeScript) with a local FFmpeg engine. AI calls go through a small Spring AI gateway that holds the API keys and per-user quotas.

The design draws on the author's earlier experience building video tools.
