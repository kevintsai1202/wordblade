package com.wordblade.gateway.sam;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

/** SAM 的輪詢工作：上傳 → 讀串流（逐格累積）→ 完成記用量 → 一定刪檔；取消、上傳失敗、上游錯誤；權杖隔離（假的 Meta，不連網）。 */
class SamJobsTest {

    /** 假的 Meta：記錄呼叫，依設定丟錯或送出 delta */
    static class FakeMeta implements MetaSamClient {
        final List<String> calls = Collections.synchronizedList(new ArrayList<>());
        List<String> deltas = List.of("<0f>0<|box;x1=1;y1=1;x2=2;y2=2;w=9;h=9|>\n<1f>", "0<|box;x1=1;y1=1;x2=2;y2=2;w=9;h=9|>\n");
        RuntimeException uploadError;
        RuntimeException trackError;
        CountDownLatch gate;

        @Override
        public String upload(byte[] mp4) {
            calls.add("upload:" + mp4.length);
            if (uploadError != null) throw uploadError;
            return "file-abc";
        }

        @Override
        public long track(String fileId, String prompt, Consumer<String> onDelta, BooleanSupplier cancelled) throws InterruptedException {
            calls.add("track:" + fileId + ":" + prompt);
            if (gate != null) gate.await(5, TimeUnit.SECONDS);
            if (cancelled.getAsBoolean()) throw new SamCancelledException();
            if (trackError != null) throw trackError;
            deltas.forEach(onDelta);
            return 3;
        }

        @Override
        public void delete(String fileId) {
            calls.add("delete:" + fileId);
        }
    }

    private final FakeMeta meta = new FakeMeta();
    private final List<String> usage = Collections.synchronizedList(new ArrayList<>());
    /** 同步執行（刪檔也同步） */
    private final SamJobs jobs = new SamJobs(meta, Runnable::run, Runnable::run, (token, frames) -> usage.add(token + ":" + frames), 3);

    @Test
    void 完成_逐格行可依游標分批拿_記用量_刪檔() {
        String id = jobs.start(7, "human face", new byte[10]);
        SamJobs.View all = jobs.view(7, id, 0);
        assertThat(all.status()).isEqualTo("done");
        assertThat(all.lines()).hasSize(2);
        assertThat(all.next()).isEqualTo(2);
        assertThat(jobs.view(7, id, 1).lines()).hasSize(1);
        assertThat(jobs.view(7, id, 2).lines()).isEmpty();
        assertThat(all.framesProcessed()).isEqualTo(3);
        assertThat(usage).containsExactly("7:3");
        assertThat(meta.calls).containsExactly("upload:10", "track:file-abc:human face", "delete:file-abc");
    }

    @Test
    void 上傳失敗_failed_samUpload_沒有檔可刪() {
        meta.uploadError = new SamUpstreamException("boom");
        String id = jobs.start(7, "human face", new byte[10]);
        assertThat(jobs.view(7, id, 0)).extracting(SamJobs.View::status, SamJobs.View::error).containsExactly("failed", "sam-upload");
        assertThat(meta.calls).containsExactly("upload:10");
    }

    @Test
    void 上游錯誤_failed_samUpstream_仍刪檔() {
        meta.trackError = new SamUpstreamException("bad");
        String id = jobs.start(7, "human face", new byte[10]);
        assertThat(jobs.view(7, id, 0)).extracting(SamJobs.View::status, SamJobs.View::error).containsExactly("failed", "sam-upstream");
        assertThat(meta.calls).contains("delete:file-abc");
    }

    @Test
    void 取消_cancelled_仍刪檔() throws Exception {
        meta.gate = new CountDownLatch(1);
        SamJobs async = new SamJobs(meta, r -> new Thread(r).start(), Runnable::run, (t, f) -> usage.add(t + ":" + f), 3);
        String id = async.start(7, "human face", new byte[10]);
        async.cancel(7, id);
        meta.gate.countDown();
        for (int i = 0; i < 100 && async.view(7, id, 0).status().equals("running"); i++) Thread.sleep(20);
        assertThat(async.view(7, id, 0).status()).isEqualTo("cancelled");
        for (int i = 0; i < 100 && !meta.calls.contains("delete:file-abc"); i++) Thread.sleep(20);
        assertThat(meta.calls).contains("delete:file-abc");
    }

    @Test
    void 別的權杖看不到_同時太多回忙() {
        String id = jobs.start(7, "human face", new byte[10]);
        assertThatThrownBy(() -> jobs.view(8, id, 0)).isInstanceOf(SamJobs.NotFoundException.class);
        meta.gate = new CountDownLatch(1);
        SamJobs limited = new SamJobs(meta, r -> new Thread(r).start(), Runnable::run, (t, f) -> { }, 1);
        limited.start(7, "human face", new byte[10]);
        assertThatThrownBy(() -> limited.start(7, "human face", new byte[10])).isInstanceOf(SamJobs.BusyException.class);
        meta.gate.countDown();
    }
}
