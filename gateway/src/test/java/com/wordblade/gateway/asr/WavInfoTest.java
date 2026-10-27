package com.wordblade.gateway.asr;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import org.junit.jupiter.api.Test;

/** WAV 檔頭檢查：Muse ASR 只收單聲道 16-bit、16／24 kHz、≤ 10 分鐘。 */
class WavInfoTest {

    /** 組一個 PCM WAV（資料全 0） */
    static byte[] wav(int channels, int rate, int bits, double seconds) {
        int data = (int) Math.round(seconds * rate) * channels * bits / 8;
        ByteBuffer b = ByteBuffer.allocate(44 + data).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes()).putInt(36 + data).put("WAVE".getBytes());
        b.put("fmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) channels).putInt(rate)
                .putInt(rate * channels * bits / 8).putShort((short) (channels * bits / 8)).putShort((short) bits);
        b.put("data".getBytes()).putInt(data);
        return b.array();
    }

    @Test
    void 合格的單聲道16k回傳秒數() {
        WavInfo info = WavInfo.parse(wav(1, 16000, 16, 2.5));
        assertThat(info.sampleRate()).isEqualTo(16000);
        assertThat(info.seconds()).isEqualTo(2.5);
        assertThat(WavInfo.parse(wav(1, 24000, 16, 1)).seconds()).isEqualTo(1.0);
    }

    @Test
    void 格式不合拒絕() {
        assertThatThrownBy(() -> WavInfo.parse(wav(2, 16000, 16, 1))).isInstanceOf(WavInfo.BadWavException.class).hasMessageContaining("mono");
        assertThatThrownBy(() -> WavInfo.parse(wav(1, 44100, 16, 1))).hasMessageContaining("16000");
        assertThatThrownBy(() -> WavInfo.parse(wav(1, 16000, 8, 1))).hasMessageContaining("16-bit");
        assertThatThrownBy(() -> WavInfo.parse("not a wave file at all, definitely not".getBytes())).hasMessageContaining("WAV");
        assertThatThrownBy(() -> WavInfo.parse(new byte[10])).hasMessageContaining("WAV");
    }

    @Test
    void 超過十分鐘拒絕() {
        assertThatThrownBy(() -> WavInfo.parse(wav(1, 16000, 16, 601))).hasMessageContaining("600");
    }

    @Test
    void data區塊前有其他區塊也找得到() {
        byte[] plain = wav(1, 16000, 16, 1);
        // 在 fmt 與 data 之間插一個 LIST 區塊（ffmpeg 會寫）
        ByteBuffer b = ByteBuffer.allocate(plain.length + 12).order(ByteOrder.LITTLE_ENDIAN);
        b.put(plain, 0, 36).put("LIST".getBytes()).putInt(4).put("INFO".getBytes()).put(plain, 36, plain.length - 36);
        assertThat(WavInfo.parse(b.array()).seconds()).isEqualTo(1.0);
    }
}
