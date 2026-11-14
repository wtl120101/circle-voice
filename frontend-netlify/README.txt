========================================
  圈圈语音社 - 前端 (上传到 Netlify)
========================================

【这个文件夹上传到 Netlify】

包含文件：
  index.html    - 主站 SPA 页面
  admin.html    - 管理后台页面
  404.html      - 404 错误页面
  app.js        - 前端逻辑
  api.js        - API 调用封装
  styles.css    - 样式表
  _redirects    - Netlify 代理规则

部署步骤：
  1. 先部署后端（见 backend-server 文件夹），拿到后端地址
     例如：https://circle-voice-api.onrender.com

  2. 编辑本文件夹的 _redirects 文件：
     把 https://YOUR-BACKEND-URL 替换为实际后端地址

  3. 上传本文件夹所有内容到 Netlify
     （拖拽上传，或连接 Git 仓库）

  4. 在后端服务器设置环境变量：
     CORS_ORIGINS=https://你的netlify域名.netlify.app

注意：
  - Netlify 只能托管静态文件，无法运行 Python 后端
  - 所有 /api 和 /ws 请求通过 _redirects 代理到后端
