#!/usr/bin/env bash
# =============================================================
# 圈圈语音社 — 服务器端部署脚本
# 在服务器项目根目录下执行：bash server-deploy.sh
# 功能：安装依赖 → 配置环境 → 启动后端 → 配置 Nginx
# =============================================================
set -e

echo "=========================================="
echo "  圈圈语音社 服务器部署脚本"
echo "=========================================="

# 项目根目录（脚本所在目录）
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# ---------- 1. 检查 Python ----------
echo "[1/6] 检查 Python 环境..."
if ! command -v python3 &>/dev/null; then
    echo "[错误] 未找到 python3，请先安装 Python 3.10+"
    exit 1
fi
PYTHON=$(command -v python3)
echo "  Python: $($PYTHON --version)"

# ---------- 2. 创建虚拟环境并安装依赖 ----------
echo "[2/6] 安装 Python 依赖..."
if [ ! -d "venv" ]; then
    $PYTHON -m venv venv
fi
source venv/bin/activate
pip install --upgrade pip -q
pip install -r backend/requirements.txt -q
echo "  依赖安装完成"

# ---------- 3. 检查环境变量文件 ----------
echo "[3/6] 检查环境变量配置..."
if [ ! -f ".env" ]; then
    echo "  未找到 .env 文件，正在从模板创建..."
    cp .env.example .env
    echo ""
    echo "  ⚠️  请编辑 .env 文件，填入以下关键配置："
    echo "     TOKEN_SECRET      — 随机字符串（必填）"
    echo "     ADMIN_PASSWORD    — 管理员密码（必填）"
    echo "     CORS_ORIGINS      — 你的域名（必填）"
    echo "     DATABASE_URL      — 数据库连接（可选，默认 SQLite）"
    echo ""
    read -p "  编辑完成后按回车继续，或按 Ctrl+C 退出..." _
fi

# ---------- 4. 创建必要目录 ----------
echo "[4/6] 创建运行时目录..."
mkdir -p frontend/uploads
mkdir -p logs
chmod 755 frontend/uploads
echo "  目录创建完成"

# ---------- 5. 启动后端 ----------
echo "[5/6] 启动后端服务..."

# 停止旧进程
if [ -f "logs/backend.pid" ]; then
    OLD_PID=$(cat logs/backend.pid)
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "  停止旧进程 PID=$OLD_PID"
        kill "$OLD_PID" 2>/dev/null || true
        sleep 2
    fi
fi

# 加载环境变量并启动
set -a
source .env
set +a

nohup venv/bin/uvicorn backend.main:app \
    --host 127.0.0.1 \
    --port 8000 \
    --workers 1 \
    > logs/backend.log 2>&1 &

echo $! > logs/backend.pid
sleep 3

# 检查是否启动成功
if kill -0 "$(cat logs/backend.pid)" 2>/dev/null; then
    echo "  后端已启动 PID=$(cat logs/backend.pid)"
else
    echo "[错误] 后端启动失败，请查看日志："
    cat logs/backend.log
    exit 1
fi

# ---------- 6. 配置 Nginx ----------
echo "[6/6] 配置 Nginx..."

# 替换 nginx.conf 中的占位符
NGINX_CONF="nginx.conf"
if [ -f "$NGINX_CONF" ]; then
    # 让用户输入域名
    read -p "  请输入你的域名（如 www.example.com）: " DOMAIN
    if [ -z "$DOMAIN" ]; then
        DOMAIN="localhost"
    fi

    # 替换占位符
    sed -i "s|YOUR_DOMAIN|$DOMAIN|g" "$NGINX_CONF"
    sed -i "s|PROJECT_ROOT|$PROJECT_DIR|g" "$NGINX_CONF"

    echo "  已生成 nginx.conf（域名: $DOMAIN）"
    echo ""
    echo "  ⚠️  请手动完成以下 Nginx 配置："
    echo "     1. 将证书路径替换为实际路径（CERT_PATH / KEY_PATH）"
    echo "     2. 复制配置: sudo cp $PROJECT_DIR/nginx.conf /etc/nginx/nginx.conf"
    echo "     3. 测试配置: sudo nginx -t"
    echo "     4. 重载: sudo nginx -s reload"
    echo ""
    echo "  如暂无 SSL 证书，可临时注释 SSL server 块，仅用 80 端口测试。"
else
    echo "  [警告] 未找到 nginx.conf，跳过 Nginx 配置"
fi

echo ""
echo "=========================================="
echo "  部署完成！"
echo "=========================================="
echo ""
echo "后端地址: http://127.0.0.1:8000"
echo "后端日志: tail -f $PROJECT_DIR/logs/backend.log"
echo "停止后端: kill \$(cat $PROJECT_DIR/logs/backend.pid)"
echo ""
