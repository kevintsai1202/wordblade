package spike;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import org.springframework.ai.chat.client.AdvisorParams;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.ResponseEntity;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.content.Media;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.core.io.FileSystemResource;
import org.springframework.util.MimeType;

/**
 * Spring AI 對 Meta Muse API 的實測（spec §5.11、§6）。
 * 所有請求經 {@link CaptureProxy} 轉送以取得「實際送出的請求本體」。
 * 金鑰與模型 ID 只從環境變數讀（META_API_KEY、WORDBLADE_MODEL_SPARK、WORDBLADE_MODEL_WONDER）。
 * 步驟用 --steps=a1,a2,... 指定（預設全跑）。
 */
@SpringBootApplication
public class SpikeApp {

    /** 結構化輸出測試用的 record。 */
    public record Report(String topic, List<String> keyPoints, boolean hasSlides) {}

    /** AI 導演風格的工具（Wonder 工具呼叫測試）：只記錄被呼叫的參數。 */
    public static class DirectorTools {
        public final List<String> calls = new ArrayList<>();

        @Tool(description = "Propose cutting a time range out of the video, e.g. a stumble or a long pause.")
        public String proposeCut(@ToolParam(description = "start seconds") double start,
                                 @ToolParam(description = "end seconds") double end,
                                 @ToolParam(description = "one-sentence reason") String reason) {
            calls.add("proposeCut(" + start + "," + end + ")");
            return "accepted";
        }
    }

    static CaptureProxy proxy;

    public static void main(String[] args) throws Exception {
        proxy = CaptureProxy.start("https://api.meta.ai", Path.of("logs"));
        var app = new SpringApplication(SpikeApp.class);
        app.setDefaultProperties(Map.of(
                "spring.main.web-application-type", "none",
                "spring.ai.openai.base-url", "http://127.0.0.1:" + proxy.port() + "/v1",
                "spring.ai.openai.api-key", System.getenv("META_API_KEY")));
        System.exit(SpringApplication.exit(app.run(args)));
    }

    @Bean
    ApplicationRunner runner(ChatClient.Builder builder) {
        return args -> run(builder.build(), args);
    }

    /** 逐步執行並印出每步的結果摘要（不含金鑰）。 */
    private void run(ChatClient chat, ApplicationArguments args) throws Exception {
        String spark = System.getenv("WORDBLADE_MODEL_SPARK");
        String wonder = System.getenv("WORDBLADE_MODEL_WONDER");
        List<String> only = args.containsOption("steps") ? List.of(args.getOptionValues("steps").get(0).split(",")) : null;
        Path media = Path.of("media");
        MimeType mp4 = MimeType.valueOf("video/mp4");
        String txt = "Lecture transcript: 'Today we look at how a hash map resolves collisions using chaining. "
                + "Um, sorry, I mean open addressing. The slide shows a table with eight buckets.' "
                + "Summarise it as the requested structure.";

        // a1：預設的 .entity()（BeanOutputConverter，把 schema 寫進 prompt，不用 response_format）
        step(only, "a1-entity-default", () -> {
            ResponseEntity<ChatResponse, Report> r = chat.prompt().user(txt)
                    .options(OpenAiChatOptions.builder().model(spark).reasoningEffort("low"))
                    .call().responseEntity(Report.class);
            return summary(r.response(), r.entity());
        });
        // a2：原生結構化輸出（response_format json_schema）
        step(only, "a2-entity-native", () -> {
            ResponseEntity<ChatResponse, Report> r = chat.prompt().advisors(AdvisorParams.ENABLE_NATIVE_STRUCTURED_OUTPUT)
                    .user(txt)
                    .options(OpenAiChatOptions.builder().model(spark).reasoningEffort("low"))
                    .call().responseEntity(Report.class);
            return summary(r.response(), r.entity());
        });
        // b1：30 秒影片（480p、2fps、無聲）
        step(only, "b1-video30", () -> videoCall(chat, spark, media.resolve("clip30.mp4"), mp4));
        // b2：10 秒影片，和 b1 相減得每格 token
        step(only, "b2-video10", () -> videoCall(chat, spark, media.resolve("clip10.mp4"), mp4));
        // b3：退路，10 張關鍵格圖片
        step(only, "b3-images10", () -> {
            List<Media> imgs = new ArrayList<>();
            for (int i = 1; i <= 10; i++) {
                imgs.add(new Media(MimeType.valueOf("image/jpeg"), new FileSystemResource(media.resolve("frames/k%02d.jpg".formatted(i)))));
            }
            ChatResponse r = chat.prompt().user(u -> u.text("These are 10 keyframes (one every 3 seconds) of a lecture video. Describe what is on screen in two sentences.")
                            .media(imgs.toArray(Media[]::new)))
                    .options(OpenAiChatOptions.builder().model(spark).reasoningEffort("low"))
                    .call().chatResponse();
            return summary(r, null);
        });
        // b4：單張圖片，量一張圖的 token
        step(only, "b4-image1", () -> {
            ChatResponse r = chat.prompt().user(u -> u.text("Describe this image in one sentence.")
                            .media(new Media(MimeType.valueOf("image/jpeg"), new FileSystemResource(media.resolve("frames/k01.jpg")))))
                    .options(OpenAiChatOptions.builder().model(spark).reasoningEffort("low"))
                    .call().chatResponse();
            return summary(r, null);
        });
        // b5：影片＋原生結構化輸出（AI 導演實際會用的組合）
        step(only, "b5-video10-structured", () -> {
            ResponseEntity<ChatResponse, Report> r = chat.prompt().advisors(AdvisorParams.ENABLE_NATIVE_STRUCTURED_OUTPUT)
                    .user(u -> u.text("This is a silent 10-second lecture clip. Report the topic, key points and whether slides are visible.")
                            .media(new Media(mp4, new FileSystemResource(media.resolve("clip10.mp4")))))
                    .options(OpenAiChatOptions.builder().model(spark).reasoningEffort("low"))
                    .call().responseEntity(Report.class);
            return summary(r.response(), r.entity());
        });
        // d1：Wonder 一般呼叫
        step(only, "d1-wonder-plain", () -> {
            ChatResponse r = chat.prompt().user("In one sentence: what does a video editor's ripple delete do?")
                    .options(OpenAiChatOptions.builder().model(wonder).reasoningEffort("medium"))
                    .call().chatResponse();
            return summary(r, null);
        });
        // d2：Wonder 原生結構化輸出
        step(only, "d2-wonder-structured", () -> {
            ResponseEntity<ChatResponse, Report> r = chat.prompt().advisors(AdvisorParams.ENABLE_NATIVE_STRUCTURED_OUTPUT)
                    .user(txt)
                    .options(OpenAiChatOptions.builder().model(wonder).reasoningEffort("medium"))
                    .call().responseEntity(Report.class);
            return summary(r.response(), r.entity());
        });
        // d3：Wonder 工具呼叫（@Tool）
        step(only, "d3-wonder-tool", () -> toolCall(chat, wonder, "medium"));
        // d4：Spark 工具呼叫（退路是否可用）
        step(only, "d4-spark-tool", () -> toolCall(chat, spark, "low"));
        // d5：Wonder 看影片（Wonder 是否也吃影片 Media）
        step(only, "d5-wonder-video10", () -> videoCall(chat, wonder, media.resolve("clip10.mp4"), mp4));
    }

    /** 影片 Media 呼叫。 */
    private String videoCall(ChatClient chat, String model, Path file, MimeType mime) {
        ChatResponse r = chat.prompt().user(u -> u.text("This is a silent screen recording of a lecture. Describe what is on screen in two sentences.")
                        .media(new Media(mime, new FileSystemResource(file))))
                .options(OpenAiChatOptions.builder().model(model).reasoningEffort("low"))
                .call().chatResponse();
        return summary(r, null);
    }

    /** 工具呼叫：要求模型必須呼叫 proposeCut。 */
    private String toolCall(ChatClient chat, String model, String effort) {
        var tools = new DirectorTools();
        ChatResponse r = chat.prompt().tools(tools)
                .user("Segment report: between 12.0s and 15.5s the speaker stumbles and restarts the sentence. "
                        + "Use the proposeCut tool to propose removing that stumble, then reply 'done'.")
                .options(OpenAiChatOptions.builder().model(model).reasoningEffort(effort))
                .call().chatResponse();
        return summary(r, "toolCalls=" + tools.calls);
    }

    /** 取出 usage 與回覆前 200 字。 */
    private String summary(ChatResponse r, Object entity) {
        var u = r.getMetadata().getUsage();
        String text = r.getResult() == null || r.getResult().getOutput().getText() == null ? "" : r.getResult().getOutput().getText();
        return "model=" + r.getMetadata().getModel() + " promptTokens=" + u.getPromptTokens()
                + " completionTokens=" + u.getCompletionTokens() + " total=" + u.getTotalTokens()
                + (entity == null ? "" : " entity=" + entity)
                + " text=" + text.replace("\n", " ").substring(0, Math.min(200, text.length()));
    }

    /** 執行單一步驟並計時；例外視為「不可行」並記下類別與訊息（訊息取前 300 字）。 */
    private void step(List<String> only, String name, Callable<String> body) {
        if (only != null && only.stream().noneMatch(name::startsWith)) return;
        proxy.step = name;
        long t0 = System.nanoTime();
        String result;
        try {
            result = "OK " + body.call();
        } catch (Throwable e) {
            String m = String.valueOf(e.getMessage());
            result = "FAIL " + e.getClass().getSimpleName() + ": " + m.substring(0, Math.min(300, m.length()));
        }
        long ms = (System.nanoTime() - t0) / 1_000_000;
        String line = "[%s] total=%dms upstream=%dms %s".formatted(name, ms, proxy.lastUpstreamMs, result);
        System.out.println("SPIKE " + line);
        try {
            Files.writeString(Path.of("logs/results.txt"), line + "\n",
                    java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
        } catch (Exception ignored) {
        }
    }
}
