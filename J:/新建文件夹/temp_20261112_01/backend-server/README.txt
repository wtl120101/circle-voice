========================================
  圈圈语音社 - 后端 (部署到服务器)
========================================

【这个文件夹部署到云服务器 / Render / Railway 等支持 Python 的平台】

包含文件：
  backend/
    main.py            - FastAPI 后端主程序
    requirements.txt   - Python 依赖
    migrate.py         - 数据库迁移脚本
  nginx.conf           - Nginx 配置（前后端同服时用）
  deploy.ps1           - Windows 端打包上传脚本
  server-deploy.sh     - 服务器端部署脚本
  .env.example         - 环境变量模板

服务器要求：
  - Python 3.10+
  - （可选）Nginx（前后端同服部署时）

部署步骤（VPS / 云服务器）：
  1. 上传本文件夹到服务器，例如 /opt/circle-voice
     方法A：在 Windows 上运行 deploy.ps1（需先修改里面的服务器配置）
     方法B：用 scp / FTP 手动上传

  2. SSH 到服务器，运行：
     cd /opt/circle-voice
     bash server-deploy.sh
     （脚本会自动安装依赖、创建 .env、启动后端）

  3. 编辑 .env 文件，填写：
     TOKEN_SECRET=随机长字符串
     ADMIN_PASSWORD=管理员密码
     CORS_ORIGINS=https://你的前端域名

部署步骤（Render 等 PaaS 平台）：
  1. 连接 Git 仓库，选择 backend 子目录
  2. Build Command: pip install -r requirements.txt
  3. Start Command: uvicorn backend.main:app --host 0.0.0.0 --port $PORT
  4. 设置环境变量（TOKEN_SECRET, ADMIN_PASSWORD, CORS_ORIGINS）
