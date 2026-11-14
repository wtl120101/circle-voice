/* 圈圈语音社：统一 REST 与 WebSocket 客户端 */
const API_BASE = "";
const TOKEN_KEY = "cv_token";
const USER_KEY = "cv_user";
const LOGGED_OUT_KEY = "cv_logged_out";

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(token) { if (token) localStorage.setItem(TOKEN_KEY, token); }
function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
  catch { return null; }
}
function setUser(user) {
  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    window.dispatchEvent(new CustomEvent("api-user", { detail: user }));
  }
}
function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function request(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  // 只有调用方没显式传 Authorization 时，才用当前登录用户 token
  if (!headers.Authorization) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  try {
    const response = await fetch(API_BASE + path, { ...options, headers });
    const data = await response.json().catch(() => ({ success: false, error: "服务器返回格式不正确", data: null }));
    if (response.status === 401 && !path.includes("/auth/login")) {
      clearSession();
      realtime.close();
    }
    if (!data.success) console.warn(`[API] ${path}:`, data.error || response.statusText);
    return data;
  } catch (error) {
    console.error(`[API] ${path}:`, error);
    return { success: false, data: null, error: "无法连接服务器，请确认后端已启动" };
  }
}

function query(params) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(key, value);
  });
  const text = search.toString();
  return text ? `?${text}` : "";
}

const realtimeListeners = new Map();
const realtime = {
  socket: null,
  reconnectTimer: null,
  reconnectDelay: 1000,
  manualClose: false,

  connect() {
    const token = getToken();
    if (!token || (this.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState))) return;
    this.manualClose = false;
    clearTimeout(this.reconnectTimer);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`);
    this.socket.addEventListener("open", () => {
      this.reconnectDelay = 1000;
      emitRealtime("connection", { connected: true });
    });
    this.socket.addEventListener("message", event => {
      try {
        const message = JSON.parse(event.data);
        emitRealtime(message.type, message.data);
      } catch (error) {
        console.warn("[WS] 无法解析消息", error);
      }
    });
    this.socket.addEventListener("close", () => {
      this.socket = null;
      emitRealtime("connection", { connected: false });
      if (!this.manualClose && getToken()) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
      }
    });
    this.socket.addEventListener("error", () => emitRealtime("connection", { connected: false }));
  },

  close() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    if (this.socket) this.socket.close();
    this.socket = null;
  },

  send(type, data = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type, data }));
    return true;
  },

  on(type, handler) {
    if (!realtimeListeners.has(type)) realtimeListeners.set(type, new Set());
    realtimeListeners.get(type).add(handler);
    return () => realtimeListeners.get(type)?.delete(handler);
  },
};

function emitRealtime(type, data) {
  realtimeListeners.get(type)?.forEach(handler => {
    try { handler(data); } catch (error) { console.error(`[WS] ${type} 处理失败`, error); }
  });
}

const api = {
  get user() { return getUser(); },
  get token() { return getToken(); },
  get connected() { return realtime.socket?.readyState === WebSocket.OPEN; },

  async login(phone, nickname, code = null) {
    const body = { phone };
    if (nickname) body.nickname = nickname;
    if (code) body.code = code;
    const result = await request("/api/auth/login", { method: "POST", body: JSON.stringify(body) });
    if (result.success) {
      localStorage.removeItem(LOGGED_OUT_KEY);
      setToken(result.data.token);
      setUser(result.data.user);
      realtime.close();
      realtime.connect();
    }
    return result;
  },

  async sendCode(phone) {
    return request("/api/auth/send-code", { method: "POST", body: JSON.stringify({ phone }) });
  },

  async oauthLogin(provider, openid, nickname = "", avatar = "", gender = "") {
    const result = await request("/api/auth/oauth", {
      method: "POST", body: JSON.stringify({ provider, openid, nickname, avatar, gender }),
    });
    if (result.success) {
      localStorage.removeItem(LOGGED_OUT_KEY);
      setToken(result.data.token);
      setUser(result.data.user);
      realtime.close();
      realtime.connect();
    }
    return result;
  },

  async adminLogin(username, password) {
    return request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  },

  async adminRequest(path, options = {}) {
    const adminToken = localStorage.getItem("cv_admin_token");
    const headers = options.headers || {};
    if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
    return request(path, { ...options, headers });
  },

  platformStats: () => {
    const adminToken = localStorage.getItem("cv_admin_token");
    return api.adminRequest("/api/platform/stats", { headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {} });
  },

  adminShop: () => {
    const adminToken = localStorage.getItem("cv_admin_token");
    return api.adminRequest("/api/admin/shop", { headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {} });
  },

  adminShopCreate: data => api.adminRequest("/api/admin/shop", {
    method: "POST", body: JSON.stringify(data),
  }),

  adminShopUpdate: (id, data) => api.adminRequest(`/api/admin/shop/${id}`, {
    method: "PUT", body: JSON.stringify(data),
  }),

  adminShopDelete: id => api.adminRequest(`/api/admin/shop/${id}`, { method: "DELETE" }),

  logout() {
    localStorage.setItem(LOGGED_OUT_KEY, "1");
    realtime.close();
    clearSession();
  },

  me: () => request("/api/auth/me"),
  profile: () => request("/api/profile"),
  updateProfile: data => request("/api/profile", { method: "PATCH", body: JSON.stringify(data) }),
  getUser: id => request(`/api/users/${id}`),
  nearby: () => request("/api/users/nearby"),
  follow: id => request(`/api/users/${id}/follow`, { method: "POST" }),
  blocks: () => request("/api/blocks"),
  toggleBlock: id => request(`/api/blocks/${id}`, { method: "POST" }),
  search: q => request(`/api/search${query({ q })}`),

  discover: (page = 1, size = 20, tab = "recommend") => request(`/api/feed/discover${query({ page, size, tab })}`),
  post: (content, image = null, location = null, circleId = null) => request("/api/feed/post", {
    method: "POST", body: JSON.stringify({ content, image, location, circle_id: circleId }),
  }),
  likePost: id => request(`/api/feed/post/${id}/like`, { method: "POST" }),
  comments: id => request(`/api/feed/post/${id}/comments`),
  addComment: (id, content) => request(`/api/feed/post/${id}/comments`, {
    method: "POST", body: JSON.stringify({ content }),
  }),

  matchCards: (filters = {}) => request(`/api/match/cards${query(filters)}`),
  matchAction: (targetId, action) => request("/api/match/action", {
    method: "POST", body: JSON.stringify({ target_id: targetId, action }),
  }),
  undoMatch: targetId => request(`/api/match/action/${targetId}`, { method: "DELETE" }),
  matchList: () => request("/api/match/list"),

  voiceRooms: (category = "", followed = false) => request(`/api/voice/rooms${query({ category, followed: followed ? 1 : "" })}`),
  createRoom: (topic, category) => request("/api/voice/rooms", {
    method: "POST", body: JSON.stringify({ topic, category }),
  }),
  joinRoom: id => request(`/api/voice/rooms/${id}/join`, { method: "POST" }),
  roomMessages: id => request(`/api/voice/rooms/${id}/messages`),
  sendRoomMessage: (id, content) => request(`/api/voice/rooms/${id}/messages`, {
    method: "POST", body: JSON.stringify({ content }),
  }),
  roomAction: (id, action) => request(`/api/voice/rooms/${id}/action`, {
    method: "POST", body: JSON.stringify({ action }),
  }),
  gifts: () => request("/api/gifts"),
  sendGift: (roomId, giftKey, count = 1) => request(`/api/voice/rooms/${roomId}/gift`, {
    method: "POST", body: JSON.stringify({ gift_key: giftKey, count }),
  }),

  circles: () => request("/api/circles"),
  createCircle: (name, icon) => request("/api/circles", {
    method: "POST", body: JSON.stringify({ name, icon }),
  }),
  joinCircle: id => request(`/api/circles/${id}/join`, { method: "POST" }),
  circlePosts: (id, page = 1) => request(`/api/circles/${id}/posts${query({ page })}`),
  circleRank: id => request(`/api/circles/${id}/rank`),

  conversations: () => request("/api/chat/conversations"),
  messages: (peerId, page = 1, size = 50) => request(`/api/chat/messages/${peerId}${query({ page, size })}`),
  sendMessage: (targetId, content, msgType = "text") => request("/api/chat/send", {
    method: "POST", body: JSON.stringify({ target_id: targetId, content, msg_type: msgType }),
  }),
  uploadFile: async file => {
    const form = new FormData();
    form.append("file", file);
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const response = await fetch(API_BASE + "/api/upload", { method: "POST", body: form, headers });
      const data = await response.json().catch(() => ({ success: false, data: null, error: "服务器返回格式不正确" }));
      if (response.status === 401) { clearSession(); realtime.close(); }
      return data;
    } catch (error) {
      console.error("[API] /api/upload:", error);
      return { success: false, data: null, error: "无法连接服务器，请确认后端已启动" };
    }
  },

  notifications: (type = "") => request(`/api/notifications${query({ type_filter: type })}`),
  markAllRead: () => request("/api/notifications/read-all", { method: "POST" }),
  vipPay: (plan, payMethod = "wechat") => request("/api/vip/pay", {
    method: "POST", body: JSON.stringify({ plan, pay_method: payMethod }),
  }),
  wallet: () => request("/api/wallet"),
  recharge: (coins, payMethod = "wechat") => request("/api/wallet/recharge", {
    method: "POST", body: JSON.stringify({ coins, pay_method: payMethod }),
  }),
  queryOrder: (outTradeNo) => request(`/api/pay/order/${outTradeNo}`),
  tasks: () => request("/api/tasks"),
  completeTask: key => request(`/api/tasks/${key}/complete`, { method: "POST" }),
  stats: () => request("/api/stats"),
  health: () => request("/api/health"),

  // ---- 商城 ----
  shop: (category = "") => request(`/api/shop${category ? "?category=" + category : ""}`),
  categories: () => request("/api/categories"),
  purchase: itemKey => request("/api/shop/purchase", { method: "POST", body: JSON.stringify({ item_key: itemKey }) }),
  orderPhysical: data => request("/api/shop/order", { method: "POST", body: JSON.stringify(data) }),
  myOrders: () => request("/api/shop/orders"),
  redeem: itemKey => request(`/api/shop/redeem?item_key=${encodeURIComponent(itemKey)}`, { method: "POST" }),
  inventory: () => request("/api/me/inventory"),

  // ---- 实名认证 ----
  realnameSubmit: data => request("/api/realname/submit", { method: "POST", body: JSON.stringify(data) }),
  realnameStatus: () => request("/api/realname/status"),

  // ---- 频道发帖（增强版） ----
  postV2: data => request("/api/feed/v2/post", { method: "POST", body: JSON.stringify(data) }),

  // ---- 语音房 ----
  voiceRooms: (category = "") => request(`/api/voice/rooms${category ? "?category=" + category : ""}`),
  createRoom: data => request("/api/voice/rooms/create", { method: "POST", body: JSON.stringify(data) }),
  joinRoom: id => request(`/api/voice/rooms/${id}/join`, { method: "POST" }),
  roomMessages: id => request(`/api/voice/rooms/${id}/messages`),
  sendRoomMessage: (id, content) => request(`/api/voice/rooms/${id}/messages`, {
    method: "POST", body: JSON.stringify({ content }),
  }),
  roomAction: (id, action) => request(`/api/voice/rooms/${id}/action`, {
    method: "POST", body: JSON.stringify({ action }),
  }),
  bgmList: () => request("/api/bgm"),
  miniGames: () => request("/api/mini-games"),

  // ---- 好感度 ----
  favorites: () => request("/api/favorites"),
  favorite: peerId => request(`/api/favorites/${peerId}`),
  favoriteManual: (peerId, delta, source = "manual") =>
    request(`/api/favorites/${peerId}/manual`, { method: "POST", body: JSON.stringify({ delta, source }) }),

  // ---- 关系 ----
  relationships: () => request("/api/relationships"),
  bindRelationship: (targetId, relType) =>
    request("/api/relationships/bind", { method: "POST", body: JSON.stringify({ target_id: targetId, rel_type: relType }) }),
  breakRelationship: (relType, targetId) =>
    request(`/api/relationships/${relType}/break`, { method: "POST", body: JSON.stringify({ target_id: targetId }) }),
  relTypes: () => request("/api/rel-types"),

  ws: realtime,
};

window.API = api;

api.ready = (async () => {
  let user = null;
  if (getToken()) {
    const result = await api.me();
    if (result.success) {
      user = result.data;
      setUser(user);
    } else {
      clearSession();
    }
  }
  // 不再自动登录测试账号 — 让用户看到真实登录页
  if (user) realtime.connect();
  window.dispatchEvent(new CustomEvent("api-ready", { detail: user }));
  return user;
})();

console.log("[API] REST 与 WebSocket 客户端已加载");
