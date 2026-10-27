# WordBlade 網頁版：nginx 提供 vite build 的靜態檔（部署目錄由 scripts/web-zeabur.ps1 組：Dockerfile、nginx.conf、dist/）。
# 基底映像用 AWS ECR 的 Docker 官方映像鏡像（Docker Hub 匿名拉取在 Zeabur 節點上常遇 429）。
FROM public.ecr.aws/docker/library/nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist /usr/share/nginx/html
EXPOSE 8080
