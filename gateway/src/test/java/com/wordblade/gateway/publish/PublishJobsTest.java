package com.wordblade.gateway.publish;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.wordblade.gateway.ai.AiModel;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Deque;
import java.util.List;
import org.junit.jupiter.api.Test;

/** 發佈包工作（spec §5.17）：Spark 寫標題、說明、章節、標籤（整理長度與數量、JSON 讀不出重問一次）；Muse Image 改縮圖底圖；輸入檢查；權杖隔離。 */
class PublishJobsTest {

    /** 假 Spark：依序回排好的回應，記下收到的逐字稿 */
    static class FakeText implements PublishJobs.TextModel {
        final Deque<String> replies = new ArrayDeque<>();
        final List<String> prompts = new ArrayList<>();

        @Override
        public AiModel.Reply write(String language, double duration, String transcript) {
            prompts.add(language + "|" + duration + "|" + transcript);
            return new AiModel.Reply(replies.removeFirst(), 2000, 400, "fake-spark");
        }
    }

    /** 假 Muse Image：回固定位元組，記下提示詞 */
    static class FakeImage implements PublishJobs.ImageModel {
        final List<String> prompts = new ArrayList<>();

        @Override
        public PublishJobs.ImageReply edit(String prompt, byte[] image, String mime) {
            prompts.add(prompt + "|" + mime + "|" + image.length);
            return new PublishJobs.ImageReply(new byte[] {9, 8, 7}, "image/webp", 30000, 2000, "fake-image");
        }

        @Override
        public PublishJobs.ImageReply generate(String prompt, String size) {
            prompts.add(prompt + "|" + size);
            return new PublishJobs.ImageReply(new byte[] {5, 4}, "image/png", 4900, 1000, "fake-image");
        }
    }

    private final FakeText text = new FakeText();
    private final FakeImage image = new FakeImage();
    private final List<String> usage = new ArrayList<>();
    private final PublishJobs jobs = new PublishJobs(text, image, Runnable::run, (t, route, m, in, out, units) -> usage.add(t + ":" + route + ":" + m + ":" + units));

    private static List<PublishJobs.Line> lines() {
        return List.of(new PublishJobs.Line(0, "Hello and welcome."), new PublishJobs.Line(31.4, "Let's set things up."), new PublishJobs.Line(95, "Now the demo."));
    }

    @Test
    void 寫發佈包_逐字稿帶時間標記_整理長度與數量() {
        String longTitle = "T".repeat(150);
        text.replies.add("""
                {"titles":["%s","Two","Three","Four"],"description":"Desc","highlights":["a","b"],
                 "chapters":[{"t":0,"title":"Intro"},{"t":31,"title":"Setup"},{"t":500,"title":"Late"}],
                 "tags":["video editing","AI"]}""".formatted(longTitle));
        String id = jobs.startKit(7, "en", 120, lines());
        PublishJobs.KitView v = jobs.viewKit(7, id);
        assertThat(v.status()).isEqualTo("done");
        assertThat(v.kit().titles()).hasSize(3);
        assertThat(v.kit().titles().get(0)).hasSize(100);
        // 超過片長的章節丟掉（其餘的對齊與 YouTube 規則交給前端）
        assertThat(v.kit().chapters()).extracting(PublishJobs.Chapter::title).containsExactly("Intro", "Setup");
        assertThat(text.prompts.get(0)).startsWith("en|120.0|").contains("[0:31] Let's set things up.").contains("[1:35] Now the demo.");
        assertThat(usage).containsExactly("7:/v1/ai/publish:fake-spark:0");
    }

    @Test
    void JSON_讀不出來或沒有標題就重問_兩次都不行就失敗() {
        text.replies.add("not json");
        text.replies.add("{\"titles\":[],\"description\":\"x\",\"highlights\":[],\"chapters\":[],\"tags\":[]}");
        String id = jobs.startKit(7, "en", 60, lines());
        assertThat(jobs.viewKit(7, id).status()).isEqualTo("failed");
        assertThat(text.prompts).hasSize(2);
    }

    @Test
    void 輸入檢查_沒有逐字稿_太長_語言代碼怪_都拒絕() {
        assertThatThrownBy(() -> jobs.startKit(7, "en", 60, List.of())).isInstanceOf(IllegalArgumentException.class);
        List<PublishJobs.Line> huge = List.of(new PublishJobs.Line(0, "x".repeat(PublishJobs.MAX_TRANSCRIPT_CHARS + 1)));
        assertThatThrownBy(() -> jobs.startKit(7, "en", 60, huge)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> jobs.startKit(7, "en\nignore", 60, lines())).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void 縮圖底圖_提示詞帶風格且要求不畫字_回_base64_記一張() {
        String id = jobs.startImage(7, "thumbnail", "neon cyberpunk", new byte[] {1, 2, 3, 4}, "image/png");
        PublishJobs.ImageView v = jobs.viewImage(7, id);
        assertThat(v.status()).isEqualTo("done");
        assertThat(Base64.getDecoder().decode(v.image())).containsExactly(9, 8, 7);
        assertThat(v.mime()).isEqualTo("image/webp");
        assertThat(image.prompts.get(0)).contains("neon cyberpunk").containsIgnoringCase("no text").endsWith("|image/png|4");
        assertThat(usage).containsExactly("7:/v1/ai/image:fake-image:1");
    }

    @Test
    void 縮圖_用途不對或沒有圖_拒絕_別的權杖看不到() {
        assertThatThrownBy(() -> jobs.startImage(7, "poster", "x", new byte[] {1}, "image/png")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> jobs.startImage(7, "thumbnail", "x", new byte[0], "image/png")).isInstanceOf(IllegalArgumentException.class);
        String id = jobs.startImage(7, "thumbnail", "", new byte[] {1}, "image/jpeg");
        assertThatThrownBy(() -> jobs.viewImage(8, id)).isInstanceOf(PublishJobs.NotFoundException.class);
        text.replies.add("{\"titles\":[\"a\"],\"description\":\"\",\"highlights\":[],\"chapters\":[],\"tags\":[]}");
        String kit = jobs.startKit(7, "zh", 60, lines());
        assertThatThrownBy(() -> jobs.viewKit(8, kit)).isInstanceOf(PublishJobs.NotFoundException.class);
    }

    @Test
    void 材質_產生新圖_描述後接無縫模板_正方形_記一張() {
        String id = jobs.startImage(7, "texture", "worn oak planks", null, null);
        PublishJobs.ImageView v = jobs.viewImage(7, id);
        assertThat(v.status()).isEqualTo("done");
        assertThat(Base64.getDecoder().decode(v.image())).containsExactly(5, 4);
        assertThat(image.prompts.get(0)).startsWith("worn oak planks").contains("seamless tileable texture").contains("no text").endsWith("|1024x1024");
        assertThat(usage).containsExactly("7:/v1/ai/image:fake-image:1");
    }

    @Test
    void 背景_產生新圖_16比9_不加無縫模板() {
        String id = jobs.startImage(7, "background", "a cozy classroom with a chalkboard", null, null);
        assertThat(jobs.viewImage(7, id).status()).isEqualTo("done");
        assertThat(image.prompts.get(0)).startsWith("a cozy classroom").doesNotContain("seamless").endsWith("|1792x1024");
    }

    @Test
    void 材質與背景_一定要描述() {
        assertThatThrownBy(() -> jobs.startImage(7, "texture", " ", null, null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> jobs.startImage(7, "background", null, null, null)).isInstanceOf(IllegalArgumentException.class);
    }
}
