package com.wordblade.gateway.usage;

import com.wordblade.gateway.config.GatewayProperties;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/** 用量紀錄（D29：只記錄、不設上限）與今日統計。 */
@Service
public class UsageService {

    /** 一組用量加總。 */
    public record Totals(long calls, long inputTokens, long outputTokens, long units) {}

    /** 單一路由的用量加總。 */
    public record RouteTotals(String route, Totals totals) {}

    private static final String SUM = "SELECT COUNT(*), COALESCE(SUM(input_tokens),0), "
            + "COALESCE(SUM(output_tokens),0), COALESCE(SUM(units),0) FROM usage_log";

    private final JdbcClient jdbc;
    private final ZoneId zone;

    public UsageService(JdbcClient jdbc, GatewayProperties props) {
        this.jdbc = jdbc;
        this.zone = ZoneId.of(props.timezone());
    }

    /** 今日日期（依設定時區）。 */
    public LocalDate today() {
        return LocalDate.now(zone);
    }

    /** 寫一筆用量。units 依路由而定（秒數、格數、張數等），不適用就填 0。 */
    public void record(long tokenId, String route, String model, long in, long out, long units) {
        jdbc.sql("""
                INSERT INTO usage_log(token_id, route, model, input_tokens, output_tokens, units)
                VALUES (:t, :r, :m, :i, :o, :u)""")
                .param("t", tokenId).param("r", route).param("m", model)
                .param("i", in).param("o", out).param("u", units).update();
    }

    /** 今日合計；tokenId 為 null 代表全站。 */
    public Totals todayTotals(Long tokenId) {
        String where = " WHERE created_at >= :s AND created_at < :e" + (tokenId == null ? "" : " AND token_id = :t");
        var q = jdbc.sql(SUM + where).param("s", start()).param("e", end());
        if (tokenId != null) q = q.param("t", tokenId);
        return q.query((rs, n) -> new Totals(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getLong(4))).single();
    }

    /** 今日某權杖依路由分組的合計。 */
    public List<RouteTotals> todayByRoute(long tokenId) {
        return jdbc.sql("SELECT route, COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), "
                        + "COALESCE(SUM(units),0) FROM usage_log WHERE token_id = :t AND created_at >= :s "
                        + "AND created_at < :e GROUP BY route ORDER BY route")
                .param("t", tokenId).param("s", start()).param("e", end())
                .query((rs, n) -> new RouteTotals(rs.getString(1),
                        new Totals(rs.getLong(2), rs.getLong(3), rs.getLong(4), rs.getLong(5))))
                .list();
    }

    private OffsetDateTime start() {
        return today().atStartOfDay(zone).toOffsetDateTime();
    }

    private OffsetDateTime end() {
        return today().plusDays(1).atStartOfDay(zone).toOffsetDateTime();
    }
}
