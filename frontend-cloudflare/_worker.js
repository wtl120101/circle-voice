// Cloudflare Pages 高级模式 Worker
// 作用：把 /api/* 与 /uploads/* 反向代理到 Railway 后端，站点其余请求走静态资源
// 说明：Cloudflare Pages 的 _redirects 只能代理站内相对路径，不能代理外部域名，
//       因此这里用 Worker 完成代理，保持前后端同源，无需在浏览器端配置跨域。

const BACKEND = "https://noble-ambition-production-1276da69.up.railway.app";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket：Pages 无法代理长连接，直接返回明确错误，避免前端反复重连卡住
    if (path === "/ws") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "当前 Cloudflare Pages 部署不支持 WebSocket，语音房实时消息不可用",
        }),
        { status: 501, headers: { "content-type": "application/json; charset=utf-8" } }
      );
    }

    // 接口与上传文件代理到后端
    if (path === "/api" || path.startsWith("/api/") || path.startsWith("/uploads/")) {
      return proxyToBackend(request, url);
    }

    // 静态资源
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) return res;

    // /admin 映射到管理后台页面
    if (path === "/admin" || path === "/admin/") {
      return env.ASSETS.fetch(new Request(new URL("/admin.html", url), request));
    }

    // 无扩展名的路径按 SPA 处理，回退首页
    if (!/\.[a-z0-9]+$/i.test(path)) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }

    // 其余视为不存在的资源，返回 404 页面并保持 404 状态码
    const notFound = await env.ASSETS.fetch(new Request(new URL("/404.html", url), request));
    return new Response(notFound.body, {
      status: 404,
      headers: notFound.headers,
    });
  },
};

async function proxyToBackend(request, url) {
  const target = BACKEND + url.pathname + url.search;
  try {
    const upstream = await fetch(new Request(target, request));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: "后端服务暂时不可达：" + String(err) }),
      { status: 502, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
}
