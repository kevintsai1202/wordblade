package com.wordblade.gateway.vibe;

import com.wordblade.gateway.ai.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** Vibe特效的工作流程：首輪、結構錯誤自動重問、桌面回饋續跑、輪數上限、權杖隔離（用假模型，不連網）。 */
class VibeJobsTest {

    /** 假模型：依序回預先排好的回應，並記下每次收到的使用者訊息與有沒有附圖 */
    static class FakeModel implements AiModel {
        final Deque<String> replies = new ArrayDeque<>();
        final List<String> userTexts = new ArrayList<>();
        final List<Boolean> withImage = new ArrayList<>();

        @Override
        public Reply call(String conversationId, String userText, Image image) {
            userTexts.add(userText);
            withImage.add(image != null);
            return new Reply(replies.removeFirst(), 1000, 200, "fake-wonder");
        }

        @Override
        public void forget(String conversationId) {}
    }

    static final String OK = "{\"refused\": false, \"mode\": \"params\", \"anim\": {\"title\": \"Box\", \"layers\": [{\"component\": \"box\", \"params\": {}}]}, \"components\": []}";
    static final String BAD = "not json";

    private final FakeModel model = new FakeModel();
    private final List<String> usage = new ArrayList<>();
    /** 同步執行（測試不開執行緒） */
    private final VibeJobs jobs = new VibeJobs(model, new VibeParser(JsonMapper.builder().build()), Runnable::run,
            (tokenId, m, in, out) -> usage.add(tokenId + ":" + m + ":" + in + ":" + out));

    private VibeRequest request(String screenshot) {
        return new VibeRequest("A red box around the button", screenshot, 3.0, 30, 1920, new VibeRequest.Box(760, 420, 400, 240), null);
    }

    @Test
    void 首輪成功_帶截圖_記用量() {
        model.replies.add(OK);
        String id = jobs.start(7, request("data:image/png;base64,iVBORw0KGgo="));
        VibeJobs.View<VibeParser.Parsed> v = jobs.view(7, id);
        assertThat(v.status()).isEqualTo("done");
        assertThat(v.round()).isEqualTo(1);
        assertThat(v.result().mode()).isEqualTo("params");
        assertThat(model.withImage).containsExactly(true);
        assertThat(model.userTexts.get(0)).contains("<<<A red box around the button>>>");
        assertThat(usage).containsExactly("7:fake-wonder:1000:200");
    }

    @Test
    void 結構錯誤自動重問_不重送截圖() {
        model.replies.add(BAD);
        model.replies.add(OK);
        String id = jobs.start(7, request("data:image/png;base64,iVBORw0KGgo="));
        VibeJobs.View<VibeParser.Parsed> v = jobs.view(7, id);
        assertThat(v.status()).isEqualTo("done");
        assertThat(v.round()).isEqualTo(2);
        assertThat(model.withImage).containsExactly(true, false);
        assertThat(model.userTexts.get(1)).startsWith("上一版有以下錯誤").contains("[json]");
    }

    @Test
    void 桌面回饋續跑_第三輪後不能再回饋() {
        model.replies.add(OK);
        model.replies.add(OK);
        model.replies.add(OK);
        String id = jobs.start(7, request(null));
        jobs.feedback(7, id, List.of(new AiError("smoke", 0, "畫太慢", 2, 1)));
        assertThat(model.userTexts.get(1)).contains("components[0] 畫太慢");
        jobs.feedback(7, id, List.of(new AiError("blank", 0, "沒畫東西", null, null)));
        assertThat(jobs.view(7, id).round()).isEqualTo(3);
        assertThatThrownBy(() -> jobs.feedback(7, id, List.of(new AiError("blank", 0, "x", null, null))))
                .isInstanceOf(VibeJobs.TooManyRoundsException.class);
    }

    @Test
    void 三輪都結構錯誤_失敗() {
        model.replies.add(BAD);
        model.replies.add(BAD);
        model.replies.add(BAD);
        String id = jobs.start(7, request(null));
        VibeJobs.View<VibeParser.Parsed> v = jobs.view(7, id);
        assertThat(v.status()).isEqualTo("failed");
        assertThat(v.error()).isEqualTo("invalid-response");
    }

    @Test
    void 別的權杖看不到這個工作() {
        model.replies.add(OK);
        String id = jobs.start(7, request(null));
        assertThatThrownBy(() -> jobs.view(8, id)).isInstanceOf(VibeJobs.NotFoundException.class);
    }

    @Test
    void 拒答就結束_不能回饋() {
        model.replies.add("{\"refused\": true, \"code\": \"off-topic\"}");
        String id = jobs.start(7, request(null));
        assertThat(jobs.view(7, id).result().refusal()).isEqualTo("off-topic");
        assertThatThrownBy(() -> jobs.feedback(7, id, List.of())).isInstanceOf(VibeJobs.TooManyRoundsException.class);
    }
}
