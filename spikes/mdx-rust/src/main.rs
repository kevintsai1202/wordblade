//! 命令列：`mdx-rust <in.wav> <out_dir> [--provider cpu|dml|auto] [--model path.onnx]`
//! 寫出 vocals.wav / instrumental.wav（float32），印出耗時與實際使用的 provider。
use mdx_rust::mdx::{separate, OrtMdx, Provider, KIM_VOCAL_2, SAMPLE_RATE};
use mdx_rust::wav::{read_wav, write_wav};
use std::time::Instant;

/// 預設模型路徑（spike 在 transcript-review 內的模型檔）。
const DEFAULT_MODEL: &str = r"D:\GitHub\transcript-review\spikes\stem-separation\models\Kim_Vocal_2.onnx";

/// 入口：解析參數、載入模型（auto 時 dml 失敗退回 CPU）、分離、寫檔、印統計。
fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut pos = vec![];
    let mut prov = "auto".to_string();
    let mut model = DEFAULT_MODEL.to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--provider" => {
                prov = args[i + 1].clone();
                i += 1;
            }
            "--model" => {
                model = args[i + 1].clone();
                i += 1;
            }
            a => pos.push(a.to_string()),
        }
        i += 1;
    }
    if pos.len() != 2 {
        return Err("用法: mdx-rust <in.wav> <out_dir> [--provider cpu|dml|auto] [--model x.onnx]".into());
    }
    let (mix, sr) = read_wav(&pos[0])?;
    if sr != SAMPLE_RATE {
        return Err(format!("取樣率需為 {SAMPLE_RATE}，實際 {sr}（spike 不做重取樣）"));
    }
    std::fs::create_dir_all(&pos[1]).map_err(|e| e.to_string())?;

    let t_load = Instant::now();
    let mut m = match prov.as_str() {
        "cpu" => OrtMdx::open(&model, KIM_VOCAL_2, Provider::Cpu)?,
        "dml" => OrtMdx::open(&model, KIM_VOCAL_2, Provider::DirectMl)?,
        _ => match OrtMdx::open(&model, KIM_VOCAL_2, Provider::DirectMl) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("DirectML 不可用，退回 CPU：{e}");
                OrtMdx::open(&model, KIM_VOCAL_2, Provider::Cpu)?
            }
        },
    };
    let load = t_load.elapsed();

    let t0 = Instant::now();
    let mut prog = |d: usize, t: usize| eprint!("\rchunk {d}/{t}");
    let (prim, sec, info) = separate(&mut m, KIM_VOCAL_2.compensate, &mix, Some(&mut prog))?;
    eprintln!();
    let total = t0.elapsed();
    write_wav(&format!("{}/vocals.wav", pos[1]), &prim, SAMPLE_RATE)?;
    write_wav(&format!("{}/instrumental.wav", pos[1]), &sec, SAMPLE_RATE)?;

    let n = m.infer_times.len() as f64;
    let ms = |d: &std::time::Duration| d.as_secs_f64() * 1000.0;
    let avg_inf = m.infer_times.iter().map(ms).sum::<f64>() / n;
    let avg_chunk = m.chunk_times.iter().map(ms).sum::<f64>() / n;
    let first_inf = ms(&m.infer_times[0]);
    let secs = info.samples as f64 / SAMPLE_RATE as f64;
    println!("provider      : {:?}", m.provider);
    println!("audio         : {:.2} s, peak {:.4}, gain {:.4}", secs, info.peak, info.gain);
    println!("session load  : {:.2} s", load.as_secs_f64());
    println!("total demix   : {:.2} s ({} chunks)", total.as_secs_f64(), m.infer_times.len());
    println!("per chunk     : infer avg {avg_inf:.0} ms (first {first_inf:.0} ms), whole chunk avg {avg_chunk:.0} ms");
    println!("RTF           : {:.3}x realtime", secs / total.as_secs_f64());
    Ok(())
}
