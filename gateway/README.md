# WordBlade 閘道（gateway）

Spring Boot 4.1.2＋Spring AI 2.0.2（OpenAI 模組，上游 Meta API）＋PostgreSQL（Flyway）。Java 21、Maven。
目前是骨架：邀請權杖驗證、用量紀錄表、`GET /v1/me`、CORS、Spring AI 設定。AI 路由（§6）之後再加。

## 內容

| 項目 | 說明 |
| --- | --- |
| 驗證 | `/v1/**` 要 `Authorization: Bearer <權杖>`；資料表 `invite_token` 只存 SHA-256，可停用（`disabled`）。缺少或無效一律 401 |
| 用量 | `usage_log`（token_id、route、model、input_tokens、output_tokens、units、created_at）；`UsageService.record(...)` 寫入。不設上限（D29） |
| `GET /v1/me` | 今日（`WORDBLADE_TIMEZONE`，預設 Asia/Taipei）自己的合計、依路由分組、與全站合計 |
| CORS | 放行清單來自設定，預設 `http://localhost:1420`、`http://tauri.localhost`；網頁版網域上線後用 `WORDBLADE_CORS_ALLOWED_ORIGINS`（逗號分隔）整份覆蓋 |
| Spring AI | `spring.ai.openai.base-url=https://api.meta.ai/v1`（2.0 改用 openai-java SDK，base-url 要含 `/v1`，SDK 自己補 `/chat/completions`） |

## 環境變數

見 `.env.example`（只有變數名）。金鑰與模型 ID 一律從環境變數讀，不寫進檔案。

| 變數 | 說明 | 預設 |
| --- | --- | --- |
| `META_API_KEY` | Meta API 金鑰 | 空（沒設也能啟動，只是呼叫 AI 會失敗） |
| `WORDBLADE_MODEL_SPARK` | Muse Spark 模型 ID | `muse-spark-1.3-contributor` |
| `WORDBLADE_MODEL_WONDER` | Muse Wonder 模型 ID | `muse-wonder-1.0` |
| `DB_URL` / `DB_USER` / `DB_PASSWORD` | PostgreSQL | `jdbc:postgresql://localhost:5432/wordblade`、`wordblade`、`wordblade` |
| `WORDBLADE_CORS_ALLOWED_ORIGINS` | CORS 放行清單 | 見上 |
| `WORDBLADE_TIMEZONE` | 「今日」的時區 | `Asia/Taipei` |

## 執行（PowerShell 7）

```powershell
# 1. 本機資料庫（需要 Docker）
cd gateway
docker compose up -d

# 2. 啟動（金鑰從專案根目錄 .env 載入到環境變數，不印出）
Get-Content ..\.env | Where-Object { $_ -match '^(META_API_KEY|WORDBLADE_MODEL_\w+)=' } |
  ForEach-Object { $k, $v = $_ -split '=', 2; Set-Item "Env:$k" $v }
mvn spring-boot:run          # 預設 http://localhost:8080
```

新增一把邀請權杖（只存雜湊；原文自己留著給使用者）：

```powershell
$token = 'wb-' + [guid]::NewGuid().ToString('N')
docker compose exec db psql -U wordblade -d wordblade -c "INSERT INTO invite_token(name, token_sha256) VALUES ('評審A', encode(sha256('$token'::bytea), 'hex'))"
$token   # 把這串交給使用者
curl.exe -H "Authorization: Bearer $token" http://localhost:8080/v1/me
```

停用權杖：`UPDATE invite_token SET disabled = TRUE WHERE name = '評審A';`

## 測試

```powershell
mvn -q test 2>&1 | Tee-Object logs\test.log
```

整合測試用 Testcontainers 起 `postgres:17`，**需要 Docker**；Docker 不可用時 `@Testcontainers(disabledWithoutDocker = true)` 會自動略過整個類別（不會失敗也不會卡住）。第一次要拉映像，會多花幾分鐘。

## 部署到 Zeabur（神奇網路主機）

```powershell
pwsh scripts/gateway-zeabur.ps1                    # 第一次會建專案 wordblade＋PostgreSQL；之後重跑＝同步變數＋重新部署＋驗證
pwsh scripts/gateway-zeabur.ps1 -VerifyOnly        # 只驗證線上版（無權杖 /v1/me 應回 401）
pwsh scripts/gateway-zeabur.ps1 -NewToken '評審A'   # 新增邀請權杖：原文只顯示一次，資料庫只存 SHA-256
```

- 公開網址：`https://wordblade-api.zeabur.app`（Wonder Mesh 自架主機經東京閘道；剛綁好時可能先拿到 Zeabur 自簽的佔位憑證）
- 專案、環境、服務 ID 記在 `gateway/zeabur.json`（不含祕密）；`META_API_KEY`、模型 ID 從專案根目錄 `.env` 帶入，紀錄只列變數名稱
- 紀錄：`logs/gateway-zeabur.log`
