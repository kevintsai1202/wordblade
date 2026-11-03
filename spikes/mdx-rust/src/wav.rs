//! WAV 讀寫（hound）：讀入統一轉成 [聲道][樣本] 的 f32；寫出 float32 立體聲。
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};

/// 讀 WAV → ([聲道][樣本] f32, 取樣率)。整數格式依位元深度正規化到 [-1,1)；單聲道複製成雙聲道。
pub fn read_wav(path: &str) -> Result<(Vec<Vec<f32>>, u32), String> {
    let mut r = WavReader::open(path).map_err(|e| format!("{path}: {e}"))?;
    let spec = r.spec();
    let ch = spec.channels as usize;
    let inter: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => r.samples::<f32>().collect::<Result<_, _>>().map_err(|e| e.to_string())?,
        SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>().map(|s| s.map(|v| v as f32 * scale)).collect::<Result<_, _>>().map_err(|e| e.to_string())?
        }
    };
    let n = inter.len() / ch;
    let mut out = vec![Vec::with_capacity(n); 2];
    for i in 0..n {
        out[0].push(inter[i * ch]);
        out[1].push(inter[i * ch + if ch > 1 { 1 } else { 0 }]);
    }
    Ok((out, spec.sample_rate))
}

/// 寫 float32 立體聲 WAV。
pub fn write_wav(path: &str, wave: &[Vec<f32>], sample_rate: u32) -> Result<(), String> {
    let spec = WavSpec { channels: 2, sample_rate, bits_per_sample: 32, sample_format: SampleFormat::Float };
    let mut w = WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for i in 0..wave[0].len() {
        w.write_sample(wave[0][i]).map_err(|e| e.to_string())?;
        w.write_sample(wave[1][i]).map_err(|e| e.to_string())?;
    }
    w.finalize().map_err(|e| e.to_string())
}
