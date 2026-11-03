# WordBlade

Edit lecture and tutorial videos by editing words, then dress them up with effects that Meta's models write for you: 2D and 3D animations from one sentence, an AI director that watches the whole recording, privacy masks, subtitles, and re-voicing.

Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Indie Developer track, Oct 26 – Nov 4, 2026).

- **Try it in the browser (Chrome / Edge, desktop):** https://wordblade.zeabur.app. Click **Try the sample project** or **Try the effects sample**; no install and no token needed.
- **Windows app:** download the installer from [Releases](https://github.com/kevintsai1202/wordblade/releases).
- **AI features** need an invite token (Settings → Gateway). Judge token: see the submission form.

## What it does

**Editing**

- **Edit by words**: transcribe with Muse Voice Transcribe, rebuild word-level timing from the audio, then delete words to cut the video (ripple edit).
- **Multi-track timeline**: media pool, main track, overlay tracks (picture-in-picture, alpha video), dialogue, music, sound-effect and voice tracks; music ducks under speech automatically.
- **DaVinci Resolve-style shortcuts**: J/K/L, I/O, Ctrl+B, ripple delete, frame step, undo/redo.
- **Helpers**: one-click filler-word removal, remove silent gaps, zoom and pan keyframes, speed changes that keep pitch, freeze frames, 15 transitions, color grading.
- **Subtitles**: readable lines tuned for English, karaoke-style word highlighting, SRT export or burned in.

**AI**

- **AI director**: watches the whole recording and proposes a list of edits (cut retakes, hide private data, fix mis-heard words, zoom in, add effects); accept them one by one.
- **Vibe effects (2D)**: describe an animation in one sentence (optionally with the current frame) and Muse Wonder writes a new animation plugin. Plugins run in a sandbox with a restricted interpreter.
- **Vibe 3D**: Muse Wonder writes a three.js plugin that can read the current frame, the transcript, voice loudness and objects SAM found (for example a mascot that points at them).
- **3D scenes**: your video on a screen in a 3D room, with camera moves you can describe in words.
- **Privacy masks**: type what to hide in any language; SAM 3.1 segments and tracks it; mosaic, blur or solid fill.
- **Proofreading**: Muse Spark flags mis-heard terms and repeated phrases.
- **Audio**: sound effects and background music that Muse Spark writes as declarative Web Audio specs, rendered on your machine; re-voice a mis-spoken phrase in your own voice (Fish Audio), or re-record it yourself in a karaoke prompter.
- **Textures and backgrounds**: Muse Image makes seamless textures and 3D backgrounds.
- **One-click intro**: covers plus a title become an animated intro with sound and music on the beat.
- **Publish kit**: Muse Spark writes the title, description, chapters and tags; Muse Image makes the thumbnail.

**Export**: MP4 (hardware H.264 encoders where available) and SRT. Preview and export use the same WebGL compositor, so what you see is what you get.

## Meta models used

| Model | Used for |
| --- | --- |
| **Muse Voice Transcribe** | Transcripts for word editing and subtitles |
| **Muse Spark 1.3** | AI director (watches the video in segments), proofreading, mask terms (any language → English noun phrase), sound effects, music, describing 3D camera moves, publish kit; fallback for Vibe effects |
| **Muse Wonder** | Vibe 2D and 3D effects (writes the plugin code); coordinates the AI director |
| **SAM 3.1** | Segmenting and tracking objects for privacy masks and for 3D effects that point at things |
| **Muse Image** | Textures, 3D backgrounds, thumbnails |

Other AI services: **Fish Audio** (`s2.1-pro-free`) for re-voicing (Meta does not offer text-to-speech), and **TypeSafe Jev** to help the AI director judge which take is the retake.

## Architecture

```
Windows app (Tauri 2)  /  Web app (Chrome, Edge)
  React 19 + TypeScript UI ── TS core (timeline model, word cutting, subtitle lines)
  WebGL compositor (preview and export) + WebCodecs + mediabunny
  Sandboxed iframe → Worker: 2D and three.js plugins draw each frame
  Desktop only (Rust): FFmpeg proxies, on-device vocal separation (ONNX Runtime, DirectML/CPU)
        │ HTTPS + invite token
WordBlade gateway (Spring Boot 4.1 + Spring AI 2.0, PostgreSQL)
  Holds the API keys and prompts, validates structured output, logs usage
  → Meta API (Muse Spark, Muse Wonder, Muse Image, Muse Voice Transcribe, SAM 3.1)
  → Fish Audio, TypeSafe
```

- **One codebase, two shells.** Platform-specific work (files, proxies, vocal separation, recording) sits behind an `Engine` interface with a desktop and a web implementation. The web app does not separate vocals or make proxies; it accepts H.264/AAC MP4 and MOV.
- **Local first.** Editing and export run on your machine. Only what an AI feature needs goes to the gateway (for example 16 kHz mono audio for transcription, a small silent clip for SAM, 480p frames at 2 fps for the director), and the app asks for consent the first time each kind is sent.
- **Prompts live in the gateway**, so they can be tuned without shipping a new app.

## Run from source (PowerShell 7)

Requirements: Node.js 22+, pnpm, Rust (for the desktop app), Java 21 + Maven and Docker (for the gateway).

```powershell
pnpm install

# Web app (http://localhost:1420)
pnpm dev

# Windows app (downloads the LGPL FFmpeg build first)
pwsh scripts/fetch-ffmpeg.ps1
pnpm tauri dev

# Tests
pnpm test
pnpm test:e2e
```

Gateway (see [gateway/README.md](gateway/README.md)):

```powershell
cd gateway
docker compose up -d        # PostgreSQL
$env:META_API_KEY = "<your key>"
$env:FISH_API_KEY = "<your key>"
mvn spring-boot:run         # http://localhost:8080
```

Then open Settings → Gateway in the app and enter the gateway URL and an invite token.

## Built during the hackathon

This repository was started on Oct 26, 2026, at the hackathon kickoff. Almost all of it was written during the hackathon; a few parts were reused from the author's own earlier video-tool project (Apache-2.0), and they are listed here so that judges can tell them apart.

**Reused from the author's earlier project (not new work)**

| What | Where | Notes |
| --- | --- | --- |
| 2D animation interpreter (restricted JavaScript VM) and runtime | `src/anim/vendor/anim_vm.js`, `anim_runtime.js` | Copied as is; the runtime got a small change so it runs in a Worker (`OffscreenCanvas`). See [src/anim/vendor/ORIGIN.md](src/anim/vendor/ORIGIN.md) |
| 2D component library (the built-in 2D templates) and its API manifest | `src/anim/anim-library*.json`, `anim_api_manifest.json` | Unchanged; English labels added |
| Unit tests for the above | `src/anim/legacy/*.cjs` | Ported to Vitest |
| Plane-to-3D pose math | `src/three/vendor/plane3d_math.js` | Copied as is; see [src/three/vendor/ORIGIN.md](src/three/vendor/ORIGIN.md) |
| Ideas, not code | | The vocal-separation inference steps (re-implemented in Rust), the re-voice sample selection, and the floating-board pose format follow the earlier project's approach |

**New during the hackathon** — everything else, including:

- The whole app: Tauri desktop shell, web app, `Engine` layer, project files, media pool, multi-track timeline, word-based editing and word-level timing, subtitles, WebGL compositor and export.
- The sandbox that runs AI-written 2D and 3D plugins, Vibe 2D and Vibe 3D (Muse Wonder writes the plugin), the three.js 3D plugin API, 3D scene templates and describing camera moves in words.
- The AI director, SAM 3.1 privacy masks, proofreading, filler-word and silence removal, zoom and pan, speed changes, transitions, color grading, freeze frames.
- AI sound effects and music, re-voicing with Fish Audio, karaoke re-recording, one-click intro, textures and backgrounds, publish kit, the sample projects.
- The Spring AI gateway (prompts, structured output, usage logging) and its deployment.

The demo video shows only the new work. The built-in 2D templates come from the reused library, so the video shows 2D effects that Muse Wonder writes from one sentence, not the templates. The full specification and decision log are in [docs/spec.md](docs/spec.md) (Traditional Chinese).

## License

WordBlade is licensed under the [Apache License 2.0](LICENSE). Third-party components keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
