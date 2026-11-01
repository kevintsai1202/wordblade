//! 比對兩個 WAV：`compare <ref.wav> <test.wav> [--peak-norm]`，印出相關係數、SNR(dB)、最大差（第一個當參考）。
use mdx_rust::wav::read_wav;

/// 入口：讀兩檔、截到共同長度，算相關係數與 SNR = 10·log10(Σref² / Σ(ref−test)²)。
fn main() -> Result<(), String> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (r, _) = read_wav(&a[0])?;
    let (t, _) = read_wav(&a[1])?;
    let norm = a.iter().any(|x| x == "--peak-norm");
    let n = r[0].len().min(t[0].len());
    let mut rv: Vec<f64> = (0..2).flat_map(|c| r[c][..n].iter().map(|v| *v as f64)).collect();
    let mut tv: Vec<f64> = (0..2).flat_map(|c| t[c][..n].iter().map(|v| *v as f64)).collect();
    if norm {
        let pr = rv.iter().fold(0f64, |m, v| m.max(v.abs())).max(1e-12);
        let pt = tv.iter().fold(0f64, |m, v| m.max(v.abs())).max(1e-12);
        rv.iter_mut().for_each(|v| *v /= pr);
        tv.iter_mut().for_each(|v| *v /= pt);
    }
    let (mut dot, mut nr, mut nt, mut ne, mut maxd) = (0f64, 0f64, 0f64, 0f64, 0f64);
    for i in 0..rv.len() {
        dot += rv[i] * tv[i];
        nr += rv[i] * rv[i];
        nt += tv[i] * tv[i];
        let d = rv[i] - tv[i];
        ne += d * d;
        maxd = maxd.max(d.abs());
    }
    println!("samples/ch {n}  len_ref {} len_test {}", r[0].len(), t[0].len());
    println!("corr {:.6}  SNR {:.2} dB  max|diff| {:.3e}", dot / (nr.sqrt() * nt.sqrt()), 10.0 * (nr / ne.max(1e-30)).log10(), maxd);
    Ok(())
}
