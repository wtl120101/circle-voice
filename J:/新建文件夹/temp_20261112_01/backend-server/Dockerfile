# ============================================================
# 圈圈语音社 - 后端 Docker 部署 (支持 Railway / Render / Fly.io / VPS)
# 前端由 Netlify 托管，后端提供 API + WebSocket + 兜底页面
# ============================================================

FROM python:3.11-slim

WORKDIR /app

# 安装系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# 安装 Python 依赖
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制后端代码
COPY backend/ ./backend/

# 创建静态文件目录（前端在 Netlify，这里只放兜底页面）
RUN mkdir -p /app/static /app/uploads /app/logs
RUN echo '<!DOCTYPE html><html><head><meta charset="utf-8"><title>圈圈语音社</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d0b1a;color:#fff;flex-direction:column"><h1>圈圈语音社</h1><p>后端 API 服务运行中</p><p style="opacity:.6">请通过前端域名访问完整功能</p></body></html>' > /app/static/index.html
RUN echo '<!DOCTYPE html><html><head><meta charset="utf-8"><title>404</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d0b1a;color:#fff;flex-direction:column"><h1 style="font-size:72px;margin:0">404</h1><p>页面不存在</p></body></html>' > /app/static/404.html

# 环境变量
ENV STATIC_DIR=/app/static
ENV PYTHONUNBUFFERED=1

# 暴露端口
EXPOSE 8000

# 启动
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
