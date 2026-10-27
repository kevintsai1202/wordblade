-- 邀請權杖：只存 SHA-256（小寫十六進位），可停用
CREATE TABLE invite_token (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT        NOT NULL,
    token_sha256 CHAR(64)    NOT NULL UNIQUE,
    disabled     BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 用量紀錄（D29：只記錄，不設上限）。units 依路由：音訊秒數、影片格數、圖片張數等
CREATE TABLE usage_log (
    id            BIGSERIAL PRIMARY KEY,
    token_id      BIGINT      NOT NULL REFERENCES invite_token(id),
    route         TEXT        NOT NULL,
    model         TEXT,
    input_tokens  BIGINT      NOT NULL DEFAULT 0,
    output_tokens BIGINT      NOT NULL DEFAULT 0,
    units         BIGINT      NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_log_created ON usage_log(created_at);
CREATE INDEX idx_usage_log_token_created ON usage_log(token_id, created_at);
