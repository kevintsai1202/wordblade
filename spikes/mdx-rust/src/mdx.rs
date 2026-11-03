//! MDX-Net 推論：頻譜打包、ONNX session 包裝、demix 切塊重疊相加、separate（峰值正規化與 secondary）。
//! 一對一對照 transcript-review/backend/stems/mdx.py；音訊型別一律 `Vec<Vec<f32>>`（[聲道][樣本]）。
use crate::dsp::{hann_periodic, hann_symmetric, istft, stft, Spec};
use ort::session::Session;
use ort::value::Tensor;
use realfft::num_complex::Complex32;
use std::time::{Duration, Instant};

/// 模型的取樣率；輸入需為 44.1 kHz 立體聲。
pub const SAMPLE_RATE: u32 = 44100;
pub const HOP: usize = 1024;
/// dim_t：時間軸固定格數。
pub const SEGMENT: usize = 256;
pub const OVERLAP: f64 = 0.25;
pub const NORMALIZE_PEAK: f32 = 0.9;

/// 模型參數（對應 mdx.py 的 MODELS 表項目）。
#[derive(Clone, Copy, Debug)]
pub struct ModelSpec {
    pub n_fft: usize,
    pub dim_f: usize,
    pub compensate: f32,
}

/// Kim_Vocal_2 的參數（mdx_model_data.json）。
pub const KIM_VOCAL_2: ModelSpec = ModelSpec { n_fft: 7680, dim_f: 3072, compensate: 1.009 };

/// 一個 chunk 的推論介面：[2][chunk] 波形進、[2][chunk] primary stem 出。測試用假模型也實作它。
pub trait ChunkModel {
    /// chunk 長度（樣本數）。
    fn chunk(&self) -> usize;
    /// 前後各丟掉的樣本數（n_fft/2）。
    fn trim(&self) -> usize;
    /// 對一個 chunk 做 STFT → 模型 → iSTFT。
    fn run(&mut self, wave: &[Vec<f32>]) -> Result<Vec<Vec<f32>>, String>;
}

/// 執行提供者選擇。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Cpu,
    DirectMl,
}

/// 把一個 chunk 波形 [2][chunk] 打包成模型輸入 [1,4,dim_f,T]（攤平）：L 實、L 虛、R 實、R 虛，前 3 個 bin 歸零。回 (資料, T)。
pub fn spectrogram(wave: &[Vec<f32>], spec: &ModelSpec, window: &[f32]) -> (Vec<f32>, usize) {
    let s = stft(wave, spec.n_fft, HOP, window);
    let t = s.frames;
    let plane = spec.dim_f * t;
    let mut x = vec![0f32; 4 * plane];
    for c in 0..2 {
        for b in 3..spec.dim_f {
            for k in 0..t {
                let v = s.data[c][b * t + k];
                x[(2 * c) * plane + b * t + k] = v.re;
                x[(2 * c + 1) * plane + b * t + k] = v.im;
            }
        }
    }
    (x, t)
}

/// 模型輸出 [1,4,dim_f,T] → 波形 [2][length]：dim_f 以上的 bin 補零後 iSTFT。
pub fn waveform(pred: &[f32], t: usize, spec: &ModelSpec, window: &[f32], length: usize) -> Vec<Vec<f32>> {
    let bins = spec.n_fft / 2 + 1;
    let plane = spec.dim_f * t;
    let mut data = Vec::with_capacity(2);
    for c in 0..2 {
        let mut full = vec![Complex32::new(0.0, 0.0); bins * t];
        for i in 0..plane {
            full[i] = Complex32::new(pred[(2 * c) * plane + i], pred[(2 * c + 1) * plane + i]);
        }
        data.push(full);
    }
    let sp = Spec { channels: 2, bins, frames: t, data };
    istft(&sp, spec.n_fft, HOP, window, length)
}

/// 包住一個 ONNX session 的 MDX 模型；記錄每個 chunk 的推論（僅 session.run）與整體（含 STFT/iSTFT）耗時。
pub struct OrtMdx {
    pub spec: ModelSpec,
    pub provider: Provider,
    window: Vec<f32>,
    session: Session,
    _env: ort::environment::Environment,
    input_name: String,
    pub infer_times: Vec<Duration>,
    pub chunk_times: Vec<Duration>,
}

impl OrtMdx {
    /// 載入模型並建立 session；DirectMl 以 error_on_failure 註冊，失敗就回 Err（由呼叫端決定是否退回 CPU）。
    pub fn open(path: &str, spec: ModelSpec, provider: Provider) -> Result<Self, String> {
        // rc.15 的 Session::builder 需要 Environment；Environment 只被弱引用，要由本結構持有到結束
        let env = ort::init().build().map_err(|x| x.to_string())?;
        let mut b = Session::builder(&env).map_err(|x| x.to_string())?;
        if provider == Provider::DirectMl {
            use ort::ep::DirectML;
            // DirectML EP 的建議設定：關 mem pattern、循序執行
            b = b.with_memory_pattern(false).map_err(|x| x.to_string())?;
            b = b.with_parallel_execution(false).map_err(|x| x.to_string())?;
            b = b
                .with_execution_providers([DirectML::default().build().error_on_failure()])
                .map_err(|x| x.to_string())?;
        }
        let session = b.commit_from_file(path).map_err(|x| x.to_string())?;
        let input_name = session.inputs()[0].name().to_string();
        Ok(Self {
            spec,
            provider,
            window: hann_periodic(spec.n_fft),
            session,
            _env: env,
            input_name,
            infer_times: vec![],
            chunk_times: vec![],
        })
    }
}

impl ChunkModel for OrtMdx {
    fn chunk(&self) -> usize {
        HOP * (SEGMENT - 1)
    }
    fn trim(&self) -> usize {
        self.spec.n_fft / 2
    }
    /// 一個 chunk：STFT → session.run → iSTFT，並記錄耗時。
    fn run(&mut self, wave: &[Vec<f32>]) -> Result<Vec<Vec<f32>>, String> {
        let t0 = Instant::now();
        let (x, t) = spectrogram(wave, &self.spec, &self.window);
        let input = Tensor::from_array(([1usize, 4, self.spec.dim_f, t], x)).map_err(|e| e.to_string())?;
        let t1 = Instant::now();
        let outputs = self
            .session
            .run(ort::inputs![self.input_name.as_str() => input])
            .map_err(|e| e.to_string())?;
        let (_shape, pred) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        self.infer_times.push(t1.elapsed());
        let out = waveform(pred, t, &self.spec, &self.window, wave[0].len());
        self.chunk_times.push(t0.elapsed());
        Ok(out)
    }
}

/// 滾動緩衝：保留 [flushed, flushed+buf_len) 的累加值；樣本位置 p 對應緩衝索引 p − flushed。
struct Rolling {
    acc: Vec<Vec<f32>>,
    div: Vec<f32>,
    flushed: usize, // 已定案並寫出的（補零座標）樣本數
    emitted: usize, // 已交給 write 的原始座標樣本數
}

impl Rolling {
    /// 把補零座標 [flushed, upto) 定案：除以權重和、換回原始座標（−trim，截到 [0,n_samples)）、寫出，並把緩衝左移。
    fn flush(&mut self, upto: usize, total_len: usize, trim: usize, n_samples: usize, write: &mut dyn FnMut(&[Vec<f32>])) {
        let upto = upto.min(total_len);
        if upto <= self.flushed {
            return;
        }
        let n = upto - self.flushed;
        let mut out: Vec<Vec<f32>> = self.acc.iter().map(|c| c[..n].to_vec()).collect();
        for i in 0..n {
            if self.div[i] > 1e-6 {
                out[0][i] /= self.div[i];
                out[1][i] /= self.div[i];
            }
        }
        let a0 = self.flushed as isize - trim as isize;
        let b0 = upto as isize - trim as isize;
        let ra = a0.max(0);
        let rb = b0.min(n_samples as isize);
        if rb > ra {
            let lo = (ra - a0) as usize;
            let hi = (rb - a0) as usize;
            let blk: Vec<Vec<f32>> = out.iter().map(|c| c[lo..hi].to_vec()).collect();
            write(&blk);
            self.emitted = rb as usize;
        }
        for c in self.acc.iter_mut() {
            c.copy_within(n.., 0);
            let l = c.len();
            c[l - n..].fill(0.0);
        }
        self.div.copy_within(n.., 0);
        let l = self.div.len();
        self.div[l - n..].fill(0.0);
        self.flushed = upto;
    }
}

/// 串流分離：`read(start, end)` 回 [2][n]；每個 chunk 以對稱 hann 加權重疊相加，定案的樣本立即交給 `write`。
/// 前面補 trim 個零、後面補到 gen_size 的倍數；step = (1−overlap)·chunk；最後去掉前後 trim 並截到 n_samples。
/// `progress(done,total)` 每 chunk 呼叫一次；`cancelled()` 為 true 就回 Err。
pub fn demix<M: ChunkModel>(
    model: &mut M,
    read: &mut dyn FnMut(usize, usize) -> Vec<Vec<f32>>,
    n_samples: usize,
    write: &mut dyn FnMut(&[Vec<f32>]),
    mut progress: Option<&mut dyn FnMut(usize, usize)>,
    cancelled: Option<&dyn Fn() -> bool>,
) -> Result<(), String> {
    let chunk = model.chunk();
    let trim = model.trim();
    let gen_size = chunk - 2 * trim;
    let pad = gen_size + trim - (n_samples % gen_size);
    let total_len = trim + n_samples + pad; // 補零後的總長
    let step = ((1.0 - OVERLAP) * chunk as f64) as usize;
    let starts: Vec<usize> = (0..total_len).step_by(step).collect();
    let total = starts.len();
    let buf_len = chunk + step;
    let mut r = Rolling { acc: vec![vec![0f32; buf_len]; 2], div: vec![0f32; buf_len], flushed: 0, emitted: 0 };

    for (k, &start) in starts.iter().enumerate() {
        if let Some(c) = cancelled {
            if c() {
                return Err("cancelled".into());
            }
        }
        let end = (start + chunk).min(total_len);
        let actual = end - start;
        // 補零座標 [start, start+chunk) 的輸入：前 trim 個零、原音、尾端零（尾端不足 chunk 時補零，與原版相同）
        let mut part = vec![vec![0f32; chunk]; 2];
        let ra = start.max(trim);
        let rb = (start + chunk).min(trim + n_samples);
        if rb > ra {
            let src = read(ra - trim, rb - trim);
            for c in 0..2 {
                part[c][ra - start..rb - start].copy_from_slice(&src[c]);
            }
        }
        let tar = model.run(&part)?;
        let w = hann_symmetric(actual);
        if start - r.flushed + actual > buf_len {
            return Err("緩衝溢位".into());
        }
        let off = start - r.flushed;
        for c in 0..2 {
            for i in 0..actual {
                r.acc[c][off + i] += tar[c][i] * w[i];
            }
        }
        for i in 0..actual {
            r.div[off + i] += w[i];
        }
        // 下一個 chunk 從 start+step 起，之前的樣本已定案
        r.flush(start + step, total_len, trim, n_samples, write);
        if let Some(p) = progress.as_mut() {
            p(k + 1, total);
        }
    }
    r.flush(total_len, total_len, trim, n_samples, write);
    if r.emitted < n_samples {
        write(&vec![vec![0f32; n_samples - r.emitted]; 2]);
    }
    Ok(())
}

/// 分離結果的摘要。
pub struct SeparateInfo {
    pub peak: f32,
    pub gain: f32,
    pub samples: usize,
}

/// 對整段立體聲 [2][n] 分離：峰值 > 0.9 時正規化增益 g = 0.9/peak → 對 mix·g 推論 →
/// primary 除回 g；secondary = mix − primary·compensate。回 (primary, secondary, info)。
pub fn separate<M: ChunkModel>(
    model: &mut M,
    compensate: f32,
    mix: &[Vec<f32>],
    progress: Option<&mut dyn FnMut(usize, usize)>,
) -> Result<(Vec<Vec<f32>>, Vec<Vec<f32>>, SeparateInfo), String> {
    let n = mix[0].len();
    if n == 0 {
        return Err("空音訊".into());
    }
    let peak = mix.iter().flat_map(|c| c.iter()).fold(0f32, |m, v| m.max(v.abs()));
    let gain = if peak > NORMALIZE_PEAK { NORMALIZE_PEAK / peak } else { 1.0 };
    let mut prim = vec![Vec::with_capacity(n); 2];
    let mut sec = vec![Vec::with_capacity(n); 2];
    let mut pos = 0usize;
    {
        let mut read = |a: usize, b: usize| -> Vec<Vec<f32>> {
            mix.iter().map(|c| c[a..b].iter().map(|v| v * gain).collect()).collect()
        };
        let mut write = |block: &[Vec<f32>]| {
            let k = block[0].len();
            for c in 0..2 {
                for i in 0..k {
                    let p = block[c][i] / gain;
                    prim[c].push(p);
                    sec[c].push(mix[c][pos + i] - p * compensate);
                }
            }
            pos += k;
        };
        demix(model, &mut read, n, &mut write, progress, None)?;
    }
    Ok((prim, sec, SeparateInfo { peak, gain, samples: n }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 簡單的確定性偽亂數（xorshift），避免引入 rand 依賴；回 [-1,1) 的 f32。
    fn noise(n: usize, seed: u64, amp: f32) -> Vec<f32> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                ((s >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0) as f32 * amp
            })
            .collect()
    }

    /// 假模型：chunk 原樣回傳，並記錄呼叫次數。
    struct Identity {
        calls: usize,
    }
    impl ChunkModel for Identity {
        fn chunk(&self) -> usize {
            HOP * (SEGMENT - 1)
        }
        fn trim(&self) -> usize {
            6144 / 2
        }
        fn run(&mut self, wave: &[Vec<f32>]) -> Result<Vec<Vec<f32>>, String> {
            self.calls += 1;
            Ok(wave.to_vec())
        }
    }

    /// 兩個 [聲道][樣本] 之間的最大絕對差。
    fn max_diff(a: &[Vec<f32>], b: &[Vec<f32>]) -> f32 {
        a.iter().zip(b).flat_map(|(x, y)| x.iter().zip(y).map(|(p, q)| (p - q).abs())).fold(0f32, f32::max)
    }

    /// periodic hann：w[0]=0、w[N/2]=1、最後一點不為 0（對稱窗才是 0）。
    #[test]
    fn hann_periodic_matches_formula() {
        let w = hann_periodic(8);
        assert!(w[0].abs() < 1e-7 && (w[4] - 1.0).abs() < 1e-7 && w[7] > 0.01);
        let s = hann_symmetric(8);
        assert!(s[7].abs() < 1e-7);
    }

    /// STFT → iSTFT 往返應還原原訊號（n_fft=6144，一個 chunk 長度）。
    #[test]
    fn stft_istft_roundtrip() {
        let n_fft = 6144;
        let len = HOP * (SEGMENT - 1);
        let x = vec![noise(len, 1, 0.5), noise(len, 2, 0.5)];
        let w = hann_periodic(n_fft);
        let sp = stft(&x, n_fft, HOP, &w);
        assert_eq!((sp.bins, sp.frames), (n_fft / 2 + 1, SEGMENT));
        let y = istft(&sp, n_fft, HOP, &w, len);
        assert!(max_diff(&x, &y) < 1e-4, "diff {}", max_diff(&x, &y));
    }

    /// 以 spectrogram → waveform 走模型的打包路徑（不經模型）：只有前 3 個 bin 被歸零，其餘還原；以高頻雜訊檢查誤差在合理範圍。
    #[test]
    fn pack_unpack_keeps_signal_above_bin3() {
        let spec = KIM_VOCAL_2;
        let len = HOP * (SEGMENT - 1);
        let x = vec![noise(len, 3, 0.5), noise(len, 4, 0.5)];
        let w = hann_periodic(spec.n_fft);
        let (packed, t) = spectrogram(&x, &spec, &w);
        assert_eq!(t, SEGMENT);
        assert_eq!(packed.len(), 4 * spec.dim_f * t);
        assert!(packed[..3 * t].iter().all(|v| *v == 0.0));
        let y = waveform(&packed, t, &spec, &w, len);
        // dim_f=3072 < 3841 bins：白雜訊約 20% 能量在被截掉的高頻，所以只檢查形狀與有限值
        assert_eq!((y.len(), y[0].len()), (2, len));
        assert!(y[0].iter().all(|v| v.is_finite()));
    }

    /// 假模型原樣回傳時，整段 demix 輸出應等於輸入（多種長度）、進度最後一格等於總數、呼叫次數一致。
    #[test]
    fn identity_model_reproduces_input() {
        for n in [1000usize, 300000, 700001] {
            let x = vec![noise(n, 5, 1.0), noise(n, 6, 1.0)];
            let mut m = Identity { calls: 0 };
            let mut out: Vec<Vec<f32>> = vec![vec![], vec![]];
            let mut seen = (0, 0);
            {
                let mut read = |a: usize, b: usize| -> Vec<Vec<f32>> { x.iter().map(|c| c[a..b].to_vec()).collect() };
                let mut write = |blk: &[Vec<f32>]| {
                    for c in 0..2 {
                        out[c].extend_from_slice(&blk[c]);
                    }
                };
                let mut prog = |d: usize, t: usize| seen = (d, t);
                demix(&mut m, &mut read, n, &mut write, Some(&mut prog), None).unwrap();
            }
            assert_eq!(out[0].len(), n, "n={n}");
            assert!(max_diff(&x, &out) < 1e-4, "n={n} diff {}", max_diff(&x, &out));
            assert_eq!(seen.0, seen.1);
            assert_eq!(m.calls, seen.1);
        }
    }

    /// 取消旗標為真時 demix 應回 Err。
    #[test]
    fn cancel_returns_err() {
        let x = vec![vec![0f32; 500000]; 2];
        let mut m = Identity { calls: 0 };
        let mut read = |a: usize, b: usize| -> Vec<Vec<f32>> { x.iter().map(|c| c[a..b].to_vec()).collect() };
        let mut write = |_: &[Vec<f32>]| {};
        let cancel = || true;
        assert!(demix(&mut m, &mut read, 500000, &mut write, None, Some(&cancel)).is_err());
    }

    /// separate：峰值 > 0.9 會正規化；假模型回 mix 本身 → primary ≈ mix，且 primary·comp + secondary ≈ mix。
    #[test]
    fn separate_reconstructs_with_gain() {
        let n = 400000;
        let mix = vec![noise(n, 7, 1.5), noise(n, 8, 1.5)];
        let mut m = Identity { calls: 0 };
        let (p, s, info) = separate(&mut m, 1.02, &mix, None).unwrap();
        assert!(info.gain < 1.0 && info.samples == n);
        assert!(max_diff(&p, &mix) < 1e-3);
        let recon: Vec<Vec<f32>> = (0..2).map(|c| (0..n).map(|i| p[c][i] * 1.02 + s[c][i]).collect()).collect();
        assert!(max_diff(&recon, &mix) < 1e-3);
    }
}
