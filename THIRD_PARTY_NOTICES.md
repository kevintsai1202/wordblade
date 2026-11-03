# Third-party notices

WordBlade uses the following third-party models, libraries, fonts and services.

## Bundled in the apps

| Component | License | Where / notes |
| --- | --- | --- |
| [React](https://react.dev), React DOM | MIT | UI |
| [three.js](https://threejs.org) | MIT | 3D plugins and 3D scenes; bundled into the sandbox, never loaded from the network |
| [acorn](https://github.com/acornjs/acorn) | MIT | Parser for the restricted 2D plugin interpreter; vendored in `src/anim/vendor/acorn.js` (license in `acorn.LICENSE`) |
| 2D animation interpreter and component library | Apache-2.0 | From the author's own earlier project; see `src/anim/vendor/ORIGIN.md` |
| [mediabunny](https://mediabunny.dev) | MPL-2.0 | MP4 muxing and demuxing |
| [soundtouchjs](https://github.com/cutterbl/SoundTouchJS) | LGPL-2.1 | Pitch-preserving time stretch (WSOLA) for speed changes in export |
| [immer](https://immerjs.github.io/immer/) | MIT | Immutable project state |
| [opencc-js](https://github.com/nk2028/opencc-js) | MIT | Simplified → Traditional Chinese for Chinese transcripts |
| [Inter](https://rsms.me/inter/) (via @fontsource) | OFL-1.1 | UI and subtitle font |
| [Noto Sans TC](https://fonts.google.com/noto/specimen/Noto+Sans+TC) (via @fontsource) | OFL-1.1 | CJK subtitle font |
| SAM mask decoder (`src/sam/decoder.ts`) | SAM License | Adapted from Meta `meta_sam_parser` 0.0.6; full text in [licenses/meta-sam-parser-LICENSE.txt](licenses/meta-sam-parser-LICENSE.txt) |
| [Tauri 2](https://tauri.app) and plugins (dialog, opener) | MIT / Apache-2.0 | Windows app shell |

## Windows app only

| Component | License | Notes |
| --- | --- | --- |
| [FFmpeg](https://ffmpeg.org) (BtbN `lgpl-shared` build) | LGPL-2.1+ | Proxies, intermediate files and ASR audio extraction. LGPL build without libx264; license files ship next to the binaries |
| [ONNX Runtime](https://onnxruntime.ai) via the `ort` crate | MIT | On-device vocal separation |
| `DirectML.dll` | Microsoft proprietary, redistributable | DirectML execution provider (Windows only), CPU fallback |
| [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) | MIT | The inference procedure (STFT, ONNX run, overlap-add, iSTFT; background = mix minus vocals) was ported from it to Rust |
| `realfft`, `hound`, `sha2`, `ureq`, `serde` (Rust crates) | MIT / Apache-2.0 | FFT, WAV writing, checksum, model download, serialization |
| **Kim_Vocal_2** (MDX-Net, ONNX) by Kimberley Jensen | **Unclear upstream license** | From [TRvlvr/model_repo](https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models). The model repository has no LICENSE file, the author's repository does not include the weights, and Ultimate Vocal Remover only states that its code is MIT. **Not redistributed**: the app downloads it on first use into the user's app data folder and checks its SHA-256 (`ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`). Used for the hackathon only; to be confirmed or replaced before any commercial release |

## Gateway

| Component | License |
| --- | --- |
| [Spring Boot](https://spring.io/projects/spring-boot) 4.1, [Spring AI](https://spring.io/projects/spring-ai) 2.0 | Apache-2.0 |
| [PostgreSQL](https://www.postgresql.org) JDBC driver | BSD-2-Clause |
| [Flyway](https://flywaydb.org) | Apache-2.0 |

## Online services (called through the gateway)

| Service | Used for | Notes |
| --- | --- | --- |
| Meta API: Muse Spark 1.3, Muse Wonder, Muse Image, Muse Voice Transcribe, SAM 3.1 | All AI features except re-voicing | Muse Spark is the Contributor edition; content sent to it may be used by Meta for training (the app says so in its consent dialog) |
| [Fish Audio](https://fish.audio) (`s2.1-pro-free`) | Re-voicing in the user's own voice | Voice sample and text are sent only after consent |
| [TypeSafe](https://typesafe.ai) Jev | Helping the AI director judge retakes | |
