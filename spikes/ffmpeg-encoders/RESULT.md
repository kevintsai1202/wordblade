# ffmpeg H.264 編碼器實測

- 日期：2026-10-27 02:00
- ffmpeg：ffmpeg version 9.0.1-essentials_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers
- CPU：Intel(R) Core(TM) Ultra 5 125H
- 顯卡：Intel(R) Arc(TM) Graphics（驅動 32.0.101.8860）

| 編碼器 | 結果 |
| --- | --- |
| `h264_qsv` | 可用 |
| `h264_mf` | 可用 |
| `h264_amf` | 不可用 |
| `h264_nvenc` | 不可用 |
| `libx264` | 可用 |
| `libopenh264` | 不可用 |
