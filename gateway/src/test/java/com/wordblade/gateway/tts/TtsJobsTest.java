package com.wordblade.gateway.tts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * AI 重生語音（spec §5.6，P2，2026-11-01）：閘道把文字＋聲音樣本轉給 Fish Audio（s2.1-pro-free），回標準 WAV。
 * Fish 的契約（原專案實測）：model 放 header、本體 msgpack、參考音檔 raw bytes、串流 WAV 的長度欄位是錯的要重包、speed 上限 1.3。
 */
class TtsJobsTest {

    /** 串流式 WAV：RIFF 與 data 長度都填 0xFFFFFFFF（Fish 常回這種），內容 n 個 16-bit 取樣 */
    static byte[] streamingWav(int rate, int samples) {
        ByteBuffer b = ByteBuffer.allocate(44 + samples * 2).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes()).putInt(0xFFFFFFFF).put("WAVE".getBytes());
        b.put("fmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) 1).putInt(rate).putInt(rate * 2).putShort((short) 2).putShort((short) 16);
        b.put("data".getBytes()).putInt(0xFFFFFFFF);
        for (int i = 0; i < samples; i++) b.putShort((short) (i % 100));
        return b.array();
    }

    /** 假 Fish：記下收到的請求，回串流式 WAV */
    static class FakeFish implements TtsJobs.Speech {
        final List<Map<String, Object>> requests = new ArrayList<>();

        @Override
        public byte[] speak(Map<String, Object> body) {
            requests.add(body);
            return streamingWav(44100, 4410);
        }
    }

    private final FakeFish fish = new FakeFish();
    private final List<String> usage = new ArrayList<>();
    private final TtsJobs jobs = new TtsJobs(fish, Runnable::run, (t, route, m, in, out, units) -> usage.add(t + ":" + route + ":" + m + ":" + units), "s2.1-pro-free");

    @Test
    void 生成_送文字樣本與速度_回重包過的標準_WAV_記一次() {
        byte[] seed = {1, 2, 3};
        String id = jobs.start(7, new TtsJobs.Request("Hello there [break] friends", Base64.getEncoder().encodeToString(seed), "seed words", 1.2));
        TtsJobs.View v = jobs.view(7, id);
        assertThat(v.status()).isEqualTo("done");
        byte[] wav = Base64.getDecoder().decode(v.audio());
        ByteBuffer b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        assertThat(b.getInt(4)).isEqualTo(36 + 8820);
        assertThat(b.getInt(40)).isEqualTo(8820);
        assertThat(v.seconds()).isEqualTo(0.1, org.assertj.core.data.Offset.offset(1e-6));
        Map<String, Object> body = fish.requests.get(0);
        assertThat(body.get("text")).isEqualTo("Hello there [break] friends");
        assertThat(body.get("format")).isEqualTo("wav");
        @SuppressWarnings("unchecked")
        Map<String, Object> ref = ((List<Map<String, Object>>) body.get("references")).get(0);
        assertThat((byte[]) ref.get("audio")).containsExactly(1, 2, 3);
        assertThat(ref.get("text")).isEqualTo("seed words");
        @SuppressWarnings("unchecked")
        Map<String, Object> prosody = (Map<String, Object>) body.get("prosody");
        assertThat(prosody.get("speed")).isEqualTo(1.2);
        assertThat(usage).containsExactly("7:/v1/tts:s2.1-pro-free:1");
    }

    @Test
    void 速度超過_1_3_夾到_1_3_空文字或沒有樣本拒絕_別的權杖看不到() {
        String id = jobs.start(7, new TtsJobs.Request("hi", "AQ==", "x", 2.5));
        @SuppressWarnings("unchecked")
        Map<String, Object> prosody = (Map<String, Object>) fish.requests.get(0).get("prosody");
        assertThat(prosody.get("speed")).isEqualTo(1.3);
        assertThatThrownBy(() -> jobs.start(7, new TtsJobs.Request(" ", "AQ==", "x", 1))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> jobs.start(7, new TtsJobs.Request("hi", "", "x", 1))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> jobs.start(7, new TtsJobs.Request("hi", "AQ==", "", 1))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> jobs.view(8, id)).isInstanceOf(TtsJobs.NotFoundException.class);
    }

    @Test
    void msgpack_編碼字串數字布林位元組陣列與物件() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("a", 1);
        m.put("b", true);
        m.put("c", new byte[] {9});
        m.put("d", List.of("x"));
        m.put("e", 1.5);
        byte[] out = MsgPack.pack(m);
        // fixmap(5) "a" 1 "b" true "c" bin8(1) 9 "d" fixarray(1) "x" "e" float64(1.5)
        assertThat(out).startsWith((byte) 0x85, (byte) 0xa1, (byte) 'a', (byte) 0x01, (byte) 0xa1, (byte) 'b', (byte) 0xc3,
                (byte) 0xa1, (byte) 'c', (byte) 0xc4, (byte) 0x01, (byte) 0x09, (byte) 0xa1, (byte) 'd', (byte) 0x91, (byte) 0xa1, (byte) 'x',
                (byte) 0xa1, (byte) 'e', (byte) 0xcb);
    }
}
