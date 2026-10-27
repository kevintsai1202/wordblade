package spike;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

/**
 * 本機擷取代理：Spring AI 把請求送到這裡，代理原樣轉給 Meta，並把「實際送出的請求本體」與回應存檔。
 * 存檔前會把 base64 長字串截短；Authorization 標頭只轉送、絕不寫入任何檔案。
 */
public class CaptureProxy {

    /** 目前進行中的實測步驟名稱，會成為存檔檔名的一部分。 */
    public volatile String step = "init";

    /** 最近一次上游呼叫的耗時（毫秒），給實測步驟讀取。 */
    public volatile long lastUpstreamMs;

    private final String upstream;
    private final Path dir;
    private final HttpServer server;
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(30)).build();
    private final AtomicInteger seq = new AtomicInteger();

    // data URI 與裸 base64 長字串都截短，保持存檔可讀
    private static final Pattern DATA_URI = Pattern.compile("\"(data:[a-zA-Z0-9/+.\\-]+;base64,)([A-Za-z0-9+/=]{40,})\"");
    private static final Pattern BARE_B64 = Pattern.compile("\"([A-Za-z0-9+/=]{200,})\"");

    /** 啟動代理，回傳實例；port 由系統配置。 */
    public static CaptureProxy start(String upstream, Path dir) throws IOException {
        return new CaptureProxy(upstream, dir);
    }

    private CaptureProxy(String upstream, Path dir) throws IOException {
        this.upstream = upstream;
        this.dir = dir;
        Files.createDirectories(dir);
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", this::handle);
        server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
        server.start();
    }

    public int port() {
        return server.getAddress().getPort();
    }

    /** 轉送單一請求並存檔。 */
    private void handle(HttpExchange ex) throws IOException {
        byte[] body = ex.getRequestBody().readAllBytes();
        String path = ex.getRequestURI().toString();
        var rb = HttpRequest.newBuilder(URI.create(upstream + path)).timeout(Duration.ofMinutes(10))
                .method(ex.getRequestMethod(), body.length == 0
                        ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
        for (String h : new String[]{"Content-Type", "Authorization", "Accept"}) {
            String v = ex.getRequestHeaders().getFirst(h);
            if (v != null) rb.header(h, v);
        }
        long t0 = System.nanoTime();
        int status;
        byte[] resp;
        try {
            HttpResponse<byte[]> r = client.send(rb.build(), HttpResponse.BodyHandlers.ofByteArray());
            status = r.statusCode();
            resp = r.body();
        } catch (Exception e) {
            status = 599;
            resp = ("proxy error: " + e.getClass().getSimpleName()).getBytes(StandardCharsets.UTF_8);
        }
        long ms = (System.nanoTime() - t0) / 1_000_000;
        lastUpstreamMs = ms;
        save(path, body, status, resp, ms);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(status, resp.length);
        ex.getResponseBody().write(resp);
        ex.close();
    }

    /** 存檔：只含路徑、截短後的請求本體、狀態碼、耗時、回應本體（過長截斷）。 */
    private void save(String path, byte[] req, int status, byte[] resp, long ms) throws IOException {
        String reqText = new String(req, StandardCharsets.UTF_8);
        reqText = DATA_URI.matcher(reqText).replaceAll(m -> "\"" + java.util.regex.Matcher.quoteReplacement(m.group(1))
                + "<base64 " + m.group(2).length() + " chars>\"");
        reqText = BARE_B64.matcher(reqText).replaceAll(m -> "\"<base64 " + m.group(1).length() + " chars>\"");
        String respText = new String(resp, StandardCharsets.UTF_8);
        if (respText.length() > 6000) respText = respText.substring(0, 6000) + "...<truncated>";
        String out = "POST " + path + "\nrequest_bytes: " + req.length + "\nstatus: " + status
                + "\nupstream_ms: " + ms + "\n\n--- request body ---\n" + reqText
                + "\n\n--- response body ---\n" + respText + "\n";
        Files.writeString(dir.resolve("capture-%02d-%s.txt".formatted(seq.incrementAndGet(), step)), out);
    }
}
