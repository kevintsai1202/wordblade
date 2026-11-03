//! STFT / iSTFT：與 torch.stft（center=True、reflect 補邊、periodic hann）一致，對照 mdx.py 的 hann_periodic / stft / istft。
use realfft::num_complex::Complex32;
use realfft::RealFftPlanner;

/// 複數頻譜：`data[c][bin * frames + t]`，c 是聲道。
pub struct Spec {
    pub channels: usize,
    pub bins: usize,
    pub frames: usize,
    pub data: Vec<Vec<Complex32>>,
}

/// torch.hann_window(periodic=True)：分母是 N（不是對稱窗的 N−1）；以 f64 算再轉 f32。
pub fn hann_periodic(n: usize) -> Vec<f32> {
    (0..n)
        .map(|k| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * k as f64 / n as f64).cos()) as f32)
        .collect()
}

/// numpy.hanning(n)：對稱 hann（分母 n−1），demix 重疊相加的權重用它；n=1 時回 [1.0]。
pub fn hann_symmetric(n: usize) -> Vec<f32> {
    if n == 1 {
        return vec![1.0];
    }
    (0..n)
        .map(|k| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * k as f64 / (n - 1) as f64).cos()) as f32)
        .collect()
}

/// numpy.pad(mode='reflect')：左右各補 pad 個樣本（不重複邊界點）。要求 pad < x.len()。
fn reflect_pad(x: &[f32], pad: usize) -> Vec<f32> {
    let n = x.len();
    let mut out = Vec::with_capacity(n + 2 * pad);
    for i in (1..=pad).rev() {
        out.push(x[i]);
    }
    out.extend_from_slice(x);
    for i in 0..pad {
        out.push(x[n - 2 - i]);
    }
    out
}

/// x 為 [C][L] → 複數頻譜 [C][n_fft/2+1][T]；center=True、reflect 補邊。
pub fn stft(x: &[Vec<f32>], n_fft: usize, hop: usize, window: &[f32]) -> Spec {
    let pad = n_fft / 2;
    let bins = n_fft / 2 + 1;
    let mut planner = RealFftPlanner::<f32>::new();
    let r2c = planner.plan_fft_forward(n_fft);
    let mut data = Vec::with_capacity(x.len());
    let mut frames = 0;
    for ch in x {
        let xp = reflect_pad(ch, pad);
        frames = 1 + (xp.len() - n_fft) / hop;
        let mut spec = vec![Complex32::new(0.0, 0.0); bins * frames];
        let mut inbuf = r2c.make_input_vec();
        let mut outbuf = r2c.make_output_vec();
        let mut scratch = r2c.make_scratch_vec();
        for t in 0..frames {
            let seg = &xp[t * hop..t * hop + n_fft];
            for i in 0..n_fft {
                inbuf[i] = seg[i] * window[i];
            }
            r2c.process_with_scratch(&mut inbuf, &mut outbuf, &mut scratch).unwrap();
            for b in 0..bins {
                spec[b * frames + t] = outbuf[b];
            }
        }
        data.push(spec);
    }
    Spec { channels: x.len(), bins, frames, data }
}

/// 複數頻譜 → 波形 [C][length]：逐 frame irfft（含 1/n 正規化）乘窗、重疊相加，除以窗平方和，再去掉 center 補的兩端。
pub fn istft(spec: &Spec, n_fft: usize, hop: usize, window: &[f32], length: usize) -> Vec<Vec<f32>> {
    let pad = n_fft / 2;
    let frames = spec.frames;
    let total = n_fft + hop * (frames - 1);
    let mut planner = RealFftPlanner::<f32>::new();
    let c2r = planner.plan_fft_inverse(n_fft);
    // 窗平方和對所有聲道相同，只算一次（f64 累加，與 numpy 版相同）
    let mut wsum = vec![0f64; total];
    for t in 0..frames {
        for i in 0..n_fft {
            wsum[t * hop + i] += (window[i] as f64) * (window[i] as f64);
        }
    }
    let norm = 1.0 / n_fft as f32;
    let mut result = Vec::with_capacity(spec.channels);
    for c in 0..spec.channels {
        let mut out = vec![0f64; total];
        let mut inbuf = c2r.make_input_vec();
        let mut outbuf = c2r.make_output_vec();
        let mut scratch = c2r.make_scratch_vec();
        for t in 0..frames {
            for b in 0..spec.bins {
                inbuf[b] = spec.data[c][b * frames + t];
            }
            // irfft 對 DC 與 Nyquist 的虛部視為 0（numpy 也是），先清掉避免函式庫回錯
            inbuf[0].im = 0.0;
            inbuf[spec.bins - 1].im = 0.0;
            c2r.process_with_scratch(&mut inbuf, &mut outbuf, &mut scratch).unwrap();
            for i in 0..n_fft {
                out[t * hop + i] += (outbuf[i] * norm * window[i]) as f64;
            }
        }
        let y: Vec<f32> = (0..length)
            .map(|i| {
                let p = pad + i;
                let w = wsum[p];
                (if w > 1e-11 { out[p] / w } else { out[p] }) as f32
            })
            .collect();
        result.push(y);
    }
    result
}
