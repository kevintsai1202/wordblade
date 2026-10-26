# WordBlade

Cut lecture videos by editing words, Resolve-style, with subtitles, privacy masking and voice fixes powered by Meta's models.

Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Indie Developer track, Oct 26 – Nov 4, 2026).

> Status: planning. The specification is in [docs/spec.md](docs/spec.md) (Traditional Chinese). Development starts at the hackathon kickoff.

## What it does

- **Media pool and multi-track timeline**: import videos, images, music and sound effects; main track, overlay tracks (picture-in-picture, alpha video) and audio tracks with auto-ducked music. Split any clip's audio into vocals and background music on-device (MDX-Net ONNX).
- **Resolve-style editing**: ripple timeline, DaVinci Resolve shortcuts (J/K/L, I/O, Ctrl+B, ripple delete, frame step, undo/redo), and transcript-driven cutting.
- **Fast subtitles**: Muse Voice Transcribe, word-level timing rebuilt from the audio, readable subtitle lines (tuned for English), SRT or burned-in.
- **Privacy masking**: type what to hide; SAM 3.1 segments and tracks it; mosaic, blur or solid fill.
- **AI proofreading**: Muse Spark flags mis-heard terms and repeated phrases.
- **AI audio**: sound effects and background music written by Muse Spark as Web Audio code and rendered on-device; re-voice a mis-spoken phrase in your own voice (Fish Audio).
- **Effects (the core)**: animation plugins run in a sandbox; **Vibe effects** where Muse Spark writes a new animation plugin from one sentence (and an optional frame); **3D effects in three.js** that Muse Spark can write and that react to your video (screen-on-a-desk scenes, mascots that point at what SAM found), with camera moves you can describe in words; transitions.
- **Editing helpers**: one-click filler-word removal, zoom and pan keyframes, speed ramps, karaoke-style word-highlight captions, and a karaoke re-record mode that lets you re-voice a line in sync with the original timing.
- **Publish kit**: Muse Spark writes titles, description, chapters and tags; Muse Image makes the thumbnail.
- **Export**: MP4 with hardware encoders and SRT.

## Architecture

One codebase, two shells: a Windows desktop app (Tauri 2, with native FFmpeg and ONNX Runtime for speed on CPU-only machines) and a web app for Chrome/Edge (WebCodecs) with a one-click sample project, so anyone can try it without installing anything. React 19 + TypeScript. AI calls go through a small Spring AI gateway that holds the API keys and per-user quotas.

The design draws on the author's earlier experience building video tools.
