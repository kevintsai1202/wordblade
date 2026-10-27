package com.wordblade.gateway.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/** 邀請權杖：資料表只存 SHA-256，原文不落地。 */
@Service
public class TokenService {

    /** 通過驗證的權杖身分。 */
    public record TokenInfo(long id, String name) {}

    private final JdbcClient jdbc;

    public TokenService(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** 計算權杖原文的 SHA-256（小寫十六進位）。 */
    public static String sha256(String raw) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(d);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** 以原文查詢有效（未停用）的權杖；查不到或已停用回 empty。 */
    public Optional<TokenInfo> authenticate(String raw) {
        return jdbc.sql("SELECT id, name FROM invite_token WHERE token_sha256 = :h AND NOT disabled")
                .param("h", sha256(raw))
                .query((rs, n) -> new TokenInfo(rs.getLong("id"), rs.getString("name")))
                .optional();
    }

    /** 新增一把權杖（只存雜湊），回傳 id。供管理腳本與測試使用。 */
    public long register(String name, String raw) {
        return jdbc.sql("INSERT INTO invite_token(name, token_sha256) VALUES (:n, :h) RETURNING id")
                .param("n", name).param("h", sha256(raw))
                .query(Long.class).single();
    }
}
