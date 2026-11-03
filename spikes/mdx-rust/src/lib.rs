//! MDX-Net 人聲／伴奏分離推論的 Rust 移植（spike）。
//!
//! 對照 transcript-review/backend/stems/mdx.py：`dsp` 是 STFT／iSTFT，`mdx` 是模型包裝、demix、separate。
pub mod dsp;
pub mod mdx;
pub mod wav;
