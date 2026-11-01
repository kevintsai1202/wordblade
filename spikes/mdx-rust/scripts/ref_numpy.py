"""用 transcript-review 的 numpy 版 stems/mdx.py 跑同一段輸入，輸出 float32 WAV 當 Rust 版的基準（ground truth）。

用法：<venv python> ref_numpy.py <in.wav> <out_dir> [cpu|dml]
需要 numpy + onnxruntime；backend 目錄放進 sys.path 才能 import stems.mdx。
"""
import sys
import time
import wave
import struct
import tempfile
from pathlib import Path
import numpy as np

BACKEND = r'D:\GitHub\transcript-review\backend'
MODELS = Path(r'D:\GitHub\transcript-review\spikes\stem-separation\models')
sys.path.insert(0, BACKEND)
from stems import mdx  # noqa: E402


def read_wav(path):
    """讀 16-bit WAV → [n, ch] float32（/32768，與 test_stems_mdx.py 的 read_wav 相同）。"""
    with wave.open(str(path)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).reshape(-1, w.getnchannels()).astype(np.float32) / 32768


def write_f32_wav(path, data, sr=44100):
    """寫 IEEE float32 立體聲 WAV（data: [n, 2] float32），手刻 header 免依賴 soundfile。"""
    raw = np.ascontiguousarray(data.astype(np.float32)).tobytes()
    hdr = b'RIFF' + struct.pack('<I', 36 + len(raw)) + b'WAVE' + b'fmt ' + struct.pack('<IHHIIHH', 16, 3, 2, sr, sr * 8, 8, 32) + b'data' + struct.pack('<I', len(raw))
    Path(path).write_bytes(hdr + raw)


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2]); prefer_dml = len(sys.argv) > 3 and sys.argv[3] == 'dml'
    out.mkdir(parents=True, exist_ok=True)
    mix = read_wav(src)
    mdx.MODEL_DIR = MODELS
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / 'mix.f32'; raw.write_bytes(mix.tobytes())
        p = Path(tmp) / 'p.f32'; s = Path(tmp) / 's.f32'
        t0 = time.time()
        info = mdx.separate_file('kim-vocal-2', raw, p, s, prefer_dml=prefer_dml)
        dt = time.time() - t0
        prim = np.frombuffer(p.read_bytes(), dtype=np.float32).reshape(-1, 2); sec = np.frombuffer(s.read_bytes(), dtype=np.float32).reshape(-1, 2)
    write_f32_wav(out / 'vocals.wav', prim); write_f32_wav(out / 'instrumental.wav', sec)
    print('numpy ref: provider', info['provider'], 'peak', round(info['peak'], 4), 'gain', round(info['gain'], 4), 'time %.2fs' % dt)


if __name__ == '__main__':
    main()
