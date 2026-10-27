# WordBlade AI 閘道（Spring Boot＋Spring AI）。建置根目錄為 gateway/：
#   docker build -t wordblade-gateway gateway
# 金鑰（META_API_KEY）、模型 ID、資料庫連線以環境變數注入（見 .env.example），不要寫進映像。
# 基底映像用 AWS ECR 的 Docker 官方映像鏡像（Docker Hub 匿名拉取在 Zeabur 節點上常遇 429）。
FROM public.ecr.aws/docker/library/maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src src
# 測試要 Testcontainers（Docker），建置映像時略過；測試在本機跑
RUN mvn -B -q package -DskipTests

# 執行階段用 jammy（Ubuntu 22.04）變體：原專案在同一個自架節點上，21-jre（24.04）層解壓斷線後快取壞掉、java exec format error
FROM public.ecr.aws/docker/library/eclipse-temurin:21-jre-jammy
WORKDIR /app
RUN useradd --system --uid 10001 gateway
COPY --from=build /src/target/gateway-0.0.1-SNAPSHOT.jar /app/app.jar
# Zeabur 內網只開服務宣告的 web 埠 8080（Dockerfile 的 EXPOSE 不會被採用）
ENV PORT=8080
EXPOSE 8080
USER gateway
# 記憶體上限跟著容器配額走，不用 JVM 預設的 1/4
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/app.jar"]
