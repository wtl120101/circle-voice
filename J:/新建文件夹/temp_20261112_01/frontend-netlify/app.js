/* 圈圈语音社：真实 REST + WebSocket 前端 */

const state = {
  user: null,
  feedTab: "recommend",
  feedItems: [],
  matchCards: [],
  matchIndex: 0,
  matchHistory: [],
  matchBusy: false,
  matchRequestId: 0,
  matchFilters: { gender: "", max_age: 100, max_distance: 20000 },
  rooms: [],
  currentRoom: null,
  roomMessageIds: new Set(),
  roomMicStream: null,
  roomSilentContext: null,
  roomSilentTrack: null,
  roomMicBusy: false,
  roomRoster: [],
  roomPeers: new Map(),
  conversations: [],
  currentPeer: null,
  peerInfo: null,
  chatMessageIds: new Set(),
  chatLoadingPeer: null,
  chatPendingMessages: [],
  circles: [],
  currentCircle: null,
  circleTab: "讨论",
  gifts: [],
  selectedGift: "heart",
  giftCount: 1,
  giftTab: "热门",
  giftCombo: false,
  giftComboCount: 0,
  notifications: [],
  postMedia: null,
  postMediaType: null,
  recorder: null,
  recordChunks: [],
  recordCancelled: false,
  typingTimer: null,
  call: null,
  callTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

function formatNumber(value) { return Number(value || 0).toLocaleString("zh-CN"); }
function parseTime(value) {
  if (!value) return new Date();
  return new Date(String(value).replace(" ", "T"));
}
function formatTime(value) {
  return parseTime(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
function timeAgo(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - parseTime(value).getTime()) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}天前`;
  return parseTime(value).toLocaleDateString("zh-CN");
}
function empty(text, action = "") {
  return `<div class="empty-state"><i class="fa-regular fa-comment-dots"></i><p>${escapeHtml(text)}</p>${action}</div>`;
}
function unwrap(result, notify = true) {
  if (result?.success) return result.data;
  if (notify) showToast(result?.error || "操作失败，请稍后重试");
  return null;
}
function setBusy(button, busy, text = "处理中...") {
  if (!button) return;
  if (busy) {
    button.dataset.oldText = button.innerHTML;
    button.disabled = true;
    button.innerHTML = text;
  } else {
    button.disabled = false;
    if (button.dataset.oldText) button.innerHTML = button.dataset.oldText;
  }
}
let toastTimer;
function showToast(message) {
  let toast = $("#toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = String(message);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}
function openModal(id) {
  // 兼容多种 ID 命名：walletModal / modal-wallet / modalWallet
  let el = $(`#${id}`) || $(`#modal-${id}`) || $(`#${id.replace(/^modal/, "")}`);
  if (el) {
    el.classList.remove("hidden");
    el.classList.add("active");
    document.body.style.overflow = "hidden";
  }
}
function closeModal(id) {
  let el = $(`#${id}`) || $(`#modal-${id}`);
  if (el) {
    el.classList.add("hidden");
    el.classList.remove("active");
    document.body.style.overflow = "";
  }
}
async function shareText(title, text = title) {
  try {
    if (navigator.share) await navigator.share({ title, text, url: location.href });
    else {
      await navigator.clipboard.writeText(`${text} ${location.href}`);
      showToast("链接已复制");
    }
  } catch (error) {
    if (error.name !== "AbortError") showToast("分享已取消或当前浏览器不支持");
  }
}

/* ---------- 初始化 ---------- */
document.addEventListener("DOMContentLoaded", async () => {
  bindNavigation();
  bindStaticActions();
  bindDynamicActions();
  bindMatchGestures();
  bindRealtime();
  initEmoji();
  initViewportHeight();
  initSettings();
  initSliders();
  // splash 默认隐藏（HTML 加了 hide class），等确认用户状态后再决定是否显示
  try {
    state.user = await API.ready;
  } catch (e) {
    console.error("API.ready failed:", e);
    state.user = null;
  }
  if (!state.user) {
    // 没有用户 → 显示登录页
    const splash = $("#splash");
    if (splash) {
      splash.classList.remove("hide");
      // 聚焦手机号输入框
      setTimeout(() => $("#loginPhone")?.focus(), 300);
    }
    return;
  }
  // 已有用户 → 直接进入应用
  updateUserUI(state.user);
  // splash 虽然有 hide class（opacity:0）但仍占据 DOM，移除它避免移动端溢出
  hideSplash();
  const jobs = await Promise.allSettled([
    loadDiscover(), loadNearby(), loadCircles(), loadTasks(), loadStats(),
    loadMatchCards(), loadMatchList(), loadVoiceRooms(), loadConversations(),
    loadNotifications(), loadGifts(), loadProfile(),
  ]);
  jobs.filter(job => job.status === "rejected").forEach(job => console.error(job.reason));
  // 实时设备定位
  setTimeout(() => initDeviceLocation(), 500);
});

function hideSplash() {
  const splash = $("#splash");
  if (!splash) return;
  splash.classList.add("hide");
  setTimeout(() => splash.remove(), 500);
}
async function loginWithPhone(phone, nickname, code = null) {
  const result = await API.login(phone, nickname, code);
  if (unwrap(result)) location.reload();
}
async function loginWithOauth(provider, openid, nickname = "", avatar = "") {
  const result = await API.oauthLogin(provider, openid, nickname, avatar);
  if (unwrap(result)) location.reload();
}

function bindNavigation() {
  document.addEventListener("click", event => {
    const item = event.target.closest("[data-view]");
    if (!item) return;
    event.preventDefault();
    switchView(item.dataset.view);
  });
  $$('[data-close]').forEach(button => button.addEventListener("click", () => closeModal(button.dataset.close)));
  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openModal("searchModal");
      setTimeout(() => $("#globalSearchInput")?.focus(), 50);
    }
    if (event.key === "Escape") {
      $$(".modal.active, .drawer.active, .search-modal.active, .gift-panel.active, .match-success.active").forEach(element => element.classList.remove("active"));
      if ($("#roomModal")?.classList.contains("active")) closeRoom();
      if ($("#callModal")?.classList.contains("active")) endCall();
      document.body.style.overflow = "";
    }
    if (!$("#view-match")?.classList.contains("hidden") && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
      if (event.key === "ArrowLeft") swipeCard("pass");
      if (event.key === "ArrowRight") swipeCard("like");
    }
  });
}
function switchView(view) {
  $$(".view").forEach(element => element.classList.add("hidden"));
  $(`#view-${view}`)?.classList.remove("hidden");
  $$(".nav-item[data-view], .mtab[data-view]").forEach(item => item.classList.toggle("active", item.dataset.view === view));
  $("#sidebar")?.classList.remove("open");
  $("#sidebarMask")?.classList.remove("show");
  document.body.classList.toggle("chat-view", view === "chat");
  closeChatList();
  document.body.style.overflow = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "favorites") loadFavorites();
  else if (view === "relationships") loadRelationships();
  else if (view === "match") initMatchCenter();
  else if (view === "shop") loadShopProducts(currentShopCategory);
  else if (view === "notifications") loadNotifications();
}

/* ---------- 手机端会话列表抽屉 ---------- */
function openChatList() {
  $("#chatList")?.classList.add("show");
}
function closeChatList() {
  $("#chatList")?.classList.remove("show");
}
function toggleChatList(event) {
  event?.stopPropagation();
  $("#chatList")?.classList.toggle("show");
}
function initViewportHeight() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const apply = () => {
    const keyboardOpen = viewport.height < window.innerHeight - 120;
    document.documentElement.style.setProperty("--vv-bottom", `${Math.round(viewport.offsetTop + viewport.height)}px`);
    document.documentElement.classList.toggle("kb-open", keyboardOpen);
  };
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  apply();
}

/* ---------- 匹配中心初始化 ---------- */
async function initMatchCenter() {
  // 1) 实名认证闸门
  const gate = $("#matchRealnameGate");
  if (state.user?.is_realname) {
    // 已实名：显示绿色已认证标记（替换原未验证样式）
    if (gate) {
      gate.classList.remove("unverified");
      gate.classList.add("verified");
      gate.innerHTML = `<i class="fa-solid fa-circle-check"></i>
        <div class="gate-text">
          <strong>✅ 已实名</strong>
          <p>保护你和对方的真实安全</p>
        </div>
        <button class="gate-btn" disabled><i class="fa-solid fa-shield-check"></i> 安全保障</button>`;
    }
  } else {
    // 未实名：保持红色警告样式
    if (gate) {
      gate.classList.remove("verified");
      gate.classList.add("unverified");
    }
    // 绑定去实名按钮
    $("#goRealnameBtn")?.replaceWith($("#goRealnameBtn").cloneNode(true));
    $("#goRealnameBtn")?.addEventListener("click", () => {
      // 跳转到资料页实名认证
      switchView("profile");
      openModal("profileEditModal");
      showToast("请在资料页完成实名认证");
    });
  }

  // 2) 更新定位栏文字（使用 state.user.location）
  const locText = $(".match-location-bar .loc-text");
  if (locText && state.user?.location) {
    locText.textContent = `📍 ${state.user.location} · 已获取定位 · 5km范围`;
  }

  // 3) 切换城市按钮
  $("#locSwitchBtn")?.replaceWith($("#locSwitchBtn").cloneNode(true));
  $("#locSwitchBtn")?.addEventListener("click", () => {
    const city = prompt("请输入你的城市（如：上海）", state.user?.location || "");
    if (city) {
      state.user.location = city.trim();
      if (locText) locText.textContent = `📍 ${city} · 已获取定位 · 5km范围`;
      showToast("城市已切换");
    }
  });

  // 扩大搜索范围按钮
  $("#expandRangeBtn")?.replaceWith($("#expandRangeBtn").cloneNode(true));
  $("#expandRangeBtn")?.addEventListener("click", () => {
    state.matchFilters.max_distance = Math.min(20000, (state.matchFilters.max_distance || 20000) * 2);
    loadMatchCards();
    showToast(`已扩大搜索范围到 ${state.matchFilters.max_distance}km`);
  });

  // 4) 加载匹配卡片（调用 API.matchCards）
  state.matchFilters.max_age = 100;
  state.matchFilters.max_distance = state.matchFilters.max_distance || 5000;
  loadMatchCards();

  // 5) 加载我的匹配列表（调用 API.matchList）
  loadMatchList();
}

let cartItems = [];
let currentProductQty = 1;
let currentShopCategory = "";
async function bindStaticActions() {
  $("#hamburgerBtn")?.addEventListener("click", () => {
    $("#sidebar")?.classList.toggle("open");
    $("#sidebarMask")?.classList.toggle("show");
  });
  $("#sidebarMask")?.addEventListener("click", () => {
    $("#sidebar")?.classList.remove("open");
    $("#sidebarMask")?.classList.remove("show");
  });
  $$('[data-action="notifications"]').forEach(button => button.addEventListener("click", async () => {
    $("#sidebar")?.classList.remove("open");
    $("#sidebarMask")?.classList.remove("show");
    openModal("notifDrawer");
    await loadNotifications();
  }));
  $$('[data-action="wallet"]').forEach(button => button.addEventListener("click", async () => {
    $("#sidebar")?.classList.remove("open");
    $("#sidebarMask")?.classList.remove("show");
    await loadWallet();
  }));
  $$('[data-action="settings"]').forEach(button => button.addEventListener("click", () => {
    $("#sidebar")?.classList.remove("open");
    $("#sidebarMask")?.classList.remove("show");
    openModal("settingsDrawer");
  }));

  /* ====== #1 商城事件绑定 ====== */
  // 静态兜底卡片点击 → 打开详情
  document.querySelectorAll(".product-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".product-buy")) return;
      openProductDetail(card);
    });
  });
  // 分类 tab
  $$("#view-shop .shop-cat-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      $$("#view-shop .shop-cat-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      currentShopCategory = tab.dataset.shopCat || "";
      loadShopProducts(currentShopCategory);
    });
  });
  // 详情 Modal 内数量 +/−（匹配实际 HTML id）
  document.getElementById("qtyPlus")?.addEventListener("click", () => adjustQty(1));
  document.getElementById("qtyMinus")?.addEventListener("click", () => adjustQty(-1));
  // 详情 Modal 立即购买 → 下单
  const buyNowBtn = document.getElementById("sdBuyNowBtn");
  if (buyNowBtn) buyNowBtn.addEventListener("click", async () => await placeOrderFromDetail());
  // 详情 Modal 加入购物车
  const addCartBtn = document.getElementById("sdAddCartBtn");
  if (addCartBtn) addCartBtn.addEventListener("click", () => {
    const modal = document.getElementById("shopDetailModal");
    if (!modal?.dataset.itemKey) return showToast("商品信息缺失");
    cartItems.push({
      item_key: modal.dataset.itemKey,
      type: modal.dataset.itemType,
      name: modal.querySelector("#sdTitle")?.textContent || "商品",
      price: Number(modal.dataset.productPrice || 0),
      qty: 1,
    });
    showToast("已加入购物车");
    const cartBar = document.getElementById("shopCartBar");
    if (cartBar) {
      cartBar.classList.add("active");
      const countEl = cartBar.querySelector(".cart-count");
      const totalEl = cartBar.querySelector(".cart-total");
      if (countEl) countEl.textContent = cartItems.length;
      if (totalEl) totalEl.textContent = `💰 ${formatNumber(cartItems.reduce((s, i) => s + i.price * i.qty, 0))}`;
    }
  });
  // 购物车条去结算按钮
  const checkoutBtn = document.getElementById("shopCheckoutBtn");
  if (checkoutBtn) checkoutBtn.addEventListener("click", () => {
    if (!cartItems.length) return showToast("购物车是空的");
    const item = cartItems[0];
    if (cartItems.length > 1) return showToast("请逐件结算商品");
    const fakeCard = { dataset: { product: JSON.stringify(item), key: item.item_key }, querySelector: () => null };
    openProductDetail(fakeCard);
    cartItems = [];
    document.getElementById("shopCartBar")?.classList.remove("active");
  });

  /* ====== #4 通知中心绑定 ====== */
  $$("#notifDrawer .ntab").forEach(tab => {
    tab.addEventListener("click", () => {
      $$("#notifDrawer .ntab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const type = tab.dataset.notifType || "";
      loadNotifications(type === "all" ? "" : type);
    });
  });
  document.getElementById("notifMarkAllBtn")?.addEventListener("click", () => markNotificationsRead());

  /* ====== #3 语音房事件绑定 ====== */
  // 创建房间 Modal 里的类型切换（单人/多人）
  document.querySelectorAll("#createRoomModal .room-type-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#createRoomModal .room-type-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });
  // 打开创建房间 Modal（开播不强制实名，后端允许未实名用户创建）
  document.querySelectorAll('[data-action="startVoice"], #startVoiceBtn, #createRoomBtn').forEach(el => {
    el.addEventListener("click", () => {
      if (!state.user) return showToast("请先登录");
      openModal("createRoomModal");
    });
  });
  // 提交创建房间
  const submitCreateRoom = document.getElementById("submitCreateRoom");
  if (submitCreateRoom) submitCreateRoom.addEventListener("click", async () => {
    const topic = document.getElementById("roomTopicInput")?.value.trim() || "深夜聊天";
    const type = document.querySelector("#createRoomModal .room-type-btn.active")?.dataset.type || "multi";
    await createAndEnterRoom(topic, type);
  });
  // 房间卡片点击 → 进入房间
  document.querySelectorAll(".room-card").forEach(card => {
    card.addEventListener("click", () => enterVoiceRoom(card.dataset.room || card.dataset.roomId || card.id));
  });
  // BGM picker / 小游戏 picker 打开
  document.getElementById("bgmPickerBtn")?.addEventListener("click", () => openModal("bgmPicker"));
  document.getElementById("gamePickerBtn")?.addEventListener("click", () => openModal("gamePicker"));

  /* ====== #9 关注/查看资料 ====== */
  // 附近的人「打招呼」→ 关注
  document.querySelectorAll("[data-follow]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.follow;
      try {
        await fetch(`/api/users/${uid}/follow`, {
          method: "POST", headers: { Authorization: `Bearer ${getToken()}` },
        });
        btn.classList.add("followed");
        btn.textContent = "已关注";
        showToast("关注成功");
      } catch (e) { showToast("操作失败"); }
    });
  });

  /* ====== 通用 Modal 背景点击关闭 ====== */
  document.querySelectorAll(".modal-overlay, .modal").forEach(m => {
    m.addEventListener("click", (e) => {
      if (e.target === m) m.classList.add("hidden");
    });
  });
  document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.close;
      closeModal(target);
      // 也尝试 modal- 前缀
      const alt = document.getElementById(`modal-${target}`);
      alt && alt.classList.add("hidden");
    });
  });

  $$('[data-action="search"], .search-box').forEach(button => button.addEventListener("click", () => openModal("searchModal")));
  $$('[data-action="theme"]').forEach(button => button.addEventListener("click", toggleTheme));
  $$('[data-action="startVoice"], #startVoiceBtn').forEach(button => button.addEventListener("click", () => openModal("createRoomModal")));
  $("#postBtn")?.addEventListener("click", () => openModal("postModal"));
  $("#closeCreateRoom")?.addEventListener("click", () => closeModal("createRoomModal"));
  $("#createRoomModal .modal-actions .btn-primary")?.addEventListener("click", createRoom);
  $("#submitPost")?.addEventListener("click", submitPost);
  $("#postText")?.addEventListener("input", event => { $("#postChar").textContent = event.target.value.length; });
  $$("[data-ptool]").forEach(button => button.addEventListener("click", () => handlePostTool(button.dataset.ptool)));
  $(".post-preview .preview-item")?.addEventListener("click", () => handlePostTool("image"));
  $(".banner-slide .btn-white")?.addEventListener("click", () => switchView("voice"));
  $("#likeBtn")?.addEventListener("click", () => swipeCard("like"));
  $("#nopeBtn")?.addEventListener("click", () => swipeCard("pass"));
  $(".match-actions .super-like")?.addEventListener("click", () => swipeCard("super"));
  $(".match-actions .rewind")?.addEventListener("click", undoMatch);
  $(".match-actions .boost")?.addEventListener("click", () => openUpgrade("boost"));
  $("#matchCloseBtn")?.addEventListener("click", () => $("#matchSuccess")?.classList.remove("active"));
  $("#matchSuccess .success-btns .btn-primary")?.addEventListener("click", () => {
    $("#matchSuccess")?.classList.remove("active");
    if (state.matchedPeer) openChat(state.matchedPeer.id);
  });
  $$(".vip-card .btn-primary, [data-upgrade], .upgrade-link").forEach(button => button.addEventListener("click", () => openUpgrade("vip")));
  $$(".plan-buy").forEach(button => button.addEventListener("click", () => payVip(button)));
  // ---- 新商城 / 好感度 / 关系 ----
  $$('[data-action="shop"]').forEach(button => button.addEventListener("click", openShop));
  $$(".pay-option").forEach((option, index) => option.addEventListener("click", () => {
    $$(".pay-option").forEach(item => { item.classList.remove("active"); item.querySelector("input").checked = false; });
    option.classList.add("active");
    option.querySelector("input").checked = true;
    option.dataset.method = ["wechat", "alipay", "card", "applepay"][index];
  }));
  $(".pay-option.active")?.setAttribute("data-method", "wechat");
  $(".restore-btn")?.addEventListener("click", async () => {
    const data = unwrap(await API.wallet());
    if (data) showToast(data.is_vip ? `会员有效期至 ${data.vip_expire || "长期"}` : "当前账号没有可恢复的会员");
  });
  $$(".coin-item .btn-sm").forEach(button => button.addEventListener("click", () => rechargeWallet(button)));
  $("#giftToggleBtn")?.addEventListener("click", () => $("#giftPanel")?.classList.toggle("active"));
  $(".gift-head .btn-primary")?.addEventListener("click", async () => { $("#giftPanel")?.classList.remove("active"); openModal("walletModal"); await loadWallet(); });
  $(".gift-count button:first-child")?.addEventListener("click", () => updateGiftCount(state.giftCount - 1));
  $(".gift-count button:last-child")?.addEventListener("click", () => updateGiftCount(state.giftCount + 1));
  $$(".gift-tabs .gtab").forEach(tab => tab.addEventListener("click", () => {
    state.giftTab = tab.textContent.trim();
    $$(".gift-tabs .gtab").forEach(item => item.classList.toggle("active", item === tab));
    renderGifts();
  }));
  $(".gift-bottom > .toggle input")?.addEventListener("change", event => {
    state.giftCombo = event.target.checked;
    state.giftComboCount = 0;
    event.target.closest(".toggle").classList.toggle("on", state.giftCombo);
    showToast(state.giftCombo ? "连击模式已开启，连续点击即可累计赠送" : "连击模式已关闭");
  });
  $(".gift-bottom > .btn-primary")?.addEventListener("click", sendGift);
  $('.chat-head-actions button[title="更多"]')?.addEventListener("click", toggleChatMore);
  $("#closeRoomBtn")?.addEventListener("click", closeRoom);
  $("#roomModal")?.addEventListener("click", event => { if (event.target.id === "roomModal") closeRoom(); });
  $("#chatToggleBtn")?.addEventListener("click", () => {
    const panel = $("#roomChatPanel");
    if (panel) panel.style.display = panel.style.display === "none" ? "flex" : "none";
  });
  $("#roomChatSend")?.addEventListener("click", sendRoomMessage);
  $("#roomChatInput")?.addEventListener("keydown", event => { if (event.key === "Enter") sendRoomMessage(); });
  $("#chatSendBtn")?.addEventListener("click", sendChatMessage);
  $("#chatInput")?.addEventListener("keydown", event => { if (event.key === "Enter") sendChatMessage(); });
  $("#chatInput")?.addEventListener("input", handleTyping);
  $(".chat-search input")?.addEventListener("input", renderConversations);
  $("#chatListToggle")?.addEventListener("click", toggleChatList);
  $("#chatListClose")?.addEventListener("click", closeChatList);
  $("#chatList")?.addEventListener("click", event => {
    if (event.target.closest(".chat-item[data-peer]")) closeChatList();
  });
  $$('[data-action="call"]').forEach(button => button.addEventListener("click", () => startCall(button.dataset.callType || "voice")));
  $("#endCallBtn")?.addEventListener("click", () => endCall());
  $("#callInvite .invite-btn.accept")?.addEventListener("click", acceptCall);
  $("#callInvite .invite-btn.decline")?.addEventListener("click", rejectCall);
  $("#callMicToggle")?.addEventListener("click", toggleCallAudio);
  $("#callVideoToggle")?.addEventListener("click", toggleCallVideo);
  $("#callSpeakerToggle")?.addEventListener("click", toggleCallSpeaker);
  $("#callVoiceSwitch")?.addEventListener("click", switchCallToVoice);
  $("#voiceToggleBtn")?.addEventListener("click", toggleVoiceRecording);
  $("#stopRecord")?.addEventListener("click", stopVoiceRecording);
  $("#cancelRecord")?.addEventListener("click", cancelVoiceRecording);
  $("#slideCancel")?.addEventListener("click", cancelVoiceRecording);
  $(".chat-input-bar .attach-btn")?.addEventListener("click", sendImageMessage);
  $("#chatMediaInput")?.addEventListener("change", handleChatMediaUpload);
  $("#mediaPreviewClose")?.addEventListener("click", closeMediaPreview);
  $("#mediaPreviewOverlay")?.addEventListener("click", event => {
    if (event.target.id === "mediaPreviewOverlay") closeMediaPreview();
  });
  $("#chatBody")?.addEventListener("click", event => {
    const media = event.target.closest("[data-preview]");
    if (media) {
      event.stopPropagation();
      openMediaPreview(media.dataset.preview, media.dataset.mediaType);
    }
  });
  $("#globalSearchInput")?.addEventListener("input", debounce(globalSearch, 300));
  $("#globalSearchInput")?.addEventListener("keydown", event => { if (event.key === "Enter") globalSearch(); });
  $$(".suggest-tags span").forEach(tag => tag.addEventListener("click", () => {
    $("#globalSearchInput").value = tag.textContent.replace(/^#|^\S*\s*/g, "").trim();
    globalSearch();
  }));
  $$(".filter-bar .chip").forEach(chip => chip.addEventListener("click", () => {
    $$(".filter-bar .chip").forEach(item => item.classList.remove("active"));
    chip.classList.add("active");
    const text = chip.textContent;
    const category = text.includes("游戏") ? "游戏" : text.includes("音乐") ? "音乐" : text.includes("情感") ? "情感" : text.includes("读书") ? "读书" : text.includes("深夜") ? "深夜电台" : "";
    loadVoiceRooms(category, text.includes("关注"));
  }));
  $$("#view-discover .tabs .tab").forEach((tab, index) => tab.addEventListener("click", () => {
    $$("#view-discover .tabs .tab").forEach(item => item.classList.remove("active"));
    tab.classList.add("active");
    state.feedTab = ["recommend", "following", "city"][index];
    loadDiscover();
  }));
  $$(".notif-tabs .ntab").forEach((tab, index) => tab.addEventListener("click", async () => {
    $$(".notif-tabs .ntab").forEach(item => item.classList.remove("active"));
    tab.classList.add("active");
    await loadNotifications(["", "like", "comment", "follow", "system"][index]);
  }));
  $('#notifDrawer [data-close="notifDrawer"].btn')?.addEventListener("click", markNotificationsRead);
  $('#notifDrawer .drawer-head .btn-ghost')?.addEventListener("click", markNotificationsRead);
  $(".create-channel button")?.addEventListener("click", createCircle);
  $(".channel-tabs")?.addEventListener("click", event => {
    const tab = event.target.closest(".ctab");
    if (!tab) return;
    $$(".channel-tabs .ctab").forEach(item => item.classList.remove("active"));
    tab.classList.add("active");
    state.circleTab = tab.textContent.replace(/^\S+\s*/, "");
    renderCirclePosts();
  });
  $$(".seg-btn").forEach(button => button.addEventListener("click", () => handleSegment(button)));
  $$(".tag-pick").forEach(button => button.addEventListener("click", () => {
    button.classList.toggle("active");
    if (button.closest("#view-match")) applyMatchFilters();
  }));
  $$("#view-match .slider").forEach((slider, index) => slider.addEventListener("change", () => {
    if (index === 0) state.matchFilters.max_age = Number(slider.value);
    else state.matchFilters.max_distance = Number(slider.value);
    loadMatchCards();
  }));
  $$(".profile-tabs .ptab").forEach(tab => tab.addEventListener("click", () => handleProfileTab(tab)));
  $(".profile-actions .btn-primary")?.addEventListener("click", editProfile);
  $(".profile-actions .btn-outline:first-of-type")?.addEventListener("click", () => shareText("我的圈圈主页", `${state.user?.nickname} 的主页`));
  $(".profile-actions .btn-outline:last-of-type")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(`${location.origin}/#user-${state.user?.id}`);
    showToast("个人名片链接已复制");
  });
  $(".edit-avatar")?.addEventListener("click", editAvatar);

  // ---- 登录页 Tab 切换 ----
  $$(".login-tab").forEach(tab => tab.addEventListener("click", () => {
    $$(".login-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const mode = tab.dataset.tab;
    $("#loginForm")?.classList.toggle("hidden", mode === "oauth");
    $("#loginOauth")?.classList.toggle("hidden", mode !== "oauth");
  }));

  // ---- 登录表单：手机号 + 验证码 ----
  $("#loginForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const phone = $("#loginPhone").value.trim();
    const code = $("#loginCode").value.trim();
    const nickname = $("#loginNickname").value.trim() || null;
    if (!/^\d{6,15}$/.test(phone)) { showToast("请输入正确的手机号"); return; }
    if (!/^\d{4,6}$/.test(code)) { showToast("请输入正确的 4-6 位验证码"); return; }
    const btn = $(".login-submit");
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 登录中...';
    try { await loginWithPhone(phone, nickname, code); }
    finally { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> 立即进入'; }
  });

  // ---- 获取验证码（60秒倒计时） ----
  let codeCooldown = 0;
  let codeTimer = null;
  $("#sendCodeBtn")?.addEventListener("click", async () => {
    const phone = $("#loginPhone").value.trim();
    if (!/^\d{6,15}$/.test(phone)) { showToast("请先输入手机号"); return; }
    if (codeCooldown > 0) return;
    const btn = $("#sendCodeBtn");
    btn.disabled = true; btn.textContent = "发送中...";
    const result = await API.sendCode(phone);
    btn.disabled = false;
    if (unwrap(result)) {
      codeCooldown = 60;
      btn.textContent = `${codeCooldown}s 后重发`;
      codeTimer = setInterval(() => {
        codeCooldown--;
        if (codeCooldown <= 0) { clearInterval(codeTimer); btn.textContent = "获取验证码"; }
        else btn.textContent = `${codeCooldown}s 后重发`;
      }, 1000);
      const devCode = result?.data?.dev_code;
      if (devCode) {
        // 开发环境：自动回填验证码并提示（生产短信版不会返回 dev_code）
        $("#loginCode").value = devCode;
        showToast(`验证码已发送：${devCode}（已自动填入）`);
      } else {
        showToast("验证码已发送，请注意查收短信");
      }
    }
  });

  // ---- 第三方登录（模拟授权：点击即登录，首次自动创建账号） ----
  $$(".oauth-btn").forEach(btn => btn.addEventListener("click", async () => {
    const provider = btn.dataset.provider;
    const nicknameMap = { wechat: "微信", qq: "QQ", apple: "Apple" };
    const openid = `${provider}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const nickname = `${nicknameMap[provider] || provider}用户`;
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 登录中...';
    const result = await API.oauthLogin(provider, openid, nickname);
    btn.disabled = false; btn.innerHTML = `<i class="fa-brands fa-${provider}"></i> ${nicknameMap[provider] || provider} 登录`;
    if (unwrap(result)) {
      showToast(`${nicknameMap[provider] || provider}登录成功`);
      location.reload();
    }
  }));

  // ---- 设置 → 管理员后台入口 ----
  const adminNav = document.createElement("div");
  adminNav.className = "setting-group admin-entry-group";
  adminNav.style.cssText = "padding-top:12px;border-top:1px solid var(--border)";
  adminNav.innerHTML = '<h5>开发者</h5><button class="setting-link" style="width:100%;text-align:left"><i class="fa-solid fa-screwdriver-wrench"></i> 管理员后台 <i class="fa-solid fa-chevron-right"></i></button>';
  const settingsList = $("#settingsDrawer")?.querySelector(".settings-list");
  if (settingsList) {
    settingsList.appendChild(adminNav);
    adminNav.querySelector("button").addEventListener("click", () => openModal("adminModal"));
  }

  // 付费引导横幅（仅 premium-teaser，登录页已删除）
  $$(".premium-teaser").forEach(button => button.addEventListener("click", () => openUpgrade("vip")));

  $$(".agreement a").forEach((link, index) => link.addEventListener("click", event => {
    event.preventDefault();
    const privacy = index === 1;
    showInfoModal(privacy ? "隐私政策" : "用户协议", privacy
      ? "<p>我们重视您的隐私。本应用会在服务器数据库中保存您的账号、动态、聊天和设置数据，用于提供社交与语音服务。语音与视频通过 WebRTC 点对点传输。未经您同意，我们不会向第三方共享您的个人信息。</p>"
      : "<p>欢迎使用圈圈语音社。请文明交流，不要发布违法、侵权或骚扰内容。充值与 VIP 服务由官方支付通道处理，开通后即时生效。如有疑问请联系客服。</p>");
  }));

  $(".setting-link.danger")?.addEventListener("click", event => {
    event.preventDefault();
    API.logout();
    location.reload();
  });

  // ---- 管理员后台 ----
  initAdminPanel();

  // ============ 新增 UI 交互 Handler ============

  // 1) Gift panel tabs switching (新 UI 的 .gift-tab)
  $$(".gift-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      tab.parentElement.querySelectorAll(".gift-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const type = tab.dataset.giftType || "coins";
      tab.parentElement.parentElement.querySelectorAll(".gift-grid").forEach(g => g.style.display = g.dataset.currency === type ? "grid" : "none");
    });
  });

  // 2) BGM Picker button click
  document.getElementById("bgmPickerBtn")?.addEventListener("click", () => { const m = document.getElementById("bgmPickerModal"); m?.classList.remove("hidden"); m?.classList.add("active"); });
  document.querySelectorAll(".bgm-track-item")?.forEach(el => el.addEventListener("click", (e) => {
    const title = el.querySelector(".bgm-title")?.textContent || "";
    const m = document.getElementById("bgmPickerModal");
    m?.classList.add("hidden"); m?.classList.remove("active");
    showToast(`已选择: ${title}`);
  }));

  // 3) Mini-game Picker
  document.getElementById("gamePickerBtn")?.addEventListener("click", () => { const m = document.getElementById("gamePickerModal"); m?.classList.remove("hidden"); m?.classList.add("active"); });
  document.querySelectorAll(".game-pick-item")?.forEach(el => el.addEventListener("click", (e) => {
    const name = el.querySelector(".game-name")?.textContent || "";
    const m = document.getElementById("gamePickerModal");
    m?.classList.add("hidden"); m?.classList.remove("active");
    showToast(`已开始 ${name}`);
  }));

  // 4) Voice room create toggle (single/multi type)
  $$(".room-type-toggle .type-option").forEach(opt => {
    opt.addEventListener("click", () => {
      opt.parentElement.querySelectorAll(".type-option").forEach(o => o.classList.remove("active"));
      opt.classList.add("active");
    });
  });

  // 5) Shop product detail modal open/close
  document.querySelectorAll(".product-card")?.forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".product-buy")) return;
      const name = card.querySelector(".product-name")?.textContent;
      const m = document.getElementById("shopDetailModal");
      m?.classList.remove("hidden"); m?.classList.add("active");
      if (name) showToast(`查看: ${name}`);
    });
  });
  document.querySelectorAll("#shopDetailModal .modal-close, #shopOrderOkModal .modal-close, #shopDetailModal [data-close], #shopOrderOkModal [data-close]")?.forEach(btn => {
    btn.addEventListener("click", () => {
      const m = btn.closest(".modal, [id$=Modal]");
      m?.classList.add("hidden"); m?.classList.remove("active");
    });
  });

  // 6) Shop cart buy button flow
  document.getElementById("shopBuyBtn")?.addEventListener("click", async () => {
    showToast("正在下单...");
    setTimeout(() => {
      const sd = document.getElementById("shopDetailModal");
      sd?.classList.add("hidden"); sd?.classList.remove("active");
      const so = document.getElementById("shopOrderOkModal");
      so?.classList.remove("hidden"); so?.classList.add("active");
    }, 500);
  });

  // 7) Profile tab switching
  $$(".profile-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      tab.parentElement.querySelectorAll(".profile-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const type = tab.dataset.ptab;
      showToast(`切换到: ${tab.textContent}`);
    });
  });

  // 8) General close-all-modals-on-click-outside
  document.querySelectorAll(".modal").forEach(modal => {
    modal.addEventListener("click", (e) => {
      if (e.target === modal || e.target.classList.contains("modal-close")) {
        modal.classList.add("hidden");
      }
    });
  });
}

async function bindDynamicActions() {
  document.addEventListener("click", async event => {
    const button = event.target.closest("[data-do]");
    if (!button) return;
    event.preventDefault();
    const id = Number(button.dataset.id);
    switch (button.dataset.do) {
      case "open-user": await openUserProfile(button.dataset.userId); break;
      case "like-post": await togglePostLike(id, button); break;
      case "toggle-comments": await toggleComments(id, button); break;
      case "submit-comment": await submitComment(id, button); break;
      case "share-post": await shareText("圈圈动态", button.dataset.content || "来看看这条动态"); break;
      case "open-post": switchView("discover"); setTimeout(() => $(`[data-post-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100); break;
      case "follow": await toggleFollow(id, button); break;
      case "unblock": await unblockUser(id); break;
      case "greet": case "match-message": await openChat(id); break;
      case "open-circle": await openCircle(id); break;
      case "join-circle": await toggleCircleMembership(id, button); break;
      case "open-room": await openRoom(id); break;
      case "host-room": openHostRoom(id); break;
      case "task": await handleTask(button.dataset.key, button); break;
      case "reload-match": await loadMatchCards(); break;
      case "circle-notify": toggleCircleNotify(button); break;
      case "share-circle": await shareText(state.currentCircle?.name || "圈圈频道"); break;
      case "room-mic": await toggleRoomMic(button); break;
      case "room-hand": await sendRoomAction("hand", "已举手，等待房主邀请"); break;
      case "room-invite": await shareText("语音房邀请", `来加入 ${state.currentRoom?.topic || "语音房"}`); break;
      case "search-user": await openChat(id); closeModal("searchModal"); break;
      case "search-room": closeModal("searchModal"); await openRoom(id); break;
      case "search-circle": closeModal("searchModal"); await openCircle(id); break;
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Enter" && event.target.matches(".comment-input")) {
      event.preventDefault();
      submitComment(Number(event.target.dataset.post), event.target);
    }
  });
}

/* ---------- 用户、动态、附近 ---------- */
function updateUserUI(user) {
  state.user = user;
  $$(".sidebar .avatar-sm img").forEach(image => { image.src = user.avatar; });
  const sidebarCoins = $(".sidebar .coin-amt");
  if (sidebarCoins) sidebarCoins.textContent = `💎 ${formatNumber(user.coins)}`;
  $("#giftPanel .gift-head strong") && ($("#giftPanel .gift-head strong").textContent = user.coins);
}
function ensureFeedContainer() {
  const column = $("#view-discover .feed-column");
  if (!column) return null;
  let container = $("#feedList");
  if (!container) {
    column.querySelectorAll(":scope > .post-card").forEach(card => card.remove());
    container = document.createElement("div");
    container.id = "feedList";
    column.appendChild(container);
  }
  return container;
}
async function loadDiscover() {
  const data = unwrap(await API.discover(1, 30, state.feedTab), false);
  if (!data) return;
  state.feedItems = data.items;
  renderPosts(state.feedItems);
}
function renderPosts(items) {
  const container = ensureFeedContainer();
  if (!container) return;
  container.innerHTML = items.length ? items.map(postCard).join("") : empty(state.feedTab === "following" ? "关注的人还没有发布动态" : "这里还没有动态，来发布第一条吧");
}
function postCard(post) {
  const media = renderMedia(post.image);
  const comments = (post.comments_list || []).map(commentHtml).join("");
  return `<article class="post-card" data-post-id="${post.id}" data-user-id="${post.user_id}">
    <div class="post-header"><div class="avatar" data-do="open-user" data-user-id="${post.user_id}"><img src="${escapeHtml(post.avatar || state.user.avatar)}" alt=""></div>
      <div class="post-meta"><div class="post-author" data-do="open-user" data-user-id="${post.user_id}">${escapeHtml(post.nickname || state.user.nickname)} ${post.user_id === state.user.id ? '<span class="tag-sm blue">我</span>' : ""}</div>
      <div class="post-sub">${escapeHtml(post.location || "远方")} · ${timeAgo(post.created_at)}</div></div>
      <button class="icon-btn-sm" data-do="share-post" data-content="${escapeHtml(post.content)}"><i class="fa-solid fa-ellipsis"></i></button></div>
    <p class="post-text">${escapeHtml(post.content)}</p>${media}
    <div class="post-actions">
      <button data-do="like-post" data-id="${post.id}" class="${post.liked ? "liked" : ""}"><i class="fa-${post.liked ? "solid" : "regular"} fa-heart"></i> <span>${formatNumber(post.likes)}</span></button>
      <button data-do="toggle-comments" data-id="${post.id}"><i class="fa-regular fa-comment"></i> <span>${formatNumber(post.comments)}</span></button>
      <button data-do="share-post" data-content="${escapeHtml(post.content)}"><i class="fa-regular fa-share-from-square"></i> 分享</button>
      <button class="enter-room" data-do="host-room" data-id="${post.user_id}"><i class="fa-solid fa-microphone"></i> 进入语音房</button>
    </div>
    <div class="comments-wrap hidden"><div class="comments-list">${comments}</div>
      <div class="comment-compose"><input class="comment-input" data-post="${post.id}" maxlength="300" placeholder="写下你的评论..."><button class="btn-sm primary" data-do="submit-comment" data-id="${post.id}">发送</button></div>
    </div>
  </article>`;
}
function renderMedia(url) {
  if (!url) return "";
  const safe = escapeHtml(url);
  if (/\.(mp4|webm|ogg)(\?|$)/i.test(url)) return `<div class="post-media"><video src="${safe}" controls playsinline></video></div>`;
  if (/\.(mp3|wav|m4a|aac)(\?|$)/i.test(url)) return `<div class="post-media audio"><audio src="${safe}" controls></audio></div>`;
  return `<div class="post-media"><img src="${safe}" alt="动态图片" loading="lazy"></div>`;
}
function commentHtml(comment) {
  return `<div class="comment-row"><img src="${escapeHtml(comment.avatar || state.user.avatar)}" alt=""><div><strong>${escapeHtml(comment.nickname)}</strong><p>${escapeHtml(comment.content)}</p><span>${timeAgo(comment.created_at)}</span></div></div>`;
}
async function togglePostLike(id, button) {
  const data = unwrap(await API.likePost(id));
  if (!data) return;
  $$(`[data-post-id="${id}"] [data-do="like-post"]`).forEach(target => {
    target.classList.toggle("liked", data.liked);
    target.innerHTML = `<i class="fa-${data.liked ? "solid" : "regular"} fa-heart"></i> <span>${formatNumber(data.likes)}</span>`;
  });
  const post = state.feedItems.find(item => item.id === id);
  if (post) { post.liked = data.liked; post.likes = data.likes; }
}
async function toggleComments(id, button) {
  const wrap = button?.closest(".post-card")?.querySelector(".comments-wrap");
  if (!wrap) return;
  wrap.classList.toggle("hidden");
  if (!wrap.classList.contains("hidden")) {
    const data = unwrap(await API.comments(id));
    if (data) $(".comments-list", wrap).innerHTML = data.length ? data.map(commentHtml).join("") : '<p class="comment-empty">还没有评论</p>';
    $(".comment-input", wrap)?.focus();
  }
}
async function submitComment(id, source) {
  const wrap = source?.closest(".post-card")?.querySelector(".comments-wrap");
  const input = $(".comment-input", wrap);
  const content = input?.value.trim();
  if (!content) return showToast("请输入评论内容");
  const data = unwrap(await API.addComment(id, content));
  if (!data) return;
  input.value = "";
  const list = $(".comments-list", wrap);
  $(".comment-empty", list)?.remove();
  list.insertAdjacentHTML("beforeend", commentHtml(data.comment));
  $$(`[data-post-id="${id}"] [data-do="toggle-comments"] span`).forEach(span => { span.textContent = formatNumber(data.comments); });
}
async function submitPost() {
  const textarea = $("#postText");
  const content = textarea.value.trim();
  if (!content) return showToast("请输入动态内容");
  const button = $("#submitPost");
  setBusy(button, true, "发布中...");
  const data = unwrap(await API.post(content, state.postMedia, state.user.location, state.currentCircle?.id || null));
  setBusy(button, false);
  if (!data) return;
  textarea.value = "";
  $("#postChar").textContent = "0";
  resetPostMedia();
  closeModal("postModal");
  await Promise.all([loadDiscover(), loadTasks(), loadProfile()]);
  switchView("discover");
  showToast("动态已发布并保存");
}
function handlePostTool(tool) {
  if (["image", "video", "audio"].includes(tool)) {
    const url = prompt(`请输入${{ image: "图片", video: "视频", audio: "音频" }[tool]} URL（支持直链）`);
    if (!url) return;
    state.postMedia = url.trim();
    state.postMediaType = tool;
    $(".post-preview .preview-item").innerHTML = renderMedia(state.postMedia) || escapeHtml(url);
  } else if (tool === "topic") {
    $("#postText").value += " #今日话题# ";
    $("#postText").focus();
  } else if (tool === "location") {
    $("#postText").value += ` 📍${state.user.location || "本地"} `;
  } else {
    $("#postText").value += " 😊 ";
  }
  $("#postChar").textContent = $("#postText").value.length;
}
function resetPostMedia() {
  state.postMedia = null;
  state.postMediaType = null;
  const preview = $(".post-preview .preview-item");
  if (preview) preview.innerHTML = '<div class="preview-placeholder"><i class="fa-solid fa-image"></i><span>点击添加图片</span></div>';
}
async function loadNearby() {
  const data = unwrap(await API.nearby(), false);
  if (!data) return;
  state.nearby = data;
  renderNearby(data.slice(0, 5));
}
function renderNearby(items) {
  const container = $(".nearby-list");
  if (!container) return;
  container.innerHTML = items.length ? items.map(user => `<div class="nearby-card"><div class="avatar ${user.online ? "ring-online" : ""}"><img src="${escapeHtml(user.avatar)}" alt=""></div>
    <div class="nearby-info"><div class="nearby-name">${escapeHtml(user.nickname)}</div><div class="nearby-dist">${user.distance_km}km · ${user.online ? "在线" : "离线"}</div></div>
    <div class="nearby-actions"><button class="btn-sm" data-do="greet" data-id="${user.id}">打招呼</button><button class="btn-sm outline" data-do="follow" data-id="${user.id}">${user.following ? "已关注" : "关注"}</button></div></div>`).join("") : empty("附近暂时没有用户");
}
async function toggleFollow(id, button) {
  const data = unwrap(await API.follow(id));
  if (!data) return;
  button.textContent = data.following ? "已关注" : "关注";
  showToast(data.following ? "关注成功" : "已取消关注");
  const user = state.nearby?.find(item => item.id === id);
  if (user) user.following = data.following;
}
function openHostRoom(hostId) {
  const room = state.rooms.find(item => item.host_id === hostId);
  if (room) openRoom(room.id);
  else { switchView("voice"); showToast("该用户当前没有开播，请选择其他语音房"); }
}
async function loadStats() {
  const data = unwrap(await API.stats(), false);
  if (!data) return;
  const numbers = $$(".stats-panel .stat-num");
  if (numbers[0]) numbers[0].textContent = formatNumber(data.online);
  if (numbers[1]) numbers[1].textContent = formatNumber(data.rooms);
  if (numbers[2]) numbers[2].textContent = formatNumber(data.nearby);
}

/* ---------- 匹配 ---------- */
async function loadMatchCards() {
  const requestId = ++state.matchRequestId;
  const data = unwrap(await API.matchCards(state.matchFilters), false);
  if (!data || requestId !== state.matchRequestId) return;
  state.matchCards = data;
  state.matchIndex = 0;
  state.matchHistory = [];
  renderMatchStack();
}
function currentMatch() { return state.matchCards[state.matchIndex]; }
function matchCardHtml(user, top = false, index = 0) {
  return `<div class="match-card ${top ? "top" : ""}" ${top ? 'id="topCard"' : ""} style="--idx:${index}">
    <div class="card-bg" style="background-image:url('${escapeHtml(user.avatar)}')"></div>
    <div class="card-info"><h3>${escapeHtml(user.nickname)}，${user.age || "保密"} ${user.is_vip ? '<span class="tag-sm pink">VIP</span>' : ""}</h3>
      <p>${escapeHtml(user.location || "远方")} · ${user.distance_km}km · 匹配度 ${user.match_rate}%</p>
      <div class="card-bio">${escapeHtml(user.bio || "这个人很神秘")}</div>
      <div class="card-tags">${(user.tags || []).map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}</div></div>
    ${top ? '<div class="choice-stamp like"><i class="fa-solid fa-heart"></i> LIKE</div><div class="choice-stamp nope"><i class="fa-solid fa-xmark"></i> NOPE</div>' : ""}
  </div>`;
}
function renderMatchStack() {
  const stack = $("#cardStack");
  if (!stack) return;
  const current = currentMatch();
  if (!current) {
    stack.innerHTML = `<div class="match-empty-state">
      <div class="empty-emoji">😴</div>
      <div class="empty-title">附近暂时没有更多有趣的人啦</div>
      <button class="btn-primary tiny" data-do="reload-match">🔄 重新加载</button>
    </div>`;
    return;
  }
  const next = state.matchCards[state.matchIndex + 1];
  const third = state.matchCards[state.matchIndex + 2];
  stack.innerHTML = `${third ? matchCardHtml(third, false, 2) : ""}${next ? matchCardHtml(next, false, 1) : ""}${matchCardHtml(current, true)}`;
}
async function swipeCard(action) {
  const user = currentMatch();
  const card = $("#topCard");
  if (!user || !card || state.matchBusy) return;
  state.matchBusy = true;
  const liked = action !== "pass";
  card.classList.add(liked ? "like" : "nope");
  card.classList.add(liked ? "swipe-right" : "swipe-left");
  state.matchRequestId += 1;
  const data = unwrap(await API.matchAction(user.id, action));
  if (!data) {
    card.classList.remove("like", "nope", "swipe-left", "swipe-right");
    state.matchBusy = false;
    return;
  }
  state.matchHistory.push(user);
  state.matchIndex += 1;
  if (data.matched) showMatchSuccess(data.target);
  setTimeout(async () => {
    renderMatchStack();
    state.matchBusy = false;
    if (liked) await Promise.all([loadTasks(), loadMatchList()]);
    if (state.matchIndex >= state.matchCards.length) loadMatchCards();
  }, 320);
}
async function undoMatch() {
  const user = state.matchHistory.at(-1);
  if (!user || state.matchBusy) return showToast("没有可撤销的操作");
  const data = unwrap(await API.undoMatch(user.id));
  if (!data) return;
  state.matchHistory.pop();
  state.matchIndex = Math.max(0, state.matchIndex - 1);
  renderMatchStack();
  showToast("已撤销上一次操作");
}
function showMatchSuccess(target) {
  state.matchedPeer = target;
  const modal = $("#matchSuccess");
  $("p", modal).innerHTML = `你和 <strong>${escapeHtml(target.nickname)}</strong> 互相喜欢了`;
  const images = $$(".match-avatars img", modal);
  if (images[0]) images[0].src = state.user.avatar;
  if (images[1]) images[1].src = target.avatar;
  modal.classList.add("active");
}
async function loadMatchList() {
  const data = unwrap(await API.matchList(), false);
  if (!data) return;
  const container = $(".match-list");
  const title = container?.previousElementSibling;
  // 优先更新 count-badge（匹配新 HTML 结构）
  const badge = title?.querySelector("#matchCountBadge, .count-badge");
  if (badge) badge.textContent = `(${data.length})`;
  else if (title) title.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> 已匹配 (${data.length})`;
  if (container) container.innerHTML = data.length ? data.map(user => `<div class="match-item"><div class="avatar"><img src="${escapeHtml(user.avatar)}" alt=""></div><div class="match-info"><div class="match-name">${escapeHtml(user.nickname)}</div><div class="match-time">${timeAgo(user.created_at)}</div></div><button class="btn-sm primary" data-do="match-message" data-id="${user.id}">发消息</button></div>`).join("") : '<div class="empty-mini">还没有匹配的人哦</div>';
  // 侧边栏"匹配中心"徽章显示已匹配人数
  const matchBadge = $("#sideMatchBadge");
  if (matchBadge) {
    const count = data.length;
    matchBadge.textContent = count > 99 ? "99+" : String(count);
    matchBadge.classList.toggle("hidden", count === 0);
  }
}
function handleSegment(button) {
  const group = button.closest(".seg");
  $$(".seg-btn", group).forEach(item => item.classList.remove("active"));
  button.classList.add("active");
  if (button.closest(".pref-item")) {
    const label = $(".seg-btn.active", group)?.textContent;
    state.matchFilters.gender = label === "女生" ? "female" : label === "男生" ? "male" : "";
    loadMatchCards();
  }
}
function applyMatchFilters() { loadMatchCards(); }
function bindMatchGestures() {
  const stack = $("#cardStack");
  if (!stack) return;
  let dragging = false, startX = 0, deltaX = 0, card = null;
  stack.addEventListener("pointerdown", event => {
    card = event.target.closest("#topCard");
    if (!card || state.matchBusy) return;
    dragging = true; startX = event.clientX; deltaX = 0;
    card.setPointerCapture?.(event.pointerId);
    card.style.transition = "none";
  });
  stack.addEventListener("pointermove", event => {
    if (!dragging || !card) return;
    deltaX = event.clientX - startX;
    card.style.transform = `translateX(${deltaX}px) rotate(${deltaX * .03}deg)`;
    card.classList.toggle("like", deltaX > 50);
    card.classList.toggle("nope", deltaX < -50);
  });
  const end = () => {
    if (!dragging || !card) return;
    dragging = false;
    card.style.transition = "";
    card.style.transform = "";
    const action = deltaX > 100 ? "like" : deltaX < -100 ? "pass" : null;
    card.classList.remove("like", "nope");
    if (action) swipeCard(action);
    card = null;
  };
  stack.addEventListener("pointerup", end);
  stack.addEventListener("pointercancel", end);
}

/* ---------- 语音房与礼物 ---------- */
async function loadVoiceRooms(category = "", followed = false) {
  const data = unwrap(await API.voiceRooms(category, followed), false);
  if (!data) return;
  state.rooms = data;
  renderVoiceRooms(data);
}
function renderVoiceRooms(rooms) {
  const grid = $(".voice-grid");
  if (!grid) return;
  const colors = [["#f093fb", "#f5576c"], ["#4facfe", "#00f2fe"], ["#fa709a", "#fee140"], ["#a18cd1", "#fbc2eb"], ["#667eea", "#764ba2"], ["#ff9a9e", "#fecfef"]];
  grid.innerHTML = rooms.length ? rooms.map((room, index) => `<div class="voice-room-card ${index === 0 ? "featured" : ""}" data-room="${room.id}">
    <div class="room-banner" style="background:linear-gradient(135deg,${colors[index % colors.length].join(",")});">${index === 0 ? '<div class="room-badge"><i class="fa-solid fa-fire"></i> 热门</div>' : ""}<div class="listeners"><i class="fa-solid fa-users"></i> <span>${formatNumber(room.listeners)}</span></div></div>
    <div class="room-body"><div class="room-title">${escapeHtml(room.topic)}</div><div class="room-host"><div class="avatar-sm"><img src="${escapeHtml(room.host_avatar)}" alt=""></div><span>房主 · ${escapeHtml(room.host_nickname)}</span></div>
      <div class="room-speakers"><div class="speaker-ring speaking"><img src="${escapeHtml(room.host_avatar)}" alt=""><div class="ring-wave"></div></div></div>
      <div class="room-live-meta">${escapeHtml(room.category || "聊天")} · 当前 ${room.online || 0} 人连接</div>
      <button class="enter-btn" data-do="open-room" data-id="${room.id}">立即加入 <i class="fa-solid fa-arrow-right"></i></button></div></div>`).join("") : empty("该分类暂时没有开播房间");
}
async function createRoom() {
  const topic = $("#createRoomModal input[type='text']")?.value.trim();
  if (!topic) return showToast("请输入房间主题");
  const selected = $("#createRoomModal .form-group:nth-of-type(3) .tag-pick.active")?.textContent || "情感";
  const category = selected.replace(/^\S+\s*/, "").replace("深夜", "深夜电台");
  const button = $("#createRoomModal .modal-actions .btn-primary");
  setBusy(button, true, "创建中...");
  const data = unwrap(await API.createRoom(topic, category));
  setBusy(button, false);
  if (!data) return;
  closeModal("createRoomModal");
  await Promise.all([loadVoiceRooms(), loadStats(), loadProfile()]);
  await openRoom(data.id);
}
async function openRoom(roomId) {
  const room = state.rooms.find(item => item.id === roomId);
  if (!room) return showToast("房间不存在或已下播");
  if (!API.connected) return showToast("实时连接尚未建立，请稍后重试");
  cleanupRoomPeers();
  cleanupRoomSilentTrack();
  state.roomMicStream?.getTracks().forEach(track => track.stop());
  state.roomMicStream = null;
  state.roomRoster = [];
  state.currentRoom = room;
  state.roomMessageIds = new Set();
  $("#roomChatBody").innerHTML = "";
  $("#roomChatPanel").style.display = "flex";
  openModal("roomModal");
  $(".room-title-big").textContent = room.topic;
  $(".room-meta-line").innerHTML = `<span><i class="fa-solid fa-users"></i> <span id="roomOnline">${room.online || 0}</span> 人实时连接</span> · <span><i class="fa-solid fa-clock"></i> ${timeAgo(room.started_at)}开播</span>`;
  $(".chat-count").textContent = String(room.online || 0);
  renderRoomSeats(room);
  $(".live-caption").innerHTML = `<span class="caption-name">${escapeHtml(room.host_nickname)}</span><span class="caption-text">「${escapeHtml(room.topic)}」</span>`;
  const [joined, messages] = await Promise.all([API.joinRoom(roomId), API.roomMessages(roomId)]);
  if (!unwrap(joined)) { closeRoom(); return; }
  const items = unwrap(messages, false) || [];
  items.forEach(appendRoomMessage);
  if (!API.ws.send("room.join", { room_id: roomId })) {
    closeRoom();
    showToast("无法加入实时语音房，请检查连接");
    return;
  }
  updateRoomMicButton();
  loadTasks();
}
function renderRoomSeats(room) {
  renderRoomRoster([{ id: room.host_id, nickname: room.host_nickname, avatar: room.host_avatar, mic: false }]);
  const bar = $(".room-actions-bar");
  bar.innerHTML = `<button class="room-btn mic-btn" data-do="room-mic"><i class="fa-solid fa-microphone-slash"></i><span>开麦</span></button><button class="room-btn" data-do="room-hand"><i class="fa-solid fa-hand"></i><span>举手</span></button><button class="room-btn" id="giftToggleBtn"><i class="fa-solid fa-gift"></i><span>送礼</span></button><button class="room-btn" data-do="room-invite"><i class="fa-solid fa-user-plus"></i><span>邀请</span></button><button class="room-btn chat-toggle" id="chatToggleBtn"><i class="fa-solid fa-comment"></i><span>聊天室</span></button>`;
  $("#giftToggleBtn").addEventListener("click", () => $("#giftPanel")?.classList.toggle("active"));
  $("#chatToggleBtn").addEventListener("click", () => {
    const panel = $("#roomChatPanel");
    panel.style.display = panel.style.display === "none" ? "flex" : "none";
  });
}
function renderRoomRoster(users) {
  const stage = $(".mic-stage");
  if (!stage || !state.currentRoom) return;
  const unique = [...new Map(users.map(user => [user.id, user])).values()];
  unique.sort((first, second) => Number(second.id === state.currentRoom.host_id) - Number(first.id === state.currentRoom.host_id) || first.id - second.id);
  const seats = unique.slice(0, 6).map(user => {
    const host = user.id === state.currentRoom.host_id;
    const self = user.id === state.user.id;
    return `<div class="mic-seat ${host ? "host" : ""}" data-room-user="${user.id}"><div class="mic-avatar ${user.mic ? "speaking" : ""}"><img src="${escapeHtml(user.avatar || state.user.avatar)}" alt="">${user.mic ? '<div class="ring-wave big"></div>' : ""}<div class="mic-badge ${user.mic ? "" : "muted"}"><i class="fa-solid fa-microphone${user.mic ? "" : "-slash"}"></i></div></div><span class="mic-name">${escapeHtml(user.nickname)}${self ? "（我）" : ""}</span><span class="mic-role">${host ? "房主" : user.mic ? "发言中" : "旁听中"}</span></div>`;
  }).join("");
  const emptySeats = Array.from({ length: Math.max(0, 6 - unique.length) }, () => '<button class="mic-seat empty" data-do="room-mic" type="button" title="点击上麦"><div class="mic-avatar empty"><i class="fa-solid fa-plus"></i></div><span class="mic-name">点击上麦</span></button>').join("");
  stage.innerHTML = seats + emptySeats;
}
function closeRoom() {
  if (state.currentRoom) API.ws.send("room.leave", { room_id: state.currentRoom.id });
  state.currentRoom = null;
  state.roomMessageIds.clear();
  state.roomMicStream?.getTracks().forEach(track => track.stop());
  state.roomMicStream = null;
  state.roomMicBusy = false;
  state.roomRoster = [];
  cleanupRoomPeers();
  cleanupRoomSilentTrack();
  closeModal("roomModal");
  $("#giftPanel")?.classList.remove("active");
  loadVoiceRooms();
}
async function sendRoomMessage() {
  const input = $("#roomChatInput");
  const content = input?.value.trim();
  if (!content || !state.currentRoom) return;
  const data = unwrap(await API.sendRoomMessage(state.currentRoom.id, content));
  if (data) { input.value = ""; appendRoomMessage(data); }
}
function appendRoomMessage(message) {
  if (!state.currentRoom || message.room_id !== state.currentRoom.id || state.roomMessageIds.has(message.id)) return;
  state.roomMessageIds.add(message.id);
  const body = $("#roomChatBody");
  const gift = message.msg_type === "gift";
  body.insertAdjacentHTML("beforeend", `<div class="chat-msg ${gift ? "system" : ""}" data-message="${message.id}">${gift ? '<span>🎁 ' + escapeHtml(message.nickname) + ' ' + escapeHtml(message.content) + '</span>' : '<span class="c-name">' + escapeHtml(message.nickname) + ':</span> ' + escapeHtml(message.content)}</div>`);
  body.scrollTop = body.scrollHeight;
  while (body.children.length > 100) body.firstElementChild.remove();
}
async function sendRoomAction(action, message) {
  if (!state.currentRoom) return;
  const data = unwrap(await API.roomAction(state.currentRoom.id, action));
  if (data) showToast(message);
}
function updateRoomMicButton() {
  const enabled = Boolean(state.roomMicStream);
  $$(".room-actions-bar .mic-btn").forEach(button => {
    button.disabled = state.roomMicBusy;
    button.innerHTML = `<i class="fa-solid fa-microphone${enabled ? "" : "-slash"}"></i><span>${state.roomMicBusy ? "切换中" : enabled ? "闭麦" : "开麦"}</span>`;
  });
}
async function toggleRoomMic() {
  if (!state.currentRoom || state.roomMicBusy) return;
  state.roomMicBusy = true;
  updateRoomMicButton();
  try {
    if (state.roomMicStream) {
      state.roomMicStream.getTracks().forEach(track => track.stop());
      state.roomMicStream = null;
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!state.currentRoom) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      state.roomMicStream = stream;
    }
    await syncRoomPeerTracks();
    const enabled = Boolean(state.roomMicStream);
    API.ws.send("room.mic", { room_id: state.currentRoom.id, enabled });
    showToast(enabled ? "麦克风已开启，房间成员现在可以听到你" : "麦克风已关闭");
  } catch (error) {
    console.error("房间麦克风切换失败", error);
    state.roomMicStream?.getTracks().forEach(track => track.stop());
    state.roomMicStream = null;
    await syncRoomPeerTracks();
    showToast("无法使用麦克风，请检查浏览器权限");
  } finally {
    state.roomMicBusy = false;
    updateRoomMicButton();
  }
}
function ensureRoomPeer(user) {
  const peerId = Number(user?.id);
  if (!peerId || peerId === state.user.id || !state.currentRoom) return null;
  const existing = state.roomPeers.get(peerId);
  if (existing) return existing;
  const peerConnection = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  const initiator = state.user.id < peerId;
  const transceiver = initiator ? peerConnection.addTransceiver("audio", { direction: "sendrecv" }) : null;
  const peer = {
    user, peerConnection, transceiver, remoteStream: null, remoteMic: Boolean(user.mic),
    iceQueue: [], makingOffer: false, needsNegotiation: true,
  };
  state.roomPeers.set(peerId, peer);
  peerConnection.onicecandidate = event => {
    if (event.candidate && state.currentRoom) API.ws.send("room.signal", {
      room_id: state.currentRoom.id, target_id: peerId, kind: "ice", candidate: event.candidate,
    });
  };
  peerConnection.ontrack = event => {
    peer.remoteStream = event.streams[0] || new MediaStream([event.track]);
    attachRoomRemoteAudio(peerId, peer.remoteStream);
  };
  peerConnection.onconnectionstatechange = () => {
    const seat = $(`[data-room-user="${peerId}"]`);
    if (seat) seat.dataset.connection = peerConnection.connectionState;
  };
  if (initiator) applyRoomTrackToPeer(peer).then(() => negotiateRoomPeer(peerId));
  return peer;
}
async function applyRoomTrackToPeer(peer) {
  if (!peer.transceiver || peer.peerConnection.signalingState === "closed") return;
  const track = state.roomMicStream?.getAudioTracks()[0] || getRoomSilentTrack();
  await peer.transceiver.sender.replaceTrack(track);
}
function getRoomSilentTrack() {
  if (state.roomSilentTrack) return state.roomSilentTrack;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  const context = new AudioContextClass();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const destination = context.createMediaStreamDestination();
  gain.gain.value = 0;
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start();
  state.roomSilentContext = context;
  state.roomSilentTrack = destination.stream.getAudioTracks()[0];
  return state.roomSilentTrack;
}
function cleanupRoomSilentTrack() {
  state.roomSilentTrack?.stop();
  state.roomSilentTrack = null;
  state.roomSilentContext?.close().catch(() => {});
  state.roomSilentContext = null;
}
async function syncRoomPeerTracks() {
  await Promise.all([...state.roomPeers.values()].map(async peer => {
    try { await applyRoomTrackToPeer(peer); }
    catch (error) { console.error("同步房间音轨失败", error); }
  }));
}
async function negotiateRoomPeer(peerId) {
  const peer = state.roomPeers.get(peerId);
  if (!peer || state.user.id > peerId || !state.currentRoom) return;
  const { peerConnection } = peer;
  if (peer.makingOffer || peerConnection.signalingState !== "stable") {
    peer.needsNegotiation = true;
    return;
  }
  if (!peer.needsNegotiation) return;
  peer.makingOffer = true;
  peer.needsNegotiation = false;
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    API.ws.send("room.signal", {
      room_id: state.currentRoom.id, target_id: peerId,
      kind: "description", description: peerConnection.localDescription,
    });
  } catch (error) {
    peer.needsNegotiation = true;
    console.error("房间 WebRTC 协商失败", error);
  } finally {
    peer.makingOffer = false;
  }
}
async function onRoomSignal(data) {
  if (!state.currentRoom || data.room_id !== state.currentRoom.id) return;
  const peerId = Number(data.from_user?.id);
  const peer = ensureRoomPeer(data.from_user);
  if (!peer || !peerId) return;
  const { peerConnection } = peer;
  try {
    if (data.kind === "ice") {
      if (peerConnection.remoteDescription) await peerConnection.addIceCandidate(data.candidate);
      else peer.iceQueue.push(data.candidate);
      return;
    }
    if (data.kind !== "description") return;
    await peerConnection.setRemoteDescription(data.description);
    if (data.description.type === "offer") {
      peer.transceiver = peerConnection.getTransceivers().find(item => item.receiver.track.kind === "audio");
      if (!peer.transceiver) throw new Error("语音房 Offer 中没有音频通道");
      peer.transceiver.direction = "sendrecv";
      await applyRoomTrackToPeer(peer);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      API.ws.send("room.signal", {
        room_id: state.currentRoom.id, target_id: peerId,
        kind: "description", description: peerConnection.localDescription,
      });
    }
    while (peer.iceQueue.length) await peerConnection.addIceCandidate(peer.iceQueue.shift());
  } catch (error) { console.error("房间 WebRTC 信令处理失败", error); }
}
function syncRoomRoster(data) {
  if (!state.currentRoom || data.room_id !== state.currentRoom.id) return;
  state.roomRoster = data.users || [];
  state.currentRoom.online = data.online;
  renderRoomRoster(state.roomRoster);
  const remoteUsers = state.roomRoster.filter(user => user.id !== state.user.id);
  const remoteIds = new Set(remoteUsers.map(user => user.id));
  [...state.roomPeers.keys()].forEach(peerId => { if (!remoteIds.has(peerId)) cleanupRoomPeer(peerId); });
  remoteUsers.forEach(user => {
    const peer = ensureRoomPeer(user);
    if (!peer) return;
    peer.user = user;
    peer.remoteMic = Boolean(user.mic);
  });
}
function attachRoomRemoteAudio(peerId, stream) {
  let container = $("#roomAudio");
  if (!container) {
    container = document.createElement("div");
    container.id = "roomAudio";
    container.hidden = true;
    $("#roomModal").appendChild(container);
  }
  let audio = $(`audio[data-peer="${peerId}"]`, container);
  if (!audio) {
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.dataset.peer = String(peerId);
    container.appendChild(audio);
  }
  audio.srcObject = stream;
  audio.play().catch(() => document.addEventListener("click", () => audio.play().catch(() => {}), { once: true }));
}
function cleanupRoomPeer(peerId) {
  const peer = state.roomPeers.get(peerId);
  if (!peer) return;
  state.roomPeers.delete(peerId);
  peer.peerConnection.ontrack = null;
  peer.peerConnection.onicecandidate = null;
  peer.peerConnection.close();
  $(`#roomAudio audio[data-peer="${peerId}"]`)?.remove();
}
function cleanupRoomPeers() {
  [...state.roomPeers.keys()].forEach(cleanupRoomPeer);
  $("#roomAudio")?.replaceChildren();
}
async function loadGifts() {
  const data = unwrap(await API.gifts(), false);
  if (!data) return;
  state.gifts = data;
  renderGifts();
}
function renderGifts() {
  const groups = {
    "热门": ["heart", "diamond", "box", "rose"],
    "特权": ["bear", "crown", "mic"],
    "特效": ["box", "rocket", "rainbow"],
    "豪华": ["trophy", "mic", "rainbow"],
  };
  const items = state.gifts.filter(gift => (groups[state.giftTab] || groups["热门"]).includes(gift.key));
  if (items.length && !items.some(gift => gift.key === state.selectedGift)) state.selectedGift = items[0].key;
  $("#giftGrid").innerHTML = items.map(gift => `<div class="gift-item ${gift.key === state.selectedGift ? "selected" : ""}" data-gift="${gift.key}"><div class="gift-emoji">${gift.emoji}</div><div class="gift-name">${escapeHtml(gift.name)}</div><div class="gift-price">💎 ${gift.price}</div></div>`).join("");
  $$("#giftGrid .gift-item").forEach(item => item.addEventListener("click", () => {
    state.selectedGift = item.dataset.gift;
    $$("#giftGrid .gift-item").forEach(gift => gift.classList.toggle("selected", gift === item));
  }));
}
function updateGiftCount(count) {
  state.giftCount = Math.max(1, Math.min(99, count));
  $(".gift-count span").textContent = state.giftCount;
}
async function sendGift() {
  if (!state.currentRoom) return showToast("请先进入语音房");
  const button = $(".gift-bottom > .btn-primary");
  setBusy(button, true, "赠送中...");
  const data = unwrap(await API.sendGift(state.currentRoom.id, state.selectedGift, state.giftCount));
  setBusy(button, false);
  if (!data) { state.giftComboCount = 0; return; }
  appendRoomMessage(data.message);
  showGiftBarrage(data.message);
  updateBalance(data.coins);
  if (state.giftCombo) {
    state.giftComboCount += 1;
    showToast(`连击 ×${state.giftComboCount}：${data.message.content}`);
  } else {
    state.giftComboCount = 0;
    $("#giftPanel")?.classList.remove("active");
  }
}
function showGiftBarrage(message) {
  const layer = $("#giftBarrage");
  if (!layer) return;
  const item = document.createElement("div");
  item.className = "barrage-item";
  item.innerHTML = `<span class="barrage-ico">${escapeHtml(message.gift_emoji || "🎁")}</span> ${escapeHtml(message.nickname)} ${escapeHtml(message.content)}`;
  layer.appendChild(item);
  setTimeout(() => item.remove(), 3500);
}
function updateBalance(coins) {
  if (state.user) state.user.coins = coins;
  const amountEl = $(".wallet-amount");
  if (amountEl) amountEl.textContent = `💰 ${formatNumber(coins)}`;
  const exchangeEl = $(".wallet-exchange");
  if (exchangeEl) exchangeEl.textContent = `= ￥ ${(coins / 10).toFixed(2)}`;
  const giftHead = $("#giftPanel .gift-head strong");
  if (giftHead) giftHead.textContent = formatNumber(coins);
}

/* ---------- 圈圈频道 ---------- */
async function loadCircles() {
  const data = unwrap(await API.circles(), false);
  if (!data) return;
  state.circles = data;
  renderCircleSidebar();
  renderHotCircles();
  if (!state.currentCircle && data[0]) await openCircle(data[0].id, false);
}
function renderCircleSidebar() {
  const container = $(".circle-cats");
  if (!container) return;
  const render = items => items.map(circle => `<a class="cat ${state.currentCircle?.id === circle.id ? "active" : ""}" href="#" data-do="open-circle" data-id="${circle.id}">${escapeHtml(circle.icon)} ${escapeHtml(circle.name)}</a>`).join("");
  const joined = state.circles.filter(item => item.joined);
  const recommended = state.circles.filter(item => !item.joined);
  container.innerHTML = `<h5>我的圈子</h5>${joined.length ? render(joined) : '<p class="sidebar-empty">加入圈子后会显示在这里</p>'}<h5>推荐圈子</h5>${render(recommended)}`;
}
function renderHotCircles() {
  const container = $(".hot-circles");
  if (!container) return;
  container.innerHTML = state.circles.slice(0, 4).map((circle, index) => `<a class="hot-circle-item" href="#" data-do="open-circle" data-id="${circle.id}"><span class="rank">${index + 1}</span><div class="circle-ico">${escapeHtml(circle.icon)}</div><div class="circle-info"><div class="circle-name">${escapeHtml(circle.name)}</div><div class="circle-meta">${formatNumber(circle.members)}成员 · ${formatNumber(circle.post_count)} 发帖</div></div></a>`).join("");
}
async function openCircle(id, changeView = true) {
  const circle = state.circles.find(item => item.id === id);
  if (!circle) return;
  state.currentCircle = circle;
  if (changeView) switchView("circle");
  renderCircleSidebar();
  const [postsData, rank] = await Promise.all([API.circlePosts(id), API.circleRank(id)]);
  state.circlePosts = unwrap(postsData, false)?.items || [];
  state.circleRank = unwrap(rank, false) || [];
  renderCircleBanner();
  renderCirclePosts();
  renderCircleRank();
}
function renderCircleBanner() {
  const circle = state.currentCircle;
  if (!circle) return;
  $(".ch-icon").textContent = circle.icon;
  $(".ch-info h2").textContent = circle.name;
  $(".ch-info > p").textContent = `${formatNumber(circle.members)} 成员 · ${formatNumber(circle.post_count)} 条帖子`;
  $(".ch-actions").innerHTML = `<button class="btn-white" data-do="join-circle" data-id="${circle.id}">${circle.joined ? "✓ 已加入" : "+ 加入圈子"}</button><button class="btn-ghost" data-do="circle-notify"><i class="fa-solid fa-bell"></i> ${localStorage.getItem('circle_notify_' + circle.id) === "1" ? "已订阅" : "通知"}</button><button class="btn-ghost" data-do="share-circle"><i class="fa-solid fa-share"></i> 分享</button>`;
}
function renderCirclePosts() {
  const container = $(".topic-list");
  if (!container || !state.currentCircle) return;
  const filters = {
    "资讯": /资讯|新闻|公告/i, "视频": /视频|http.*\.(mp4|webm)/i,
    "战绩": /战绩|赛季|王者|钻石|段位/i, "组队": /组队|开黑|招募|缺/i,
  };
  const filter = filters[state.circleTab];
  const items = filter ? state.circlePosts.filter(post => filter.test(`${post.content} ${post.image || ""}`)) : state.circlePosts;
  container.innerHTML = items.length ? items.map(post => `<div class="topic-card"><div class="topic-ico">${escapeHtml(state.currentCircle.icon)}</div><div class="topic-body"><div class="topic-tag">${escapeHtml(state.currentCircle.name)}</div><h4>${escapeHtml(post.content.slice(0, 60))}</h4><p>${escapeHtml(post.content.slice(60, 180) || "点击进入讨论，查看完整内容")}</p><div class="topic-meta"><span>${escapeHtml(post.nickname)}</span> · <span>${timeAgo(post.created_at)}</span> · <span><i class="fa-regular fa-heart"></i> ${formatNumber(post.likes)}</span> · <span><i class="fa-regular fa-comment"></i> ${formatNumber(post.comments)}</span></div></div><button class="topic-reply" data-do="open-post" data-id="${post.id}">去围观 →</button></div>`).join("") : empty("这个分类暂时没有帖子");
}
function renderCircleRank() {
  const panel = $(".circle-rank .panel:first-child");
  if (!panel) return;
  const rows = state.circleRank || [];
  panel.innerHTML = `<h4><i class="fa-solid fa-trophy"></i> 本周活跃榜</h4>${rows.length ? rows.map((row, index) => `<div class="rank-item"><span class="rk-num ${["gold", "silver", "bronze"][index] || ""}">${index + 1}</span><span class="rk-name">${escapeHtml(row.nickname)}</span><span class="rk-score">${row.score}</span></div>`).join("") : empty("暂无活跃数据")}`;
  const stats = $$(".circle-rank .ch-stat strong");
  if (stats[0]) stats[0].textContent = formatNumber(state.currentCircle.members);
  if (stats[1]) stats[1].textContent = `+${state.currentCircle.joined ? 1 : 0}`;
  if (stats[2]) stats[2].textContent = formatNumber(state.currentCircle.post_count);
}
async function createCircle() {
  const name = prompt("请输入新频道名称（2-30字）");
  if (!name || name.trim().length < 2) return;
  const icon = prompt("输入一个频道图标 Emoji", "💬") || "💬";
  const data = unwrap(await API.createCircle(name.trim(), icon));
  if (!data) return;
  await loadCircles();
  await openCircle(data.id);
  showToast("频道创建成功");
}
async function toggleCircleMembership(id) {
  const data = unwrap(await API.joinCircle(id));
  if (!data) return;
  const circle = state.circles.find(item => item.id === id);
  if (circle) { circle.joined = data.joined; circle.members = data.members; }
  renderCircleBanner();
  renderCircleSidebar();
  renderHotCircles();
  showToast(data.joined ? "已加入圈子" : "已退出圈子");
}
function toggleCircleNotify() {
  const circle = state.currentCircle;
  const key = `circle_notify_${circle.id}`;
  localStorage.setItem(key, localStorage.getItem(key) === "1" ? "0" : "1");
  renderCircleBanner();
  showToast(localStorage.getItem(key) === "1" ? "已订阅圈子通知" : "已取消圈子通知");
}

/* ---------- 私聊、语音消息 ---------- */
async function loadConversations() {
  const data = unwrap(await API.conversations(), false);
  if (!data) return;
  state.conversations = data;
  renderConversations();
  if (!state.currentPeer && data[0]) await openChat(data[0].peer_id, false);
  else if (!data.length) {
    $("#chatBody").innerHTML = empty("还没有会话，去附近的人或匹配中心发起聊天吧");
    $(".chat-user-name").textContent = "消息中心";
    $(".chat-user-sub").textContent = "选择左侧会话开始聊天";
  }
}
function renderConversations() {
  const container = $(".chat-list-body");
  if (!container) return;
  const keyword = $(".chat-search input")?.value.trim().toLowerCase() || "";
  const items = state.conversations.filter(item => `${item.peer_name} ${item.last_msg}`.toLowerCase().includes(keyword));
  container.innerHTML = items.length ? items.map(item => `<div class="chat-item ${state.currentPeer === item.peer_id ? "active" : ""}" data-peer="${item.peer_id}"><div class="avatar ${item.online ? "ring-online" : ""}"><img src="${escapeHtml(item.peer_avatar)}" alt=""></div><div class="chat-info"><div class="chat-name">${escapeHtml(item.peer_name)}</div><div class="chat-preview">${escapeHtml(item.last_msg)}</div></div><div class="chat-meta"><span class="chat-time">${timeAgo(item.last_time)}</span>${item.unread ? '<span class="chat-unread">' + item.unread + '</span>' : ""}</div></div>`).join("") : empty(keyword ? "没有匹配的聊天" : "从附近的人或匹配列表发起聊天");
  $$(".chat-item[data-peer]", container).forEach(item => item.addEventListener("click", () => openChat(Number(item.dataset.peer))));
  const unread = state.conversations.reduce((total, item) => total + (Number(item.unread) || 0), 0);
  const badge = $("#chatListBadge");
  if (badge) {
    badge.textContent = unread > 99 ? "99+" : String(unread);
    badge.classList.toggle("hidden", unread === 0);
  }
  // 侧边栏"消息中心"徽章同步未读总数
  const sideBadge = $("#sideChatBadge");
  if (sideBadge) {
    sideBadge.textContent = unread > 99 ? "99+" : String(unread);
    sideBadge.classList.toggle("hidden", unread === 0);
  }
}
async function openChat(peerId, changeView = true) {
  if (!peerId || peerId === state.user.id) return;
  state.currentPeer = peerId;
  state.chatMessageIds = new Set();
  state.chatLoadingPeer = peerId;
  state.chatPendingMessages = [];
  closeChatList();
  $("#emojiPanel")?.classList.remove("active");
  if (changeView) switchView("chat");
  renderConversations();
  $("#chatBody").innerHTML = '<div class="loading-state">正在加载聊天记录...</div>';
  const data = unwrap(await API.messages(peerId));
  if (state.currentPeer !== peerId) return;
  if (!data) {
    state.chatLoadingPeer = null;
    state.chatPendingMessages = [];
    return;
  }
  state.peerInfo = data.peer;
  state.currentConversation = data.conversation_id;
  updateChatBlockState();
  $(".chat-user-info .avatar img").src = data.peer.avatar;
  $(".chat-user-info .avatar").classList.toggle("ring-online", data.peer.online);
  $(".chat-user-name").textContent = data.peer.nickname;
  $(".chat-user-sub").textContent = data.peer.online ? "在线" : "离线";
  $("#chatBody").innerHTML = "";
  state.chatMessageIds = new Set();
  const pending = state.chatPendingMessages;
  [...data.items, ...pending].sort((first, second) => first.id - second.id).forEach(appendChatMessage);
  state.chatLoadingPeer = null;
  state.chatPendingMessages = [];
  if (!data.items.length && !pending.length) $("#chatBody").innerHTML = empty("开始你们的第一段对话吧");
  renderConversations();
}
function appendChatMessage(message) {
  if (state.chatMessageIds.has(message.id)) return;
  state.chatMessageIds.add(message.id);
  $("#chatBody .empty-state")?.remove();
  const sent = message.sender_id === state.user.id;
  let content = escapeHtml(message.content);
  if (message.msg_type === "image") content = `<img class="chat-image" src="${escapeHtml(message.content)}" alt="聊天图片" data-preview="${escapeHtml(message.content)}" data-media-type="image">`;
  else if (message.msg_type === "video") content = `<video class="chat-video" src="${escapeHtml(message.content)}" controls playsinline preload="metadata" data-preview="${escapeHtml(message.content)}" data-media-type="video"></video>`;
  else if (message.msg_type === "voice") content = `<audio class="chat-audio" src="${escapeHtml(message.content)}" controls></audio>`;
  const avatarHtml = sent ? "" : '<div class="avatar-sm"><img src="' + escapeHtml(message.avatar || state.peerInfo?.avatar) + '" alt=""></div>';
  const readHtml = sent ? ' · ' + (message.read ? "已读" : "已送达") : "";
  const html = `<div class="msg ${sent ? "sent" : "received"}" data-message="${message.id}">${avatarHtml}<div class="msg-content"><p>${content}</p><span class="msg-time">${formatTime(message.created_at)}${readHtml}</span></div></div>`;
  $("#chatBody").insertAdjacentHTML("beforeend", html);
  $("#chatBody").scrollTop = $("#chatBody").scrollHeight;
}
async function sendChatMessage() {
  const input = $("#chatInput");
  const content = input?.value.trim();
  if (!content || !state.currentPeer) return showToast("请先选择聊天对象");
  if (state.peerInfo?.blocked) return showToast("请先解除屏蔽再发送消息");
  const button = $("#chatSendBtn");
  button.disabled = true;
  const data = unwrap(await API.sendMessage(state.currentPeer, content));
  button.disabled = false;
  if (!data) return;
  input.value = "";
  appendChatMessage(data);
  debounceConversations();
}
function sendImageMessage() {
  if (!state.currentPeer) return showToast("请先选择聊天对象");
  if (state.peerInfo?.blocked) return showToast("请先解除屏蔽再发送消息");
  const input = $("#chatMediaInput");
  if (input) { input.value = ""; input.click(); }
}
async function handleChatMediaUpload(event) {
  const input = event?.target;
  const files = Array.from(input?.files || []);
  if (!files.length) return;
  if (!state.currentPeer) { showToast("请先选择聊天对象"); return; }
  if (state.peerInfo?.blocked) { showToast("请先解除屏蔽再发送消息"); return; }
  input.value = "";
  for (const file of files) {
    const isVideo = file.type.startsWith("video/");
    if (!isVideo && !file.type.startsWith("image/")) {
      showToast(`${file.name} 不是图片或视频`);
      continue;
    }
    if (file.size > 20 * 1024 * 1024) {
      showToast(`${file.name} 超过 20MB，已跳过`);
      continue;
    }
    const msgType = isVideo ? "video" : "image";
    showToast(`正在上传 ${file.name}…`);
    const upload = unwrap(await API.uploadFile(file), false);
    if (!upload?.url) { showToast(`${file.name} 上传失败`); continue; }
    const data = unwrap(await API.sendMessage(state.currentPeer, upload.url, msgType), false);
    if (data) {
      appendChatMessage(data);
      debounceConversations();
      showToast(`${isVideo ? "视频" : "图片"}已发送`);
    } else {
      showToast(`${file.name} 发送失败`);
    }
  }
}
function openMediaPreview(url, mediaType) {
  const overlay = $("#mediaPreviewOverlay");
  const img = $("#mediaPreviewImg");
  const video = $("#mediaPreviewVideo");
  if (!overlay || !url) return;
  img.style.display = "none";
  video.style.display = "none";
  video.pause?.();
  video.removeAttribute("src");
  video.load?.();
  if (mediaType === "video") {
    video.src = url;
    video.style.display = "block";
    video.play?.().catch(() => {});
  } else {
    img.src = url;
    img.style.display = "block";
  }
  overlay.classList.add("show");
  document.body.style.overflow = "hidden";
}
function closeMediaPreview() {
  const overlay = $("#mediaPreviewOverlay");
  const video = $("#mediaPreviewVideo");
  if (video) { video.pause?.(); video.removeAttribute("src"); video.load?.(); }
  overlay?.classList.remove("show");
  document.body.style.overflow = "";
}
async function toggleChatMore(event) {
  event?.stopPropagation();
  if (!state.peerInfo) return showToast("请先选择聊天对象");
  $("#chatMoreMenu")?.remove();
  const menu = document.createElement("div");
  menu.id = "chatMoreMenu";
  menu.className = "chat-more-menu";
  menu.innerHTML = `<button type="button" data-chat-action="profile"><i class="fa-regular fa-user"></i> 查看联系人资料</button><button type="button" data-chat-action="share"><i class="fa-solid fa-share-nodes"></i> 分享联系人名片</button><button type="button" data-chat-action="block"><i class="fa-solid fa-shield-halved"></i> ${state.peerInfo.blocked ? "移出黑名单" : "加入黑名单"}</button>`;
  $(".chat-head-actions").appendChild(menu);
  menu.addEventListener("click", async click => {
    const action = click.target.closest("[data-chat-action]")?.dataset.chatAction;
    if (!action) return;
    const peer = state.peerInfo;
    if (action === "profile") {
      alert(`${peer.nickname}\nID：${peer.id}\n${peer.bio || "对方还没有填写个人简介"}\n地区：${peer.location || "未知"}`);
    } else if (action === "share") {
      await shareText(`联系人：${peer.nickname}`, `${peer.nickname}：${peer.bio || "圈圈语音社联系人"}`);
    } else if (action === "block") {
      const result = unwrap(await API.toggleBlock(peer.id));
      if (result) {
        state.peerInfo.blocked = result.blocked;
        updateChatBlockState();
        showToast(result.blocked ? "已加入黑名单，双方暂时不能互发消息" : "已移出黑名单");
      }
    }
    menu.remove();
  });
}
document.addEventListener("click", event => {
  if (!event.target.closest("#chatMoreMenu, .chat-head-actions")) $("#chatMoreMenu")?.remove();
});
async function toggleVoiceRecording() {
  if (state.recorder?.state === "recording") return stopVoiceRecording();
  if (!state.currentPeer) return showToast("请先选择聊天对象");
  if (state.peerInfo?.blocked) return showToast("请先解除屏蔽再发送消息");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.recordChunks = [];
    state.recordCancelled = false;
    state.recorder = new MediaRecorder(stream);
    state.recorder.addEventListener("dataavailable", event => { if (event.data.size) state.recordChunks.push(event.data); });
    state.recorder.addEventListener("stop", async () => {
      stream.getTracks().forEach(track => track.stop());
      $("#recordWrap").style.display = "none";
      $("#chatInput").style.display = "";
      if (state.recordCancelled) return;
      const blob = new Blob(state.recordChunks, { type: state.recorder.mimeType || "audio/webm" });
      if (blob.size > 1500000) return showToast("语音消息过长，请控制在约 60 秒内");
      const dataUrl = await blobToDataUrl(blob);
      const data = unwrap(await API.sendMessage(state.currentPeer, dataUrl, "voice"));
      if (data) { appendChatMessage(data); debounceConversations(); }
    });
    state.recorder.start();
    $("#recordWrap").style.display = "flex";
    $("#chatInput").style.display = "none";
    showToast("正在录音，点击结束按钮发送");
  } catch { showToast("无法录音，请检查麦克风权限"); }
}
function stopVoiceRecording() { if (state.recorder?.state === "recording") state.recorder.stop(); }
function cancelVoiceRecording() { state.recordCancelled = true; stopVoiceRecording(); }
function blobToDataUrl(blob) {
  return new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
}
function handleTyping() {
  if (!state.currentPeer) return;
  API.ws.send("typing", { target_id: state.currentPeer, typing: true });
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(() => API.ws.send("typing", { target_id: state.currentPeer, typing: false }), 800);
}
const debounceConversations = debounce(loadConversations, 500);

/* ---------- 通知、任务、钱包、VIP ---------- */
const NOTIF_ICONS = {
  like: "fa-heart", comment: "fa-comment", follow: "fa-user-plus",
  system: "fa-bell", gift: "fa-gift", match: "fa-heart", task: "fa-list-check",
};
async function loadNotifications(type = "") {
  const data = unwrap(await API.notifications(type), false);
  if (!data) return;
  state.notifications = data;
  const container = $(".notif-list");
  if (!container) return;
  container.innerHTML = data.length ? data.map(item => {
    const key = NOTIF_ICONS[item.type] ? item.type : "system";
    const icon = NOTIF_ICONS[key];
    const avatarHtml = item.from_avatar
      ? `<div class="avatar"><img src="${escapeHtml(item.from_avatar)}" alt=""></div>`
      : `<div class="ni-icon ni-${key}"><i class="fa-solid ${icon}"></i></div>`;
    return `<div class="notif-item ${item.is_read ? "" : "unread"} ${escapeHtml(item.type || "")}" data-id="${item.id}">
      ${avatarHtml}
      <div class="ni-body">
        <div class="ni-head">
          <span class="ni-title">${escapeHtml(item.content || "")}</span>
          <span class="ni-time">${timeAgo(item.created_at)}</span>
        </div>
      </div>
      ${item.is_read ? "" : '<span class="unread-dot"></span>'}
    </div>`;
  }).join("") : empty("暂无通知");
  const hasUnread = data.some(item => !item.is_read);
  $$(".notif-dot").forEach(dot => { dot.style.display = hasUnread ? "block" : "none"; });
  // 侧边栏"通知中心"徽章显示未读通知总数
  const notifUnread = data.filter(item => !item.is_read).length;
  const notifBadge = $("#sideNotifBadge");
  if (notifBadge) {
    notifBadge.textContent = notifUnread > 99 ? "99+" : String(notifUnread);
    notifBadge.classList.toggle("hidden", notifUnread === 0);
  }
}
async function markNotificationsRead() {
  const data = unwrap(await API.markAllRead(), false);
  await loadNotifications();
  const unread = $$("#notifDrawer .notif-item.unread");
  unread.forEach(el => el.classList.remove("unread"));
  showToast(data ? "通知已全部标为已读" : "已刷新通知");
}
async function loadTasks() {
  const data = unwrap(await API.tasks(), false);
  if (!data) return;
  const panel = $(".task-panel");
  if (!panel) return;
  panel.innerHTML = `<h4><i class="fa-solid fa-list-check"></i> 每日任务</h4>${data.map(task => `<div class="task-item"><span class="task-ico">${task.icon}</span><span class="task-text">${escapeHtml(task.task_text)}</span><span class="task-reward">+${task.reward}💎</span><button class="btn-sm tiny ${task.claimed ? "done" : task.completed ? "primary" : "progress"}" data-do="task" data-key="${task.task_key}">${task.claimed ? "已领取" : task.completed ? "领奖励" : task.progress}</button></div>`).join("")}`;
}
async function handleTask(key, button) {
  const data = unwrap(await API.completeTask(key), false);
  if (data) {
    showToast(data.msg);
    updateBalance(data.coins);
    await loadTasks();
  } else {
    if (key === "post") openModal("postModal");
    else if (key === "voice") switchView("voice");
    else if (key === "match") switchView("match");
    else showToast("今日签到奖励已领取或暂不可领取");
  }
}
async function loadWallet() {
  openModal("wallet");
  const data = unwrap(await API.wallet(), false);
  if (!data) return;
  if (typeof data.coins === "number") updateBalance(data.coins);
  if (state.user) {
    state.user.coins = data.coins ?? state.user.coins;
    state.user.diamonds = data.diamonds ?? state.user.diamonds;
  }
  // 更新钱包弹窗余额（#modal-wallet）
  const coinsEl = document.querySelector("#modal-wallet .balance-card.coins-display .balance-value");
  const diamondsEl = document.querySelector("#modal-wallet .balance-card.diamonds-display .balance-value");
  if (coinsEl) coinsEl.textContent = formatNumber(data.coins ?? 0);
  if (diamondsEl) diamondsEl.textContent = formatNumber(data.diamonds ?? 0);
  // 交易记录
  const content = document.querySelector("#modal-wallet .modal-body");
  if (content) {
    let list = content.querySelector(".wallet-transactions");
    if (!list) {
      list = document.createElement("div");
      list.className = "wallet-transactions";
      content.appendChild(list);
    }
    const records = Array.isArray(data.transactions) ? data.transactions : [];
    list.innerHTML = `<h4>最近账单</h4>${records.length ? records.slice(0, 8).map(item => {
      const coins = Number(item.coins || 0);
      return `<div class="wallet-record"><span>${escapeHtml(item.note || "账单")}</span><strong>${coins > 0 ? "+" : ""}${coins} 💰</strong><small>${timeAgo(item.created_at)}</small></div>`;
    }).join("") : '<p class="comment-empty">暂无账单记录</p>'}`;
  }
}
window.loadWallet = loadWallet;
window.markNotificationsRead = markNotificationsRead;
async function rechargeWallet(button) {
  const item = button.closest(".coin-item");
  const coins = Number($(".coin-diamond", item).textContent.replace(/\D/g, ""));
  const method = $(".pay-option.active")?.dataset.method || "wechat";
  setBusy(button, true, "支付处理中...");
  const data = unwrap(await API.recharge(coins, method));
  setBusy(button, false);
  if (!data) return;
  await handlePayResult(data, { type: "recharge", amount: coins });
}
function openUpgrade() { openModal("upgradeModal"); }
async function payVip(button) {
  const method = $(".pay-option.active")?.dataset.method || "wechat";
  setBusy(button, true, "支付处理中...");
  const data = unwrap(await API.vipPay(button.dataset.plan, method));
  setBusy(button, false);
  if (!data) return;
  await handlePayResult(data, { type: "vip", plan: button.dataset.plan });
}

/** 统一处理支付结果：本地直连成功 or 真实支付（二维码/跳转 + 轮询） */
async function handlePayResult(data, ctx) {
  // 本地模式：直接成功
  if (data.status === "success") {
    updateBalance(data.coins);
    if (ctx.type === "vip") {
      state.user.is_vip = true;
      state.user.vip_expire = data.expire;
      closeModal("upgradeModal");
      showToast(`会员开通成功，有效期至 ${data.expire}`);
    } else {
      await loadWallet();
      showToast(`充值成功：+${data.added} 钻石`);
    }
    return;
  }
  // 真实支付：展示二维码或跳转
  const pay = data.pay || {};
  if (!pay.enabled) {
    showToast("支付未配置，请联系管理员");
    return;
  }
  if (pay.code_url) {
    openPayModal(data.out_trade_no, pay.code_url, ctx);
  } else if (pay.pay_url) {
    window.open(pay.pay_url, "_blank");
    pollOrder(data.out_trade_no, ctx);
  }
}

function openPayModal(outTradeNo, codeUrl, ctx) {
  const modal = $("#payModal");
  const qr = $("#payQrCode");
  $("#payAmount").textContent = ctx.type === "vip" ? "会员开通" : `${ctx.amount} 钻石`;
  $("#payMethod").textContent = "微信支付";
  if (qr && window.QRCode) {
    qr.innerHTML = "";
    new QRCode(qr, { text: codeUrl, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
  } else if (qr) {
    qr.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(codeUrl)}" alt="支付二维码">`;
  }
  openModal("payModal");
  pollOrder(outTradeNo, ctx);
}

function pollOrder(outTradeNo, ctx, attempts = 0) {
  if (attempts > 60) {
    closeModal("payModal");
    showToast("支付超时，请重新发起");
    return;
  }
  setTimeout(async () => {
    const data = unwrap(await API.queryOrder(outTradeNo));
    if (!data) { pollOrder(outTradeNo, ctx, attempts + 1); return; }
    if (data.status === "success") {
      closeModal("payModal");
      updateBalance(data.coins);
      if (ctx.type === "vip") {
        state.user.is_vip = true;
        state.user.vip_expire = data.vip_expire;
        closeModal("upgradeModal");
        showToast("会员开通成功！");
      } else {
        await loadWallet();
        showToast("充值成功！");
      }
    } else {
      pollOrder(outTradeNo, ctx, attempts + 1);
    }
  }, 2000);
}

/* ---------- 搜索与个人主页 ---------- */
async function globalSearch() {
  const keyword = $("#globalSearchInput")?.value.trim();
  if (!keyword) return;
  const data = unwrap(await API.search(keyword));
  if (!data) return;
  const container = $("#searchSuggest");
  const section = (title, html) => `<div class="suggest-group search-result-group"><h5>${title}</h5>${html}</div>`;
  container.innerHTML = [
    section("用户", data.users.length ? data.users.map(user => `<button class="search-result" data-do="search-user" data-id="${user.id}"><img src="${escapeHtml(user.avatar)}" alt=""><span>${escapeHtml(user.nickname)}<small>${escapeHtml(user.bio || "")}</small></span><i class="fa-solid fa-message"></i></button>`).join("") : '<p class="comment-empty">无匹配用户</p>'),
    section("动态", data.posts.length ? data.posts.map(post => `<button class="search-result" data-do="open-post" data-id="${post.id}"><span>${escapeHtml(post.content)}<small>${escapeHtml(post.nickname)} · ${timeAgo(post.created_at)}</small></span></button>`).join("") : '<p class="comment-empty">无匹配动态</p>'),
    section("频道", data.circles.length ? data.circles.map(circle => `<button class="search-result" data-do="search-circle" data-id="${circle.id}"><span>${escapeHtml(circle.icon)} ${escapeHtml(circle.name)}</span></button>`).join("") : '<p class="comment-empty">无匹配频道</p>'),
    section("语音房", data.rooms.length ? data.rooms.map(room => `<button class="search-result" data-do="search-room" data-id="${room.id}"><span>${escapeHtml(room.topic)}</span><i class="fa-solid fa-arrow-right"></i></button>`).join("") : '<p class="comment-empty">无匹配语音房</p>'),
  ].join("");
}
async function loadProfile(userData = null) {
  const data = userData || unwrap(await API.profile(), false);
  if (!data) return;
  state.profile = data;

  // Avatar + banner
  const avatarEl = document.querySelector("#view-profile .profile-avatar img, #view-profile .profile-avatar");
  if (avatarEl) {
    if (avatarEl.tagName === "IMG") avatarEl.src = data.avatar;
    else avatarEl.style.backgroundImage = `url(${data.avatar})`;
  }

  // Nickname + ID
  const nameEl = document.querySelector("#view-profile .profile-name");
  if (nameEl) nameEl.textContent = data.nickname;

  const idTag = document.querySelector("#view-profile .profile-name-row .tag-sm, #view-profile .profile-name-row .user-id-tag");
  if (idTag) idTag.textContent = `ID: ${data.id}`;

  // VIP / 认证状态
  const vipEl = document.querySelector("#view-profile .vip-badge, #view-profile .verify-badge");
  if (vipEl) {
    if (data.is_realname) {
      vipEl.className = "verify-badge verified";
      vipEl.innerHTML = `<i class="fa-solid fa-circle-check"></i> 已实名认证`;
    } else if (data.is_vip) {
      vipEl.innerHTML = `<i class="fa-solid fa-crown"></i> 高级会员`;
    } else {
      vipEl.innerHTML = `<i class="fa-solid fa-user"></i> 未认证`;
    }
  }

  // Bio
  const bioEl = document.querySelector("#view-profile .profile-bio");
  if (bioEl) bioEl.textContent = data.bio || "还没有填写个人简介";

  // Stats: 关注 / 粉丝 / 获赞 / 金币 / 钻石
  const stats = document.querySelectorAll("#view-profile .profile-stats-bar .stat-item");
  const values = [
    data.following_count, data.followers_count, data.likes_count,
    data.coins, data.diamonds,
  ];
  stats.forEach((el, idx) => {
    const numEl = el.querySelector("strong, .stat-value");
    if (numEl && values[idx] !== undefined) numEl.textContent = formatNumber(values[idx]);
  });

  // Post count in content area
  const postsContainer = document.querySelector("#view-profile .profile-content-area .feed-column, #view-profile .feed-column");
  if (postsContainer && data.posts) {
    postsContainer.innerHTML = data.posts.length
      ? data.posts.map(p => postCard({ ...p, nickname: data.nickname, avatar: data.avatar })).join("")
      : empty("你还没有发布动态，去发现广场逛逛吧");
  }
}
async function editProfile() {
  const nickname = prompt("昵称", state.user.nickname);
  if (!nickname) return;
  const bio = prompt("个人简介", state.user.bio || "");
  const data = unwrap(await API.updateProfile({ nickname: nickname.trim(), bio: bio || "" }));
  if (!data) return;
  setUser(data);
  updateUserUI(data);
  await loadProfile();
  showToast("个人资料已保存");
}
function openEditProfileModal() {
  const user = state.user || {};
  $("#editNickname").value = user.nickname || "";
  $("#editBio").value = user.bio || "";
  $("#editGender").value = user.gender || "保密";
  $("#editAge").value = user.age || "";
  $("#editLocation").value = user.location || "";
  const preview = $("#editAvatarImg");
  if (preview && user.avatar) preview.src = user.avatar;
  openModal("modal-edit-profile");
}
async function saveProfileModal() {
  const nickname = $("#editNickname").value.trim();
  if (!nickname) return showToast("昵称不能为空");
  const ageValue = Number($("#editAge").value);
  const payload = {
    nickname,
    bio: $("#editBio").value.trim(),
    gender: $("#editGender").value,
    location: $("#editLocation").value.trim(),
  };
  if (ageValue >= 18) payload.age = ageValue;
  const button = $("#editProfileSaveBtn");
  button.disabled = true;
  const data = unwrap(await API.updateProfile(payload));
  button.disabled = false;
  if (!data) return;
  setUser(data);
  updateUserUI(data);
  closeModal("modal-edit-profile");
  await loadProfile();
  showToast("个人资料已保存");
}
function navigateTo(target) {
  if (target === "followings" || target === "followers") {
    switchView("relationships");
    showToast(target === "followings" ? "已进入我的关系，可查看已建立的关系" : "粉丝列表整理中，可在发现页关注更多用户");
    return;
  }
  switchView(target);
}
async function editAvatar() {
  const url = prompt("请输入新头像图片 URL", state.user.avatar);
  if (!url) return;
  const data = unwrap(await API.updateProfile({ avatar: url.trim() }));
  if (!data) return;
  setUser(data);
  updateUserUI(data);
  const preview = $("#editAvatarImg");
  if (preview) preview.src = data.avatar || url.trim();
  await loadProfile();
  showToast("头像已更新");
}
function handleProfileTab(tab) {
  $$(".profile-tabs .ptab").forEach(item => item.classList.remove("active"));
  tab.classList.add("active");
  const type = tab.dataset.ptab;
  if (type === "voice") { switchView("voice"); showToast("这里可以查看并创建你的语音房"); }
  else if (type === "audio") {
    const container = $("#view-profile .profile-col .feed-column");
    const audioPosts = (state.profile?.posts || []).filter(post => /\.(mp3|wav|m4a|aac)/i.test(post.image || ""));
    container.innerHTML = audioPosts.length ? audioPosts.map(post => postCard({ ...post, nickname: state.user.nickname, avatar: state.user.avatar })).join("") : empty("还没有音频动态");
  } else if (type === "achievement") $(".badge-grid")?.scrollIntoView({ behavior: "smooth", block: "center" });
  else if (type === "reward") openModal("walletModal");
  else loadProfile();
}

/* ---------- 实时事件 ---------- */
async function bindRealtime() {
  API.ws.on("connection", ({ connected }) => {
    if (connected && state.currentRoom) {
      API.ws.send("room.join", { room_id: state.currentRoom.id });
      API.ws.send("room.mic", { room_id: state.currentRoom.id, enabled: Boolean(state.roomMicStream) });
    }
    if (!connected) cleanupRoomPeers();
  });
  API.ws.on("chat.message", message => {
    const incoming = message.sender_id !== state.user?.id;
    const otherId = incoming ? message.sender_id : message.peer_id;
    if (state.currentPeer === otherId) {
      if (state.chatLoadingPeer === otherId) state.chatPendingMessages.push(message);
      else appendChatMessage(message);
    } else if (incoming) showToast(`${message.nickname} 发来一条新消息`);
    if (incoming) {
      playMessageSound();
      showPushNotification(`${message.nickname} 发来一条新消息`, message.msg_type === "text" ? message.content : "你收到一条新的媒体消息");
    }
    debounceConversations();
  });
  API.ws.on("chat.read", data => {
    if (state.currentPeer === data.peer_id) $$("#chatBody .msg.sent .msg-time").forEach(element => { element.textContent = element.textContent.replace("已送达", "已读"); });
  });
  API.ws.on("typing", data => {
    if (data.user_id !== state.currentPeer) return;
    $(".chat-user-sub").textContent = data.typing ? "正在输入..." : (state.peerInfo?.online ? "在线" : "离线");
  });
  API.ws.on("room.message", appendRoomMessage);
  API.ws.on("room.gift", message => {
    appendRoomMessage(message);
    showGiftBarrage(message);
    if (message.user_id !== state.user?.id) vibrateForRoom();
  });
  API.ws.on("room.roster", syncRoomRoster);
  API.ws.on("room.signal", onRoomSignal);
  API.ws.on("room.presence", data => {
    if (state.currentRoom?.id !== data.room_id) return;
    state.currentRoom.online = data.online;
    $("#roomOnline") && ($("#roomOnline").textContent = data.online);
    $(".chat-count") && ($(".chat-count").textContent = data.online);
  });
  API.ws.on("room.action", data => {
    if (data.user.id !== state.user?.id && state.currentRoom?.id === data.room_id) {
      showToast(`${data.user.nickname} ${{ mic: "切换了麦克风", hand: "举起了手", invite: "邀请了朋友" }[data.action]}`);
      vibrateForRoom();
    }
  });
  API.ws.on("notification", async item => {
    const content = item.content || "你有一条新通知";
    showToast(content);
    showPushNotification("圈圈语音社", content);
    await loadNotifications();
  });
  API.ws.on("match.success", data => { showMatchSuccess(data.user); loadMatchList(); });
  API.ws.on("wallet.update", data => updateBalance(data.coins));
  API.ws.on("presence", data => {
    const item = state.conversations.find(conversation => conversation.peer_id === data.user_id);
    if (item) item.online = data.online;
    if (state.currentPeer === data.user_id && state.peerInfo) {
      state.peerInfo.online = data.online;
      $(".chat-user-sub").textContent = data.online ? "在线" : "离线";
    }
    renderConversations();
  });
  API.ws.on("feed.new", post => {
    if (post.user_id !== state.user?.id && state.feedTab === "recommend") {
      state.feedItems.unshift(post);
      renderPosts(state.feedItems.slice(0, 30));
    }
  });
  API.ws.on("voice.new", room => {
    if (!state.rooms.some(item => item.id === room.id)) {
      state.rooms.unshift(room);
      renderVoiceRooms(state.rooms);
    }
  });
  API.ws.on("relationship.bound", data => {
    const meta = { confidant: "🌸知己", bro: "🤝兄弟", couple: "💏情侣", bestie: "👯闺蜜" }[data.rel_type] || "💞新关系";
    showToast(`🎉 ${meta} 绑定成功！已解锁专属称号`);
    showPushNotification("新关系绑定", `你和好友成为了${meta}！`);
  });
  API.ws.on("call.invite", incomingCall);
  API.ws.on("call.accept", onCallAccepted);
  API.ws.on("call.reject", () => { showToast("对方已拒绝通话"); cleanupCall(); });
  API.ws.on("call.end", () => { showToast("对方已结束通话"); cleanupCall(); });
  API.ws.on("call.signal", onCallSignal);
  API.ws.on("call.mode", data => {
    if (state.call?.peerId === data.from_user.id && data.mode === "voice") setCallMode("voice");
  });
  API.ws.on("error", data => showToast(data.message || "实时消息处理失败"));
}

/* ---------- WebRTC 语音/视频通话 ---------- */
async function startCall(type) {
  if (!state.currentPeer || !state.peerInfo) return showToast("请先选择通话对象");
  if (state.peerInfo.blocked) return showToast("请先解除屏蔽再发起通话");
  if (state.call) return showToast("已有通话正在进行");
  if (!API.connected) return showToast("实时连接尚未建立，请稍后重试");
  const prepared = await prepareCall(state.currentPeer, type, true);
  if (!prepared) return;
  API.ws.send("call.invite", { target_id: state.currentPeer, call_type: type });
  showToast(`正在等待 ${state.peerInfo.nickname} 接听...`);
}
async function prepareCall(peerId, type, caller, remoteUser = null) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === "video" });
    const peerConnection = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    state.call = { peerId, type, caller, stream, peerConnection, remoteUser: remoteUser || state.peerInfo, remoteStream: null, iceQueue: [] };
    stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));
    peerConnection.onicecandidate = event => {
      if (event.candidate) API.ws.send("call.signal", { target_id: peerId, kind: "ice", candidate: event.candidate });
    };
    peerConnection.ontrack = event => {
      if (!state.call) return;
      state.call.remoteStream = event.streams[0] || new MediaStream([event.track]);
      attachRemoteMedia(state.call.remoteStream);
    };
    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === "connected") startCallTimer();
      if (["failed", "disconnected"].includes(peerConnection.connectionState)) showToast("通话连接不稳定");
    };
    showCallInterface(type, state.call.remoteUser);
    attachLocalMedia(stream, type);
    return true;
  } catch (error) {
    console.error(error);
    showToast("无法发起通话，请允许麦克风和摄像头权限");
    cleanupCall();
    return false;
  }
}
function showCallInterface(type, peer) {
  openModal("callModal");
  $("#callInvite").style.display = "none";
  $(".call-remote-name").textContent = peer?.nickname || "对方";
  $(".call-remote-avatar").innerHTML = `<img src="${escapeHtml(peer?.avatar || state.user.avatar)}" alt="">`;
  $("#callTimer").textContent = "00:00";
  $("#callVideoToggle").style.display = type === "video" ? "flex" : "none";
  $("#callVoiceSwitch").style.display = type === "video" ? "flex" : "none";
}
function attachLocalMedia(stream, type) {
  const local = $(".call-local");
  local.innerHTML = type === "video" ? '<video autoplay playsinline muted></video>' : '<i class="fa-solid fa-microphone"></i>';
  const video = $("video", local);
  if (video) video.srcObject = stream;
}
function attachRemoteMedia(stream) {
  const remote = $(".call-remote-avatar");
  const isVideo = state.call?.type === "video";
  remote.innerHTML = isVideo ? '<video autoplay playsinline></video>' : '<audio autoplay></audio>';
  const media = $(isVideo ? "video" : "audio", remote);
  media.srcObject = stream;
}
async function incomingCall(data) {
  if (state.call) {
    API.ws.send("call.reject", { target_id: data.from_user.id, reason: "busy" });
    return;
  }
  state.incomingCall = data;
  openModal("callModal");
  $("#callInvite").style.display = "flex";
  $("#callInvite .invite-avatar img").src = data.from_user.avatar;
  $("#callInvite .invite-text strong").textContent = data.from_user.nickname;
  $("#callInviteType").textContent = data.call_type === "video" ? "视频" : "语音";
}
async function acceptCall() {
  const incoming = state.incomingCall;
  if (!incoming) return;
  state.incomingCall = null;
  const prepared = await prepareCall(incoming.from_user.id, incoming.call_type, false, incoming.from_user);
  if (prepared) API.ws.send("call.accept", { target_id: incoming.from_user.id });
}
function rejectCall() {
  const incoming = state.incomingCall;
  if (incoming) API.ws.send("call.reject", { target_id: incoming.from_user.id });
  state.incomingCall = null;
  cleanupCall();
}
async function onCallAccepted(data) {
  if (!state.call || !state.call.caller) return;
  const offer = await state.call.peerConnection.createOffer();
  await state.call.peerConnection.setLocalDescription(offer);
  API.ws.send("call.signal", { target_id: state.call.peerId, kind: "description", description: state.call.peerConnection.localDescription });
}
async function onCallSignal(data) {
  const call = state.call;
  if (!call || data.from_user.id !== call.peerId) return;
  try {
    if (data.kind === "ice") {
      if (call.peerConnection.remoteDescription) await call.peerConnection.addIceCandidate(data.candidate);
      else call.iceQueue.push(data.candidate);
    } else if (data.kind === "description") {
      await call.peerConnection.setRemoteDescription(data.description);
      if (data.description.type === "offer") {
        const answer = await call.peerConnection.createAnswer();
        await call.peerConnection.setLocalDescription(answer);
        API.ws.send("call.signal", { target_id: call.peerId, kind: "description", description: call.peerConnection.localDescription });
      }
      while (call.iceQueue.length) await call.peerConnection.addIceCandidate(call.iceQueue.shift());
    }
  } catch (error) { console.error("WebRTC 信令处理失败", error); }
}
function startCallTimer() {
  if (state.callTimer) return;
  const started = Date.now();
  state.callTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    $("#callTimer").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }, 1000);
}
function toggleCallAudio() {
  const tracks = state.call?.stream.getAudioTracks() || [];
  tracks.forEach(track => { track.enabled = !track.enabled; });
  $("#callMicToggle")?.classList.toggle("off", tracks.some(track => !track.enabled));
}
function toggleCallVideo() {
  const tracks = state.call?.stream.getVideoTracks() || [];
  tracks.forEach(track => { track.enabled = !track.enabled; });
  $("#callVideoToggle")?.classList.toggle("off", tracks.some(track => !track.enabled));
}
function toggleCallSpeaker() {
  const media = $(".call-remote-avatar audio, .call-remote-avatar video");
  if (!media) return showToast("远端媒体尚未连接");
  media.muted = !media.muted;
  $("#callSpeakerToggle").classList.toggle("off", media.muted);
  $("#callSpeakerToggle").title = media.muted ? "打开扬声器" : "关闭扬声器";
  showToast(media.muted ? "扬声器已静音" : "扬声器已打开");
}
function switchCallToVoice() {
  if (!state.call || state.call.type !== "video") return;
  API.ws.send("call.mode", { target_id: state.call.peerId, mode: "voice" });
  setCallMode("voice");
  showToast("已切换为语音通话");
}
function setCallMode(mode) {
  if (!state.call) return;
  state.call.type = mode;
  if (mode === "voice") state.call.stream.getVideoTracks().forEach(track => { track.enabled = false; });
  attachLocalMedia(state.call.stream, mode);
  if (state.call.remoteStream) attachRemoteMedia(state.call.remoteStream);
  $("#callVideoToggle").style.display = mode === "video" ? "flex" : "none";
  $("#callVoiceSwitch").style.display = mode === "video" ? "flex" : "none";
}
function endCall() {
  if (state.call) API.ws.send("call.end", { target_id: state.call.peerId });
  cleanupCall();
}
function cleanupCall() {
  clearInterval(state.callTimer);
  state.callTimer = null;
  if (state.call) {
    state.call.peerConnection.close();
    state.call.stream.getTracks().forEach(track => track.stop());
    state.call.remoteStream?.getTracks().forEach(track => track.stop());
  }
  state.call = null;
  state.incomingCall = null;
  $("#callSpeakerToggle")?.classList.remove("off");
  closeModal("callModal");
  $("#callInvite") && ($("#callInvite").style.display = "none");
}

/* ---------- 设置、Emoji、工具 ---------- */
function updateChatBlockState() {
  const blocked = Boolean(state.peerInfo?.blocked);
  const input = $("#chatInput");
  if (input) {
    input.disabled = blocked;
    input.placeholder = blocked ? "已屏蔽该联系人，解除屏蔽后可继续聊天" : "输入消息，Enter 发送...";
  }
  ["#chatSendBtn", ".chat-input-bar .attach-btn", "#voiceToggleBtn", '[data-action="call"]'].forEach(selector => {
    $$(selector).forEach(button => { button.disabled = blocked; });
  });
}
function showInfoModal(title, content) {
  $("#infoModalTitle").textContent = title;
  $("#infoModalBody").innerHTML = content;
  openModal("infoModal");
}
async function showBlockedUsers() {
  const users = unwrap(await API.blocks());
  if (!users) return;
  showInfoModal("黑名单", users.length ? `<div class="block-list">${users.map(user => `<div class="block-row"><img src="${escapeHtml(user.avatar)}" alt=""><div><strong>${escapeHtml(user.nickname)}</strong><small>ID：${user.id} · ${escapeHtml(user.location || "未知地区")}</small></div><button class="btn-sm primary" data-do="unblock" data-id="${user.id}">移出</button></div>`).join("")}</div>` : '<p class="comment-empty">黑名单为空。可在私聊右上角“更多”中添加联系人。</p>');
}
async function unblockUser(userId) {
  const result = unwrap(await API.toggleBlock(userId));
  if (!result) return;
  if (state.currentPeer === userId && state.peerInfo) {
    state.peerInfo.blocked = false;
    updateChatBlockState();
  }
  showToast("已移出黑名单");
  await showBlockedUsers();
}
async function handleSettingLink(link) {
  const text = link.textContent.replace(/\s+/g, " ");
  closeModal("settingsDrawer");
  if (text.includes("账号与隐私")) {
    switchView("profile");
    await editProfile();
  } else if (text.includes("账号安全")) {
    showInfoModal("账号安全", `<div class="account-security"><p><strong>登录手机号</strong>${escapeHtml(state.user.phone || "未绑定")}</p><p><strong>用户 ID</strong>${state.user.id}</p><p><strong>会话有效期</strong>登录后 72 小时</p><p class="comment-empty">为保障账号安全，请勿将验证码泄露给他人。可在设置页底部“退出登录”结束当前会话。</p></div>`);
  } else if (text.includes("黑名单")) {
    await showBlockedUsers();
  } else if (text.includes("位置权限")) {
    await updateLocation();
  } else if (text.includes("语言")) {
    showInfoModal("语言", "<p>当前已完整适配简体中文，其他语言将在后续版本支持。</p>");
  } else if (text.includes("关于圈圈")) {
    const health = unwrap(await API.health());
    if (health) showInfoModal("关于圈圈语音社", `<p><strong>版本</strong>v2.3.0</p><p><strong>服务状态</strong>${escapeHtml(health.status)}</p><p><strong>数据库</strong>${escapeHtml(health.database)}</p><p><strong>在线用户</strong>${health.online_users}</p><p class="comment-empty">检测时间：${escapeHtml(health.time)}</p>`);
  }
}
function initEmoji() {
  const groups = [
    "😀 😂 🤣 😊 😍 🥰 😘 😎 🤩 🥳 😭 😢 😤 😡 🤔 😴",
    "❤️ 💕 💔 💖 💝 💘 💗 💓 💞",
    "🔥 ✨ 🎉 🎊 🌈 🌟 ⭐ 💫 ⚡ 💥",
    "👍 👎 👏 🙏 💪 🤝 👀 💯",
    "💎 👑 🏆 🎖️ 💰 💳 🎮",
    "🎵 🎧 📷 🎬 📚 🎨",
    "🎂 🍕 🍔 🍜 🍰 ☕ 🍺 🍷 🥂",
    "🐶 🐱 🐼 🦊 🐰 🐻 🐨 🐯 🦁 🐸 🐵 🐷 🐮 🐔 🐧 🦄",
  ];
  const render = index => {
    $("#emojiGrid").innerHTML = groups[index].split(" ").map(emoji => `<span>${emoji}</span>`).join("");
    $$("#emojiGrid span").forEach(span => span.addEventListener("click", () => {
      $("#chatInput").value += span.textContent;
      $("#chatInput").focus();
      $("#emojiPanel").classList.remove("active");
    }));
  };
  $$(".emoji-cats .ecat").forEach((category, index) => category.addEventListener("click", () => {
    $$(".emoji-cats .ecat").forEach(item => item.classList.toggle("active", item === category));
    render(index);
  }));
  render(0);
  $("#emojiBtn")?.addEventListener("click", event => { event.stopPropagation(); $("#emojiPanel").classList.toggle("active"); });
  document.addEventListener("click", event => { if (!event.target.closest("#emojiPanel, #emojiBtn")) $("#emojiPanel")?.classList.remove("active"); });
}
function settingEnabled(name, fallback = false) {
  const value = localStorage.getItem(`switch_${name}`);
  return value === null ? fallback : value === "1";
}
let messageAudioContext;
function playMessageSound() {
  if (!settingEnabled("消息声音", true)) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    messageAudioContext ||= new AudioContextClass();
    if (messageAudioContext.state === "suspended") messageAudioContext.resume();
    const now = messageAudioContext.currentTime;
    const oscillator = messageAudioContext.createOscillator();
    const gain = messageAudioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(660, now);
    oscillator.frequency.setValueAtTime(880, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    oscillator.connect(gain).connect(messageAudioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.21);
  } catch (error) {
    console.warn("消息提示音播放失败", error);
  }
}
function showPushNotification(title, content) {
  if (!settingEnabled("推送通知", true) || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const notification = new Notification(title, { body: String(content || ""), tag: "circle-voice" });
    notification.onclick = () => { window.focus(); notification.close(); };
  } catch (error) {
    console.warn("系统通知发送失败", error);
  }
}
function vibrateForRoom() {
  if (settingEnabled("语音房震动") && navigator.vibrate) navigator.vibrate(50);
}
async function initSettings() {
  const settings = JSON.parse(localStorage.getItem("cv_settings") || "{}");
  setTheme(settings.theme || "dark", false);
  if (settings.accent) document.documentElement.style.setProperty("--accent", settings.accent);
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    const current = JSON.parse(localStorage.getItem("cv_settings") || "{}");
    if (current.theme === "system") setTheme("system", false);
  });
  document.addEventListener("pointerdown", () => {
    if (!settingEnabled("消息声音", true)) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    messageAudioContext ||= new AudioContextClass();
    if (messageAudioContext.state === "suspended") messageAudioContext.resume();
  }, { once: true });
  $$(".cp").forEach(dot => dot.addEventListener("click", () => {
    $$(".cp").forEach(item => item.classList.remove("active"));
    dot.classList.add("active");
    const color = getComputedStyle(dot).getPropertyValue("--c").trim();
    document.documentElement.style.setProperty("--accent", color);
    saveSettings({ accent: color });
  }));
  $$("#settingsDrawer .setting-row.switch input").forEach(input => {
    const name = $("span", input.closest(".setting-row"))?.textContent.trim();
    const key = `switch_${name}`;
    input.checked = localStorage.getItem(key) === null ? input.checked : localStorage.getItem(key) === "1";
    input.closest(".toggle").classList.toggle("on", input.checked);
    input.addEventListener("change", async () => {
      if (name === "推送通知" && input.checked) {
        if (!("Notification" in window)) {
          input.checked = false;
          showToast("当前浏览器不支持系统通知");
        } else {
          const permission = await Notification.requestPermission();
          if (permission !== "granted") {
            input.checked = false;
            showToast("未获得系统通知权限");
          }
        }
      }
      input.closest(".toggle").classList.toggle("on", input.checked);
      localStorage.setItem(key, input.checked ? "1" : "0");
      if (input.checked && name === "消息声音") playMessageSound();
      if (input.checked && name === "语音房震动" && navigator.vibrate) navigator.vibrate(30);
    });
  });
  $$("#settingsDrawer .setting-group:first-child .seg-btn").forEach(button => button.addEventListener("click", () => setTheme(button.textContent)));
  $$(".setting-link:not(.danger)").forEach(link => link.addEventListener("click", event => {
    event.preventDefault();
    handleSettingLink(link);
  }));
}
function saveSettings(patch) {
  const settings = JSON.parse(localStorage.getItem("cv_settings") || "{}");
  localStorage.setItem("cv_settings", JSON.stringify({ ...settings, ...patch }));
}
function setTheme(mode, persist = true) {
  const names = { "浅色": "light", "深色": "dark", "跟随系统": "system" };
  const theme = names[mode] || mode || "dark";
  const light = theme === "light" || (theme === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  document.body.classList.toggle("light-theme", light);
  $('meta[name="theme-color"]')?.setAttribute("content", light ? "#f7f7fb" : "#0d0b1a");
  $$("#settingsDrawer .setting-group:first-child .seg-btn").forEach(button => {
    button.classList.toggle("active", names[button.textContent.trim()] === theme);
  });
  if (persist) saveSettings({ theme });
}
function toggleTheme() { setTheme(document.body.classList.contains("light-theme") ? "深色" : "浅色"); }
async function updateLocation() {
  if (!navigator.geolocation) return showToast("当前浏览器不支持定位");
  navigator.geolocation.getCurrentPosition(async position => {
    const data = unwrap(await API.updateProfile({ lat: position.coords.latitude, lng: position.coords.longitude }));
    if (data) { setUser(data); showToast("位置坐标已更新"); loadNearby(); }
  }, () => showToast("未获得位置权限"));
}
function initSliders() {
  $$(".slider").forEach(slider => {
    const update = () => {
      const percent = ((Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min))) * 100;
      slider.style.backgroundSize = `${percent}% 100%`;
    };
    update();
    slider.addEventListener("input", update);
  });
}
function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

/* ============================================================
   ======== 商城 · 好感度 · 关系 · 称号 新功能 ============
   ============================================================ */

// 新 state 字段
const relMetaMap = {
  couple:    { name: "情侣", icon: "💏", color: "#ec4899", req: 100 },
  bestie:    { name: "闺蜜", icon: "👯", color: "#f472b6", req: 80 },
  bro:       { name: "兄弟", icon: "🤝", color: "#60a5fa", req: 80 },
  confidant: { name: "知己", icon: "🌸", color: "#a78bfa", req: 60 },
};

/* ---------------- 商城 ---------------- */
let shopCache = [];
let shopActiveCat = "gift";
let shopInventoryCache = { items: [], titles: [] };

async function openShop() {
  state.shopCoins = state.user?.coins || 0;
  state.shopCat = state.shopCat || "gift";
  openModal("shopModal");
  await loadShop();
  await loadInventory();
  bindShopInteractions();
}

async function loadShop() {
  const data = unwrap(await API.shop(shopActiveCat === "gift" ? "gift" : shopActiveCat === "title" ? "title" : shopActiveCat === "avatar_frame" ? "avatar_frame" : shopActiveCat === "effect" ? "effect" : ""), false) || [];
  shopCache = data;
  const coins = state.user?.coins ?? (await unwrap(await API.wallet(), false))?.coins ?? 0;
  $("#shopCoins").textContent = coins;
  renderShop();
}

async function renderShop() {
  const grid = $("#shopGrid");
  if (!grid) return;
  if (!shopCache.length) {
    grid.innerHTML = empty("暂无可购买物品");
    return;
  }
  grid.innerHTML = shopCache.map(item => {
    const emoji = item.icon || "🎁";
    const price = item.price;
    const owned = item.owned;
    const favBoost = item.favorability_boost;
    const favNote = item.category === "gift" ? '<span style="color:#f97316">+' + favBoost + ' 好感</span>' : "";
    const freeTitle = item.price === 0 && item.category === "title" ? '<div class="shop-free">自动解锁</div>' : "";
    const priceHtml = price === 0
      ? '<div class="shop-price shop-free">' + (item.unlock_favorability ? '需 ' + item.unlock_favorability + ' 好感' : "免费") + '</div>'
      : '<div class="shop-price">💎 ' + price + '</div>';
    const favBoostHtml = favNote ? '<div style="font-size:10px;color:var(--text-mute);margin-top:3px">' + favBoost + ' 好感</div>' : "";
    return `<div class="shop-item" data-item-key="${item.item_key}" data-owned="${owned}">
      ${owned ? '<span class="shop-owned-tag">已拥有</span>' : ''}
      <div class="shop-emoji">${emoji}</div>
      <div class="shop-name">${escapeHtml(item.name)}</div>
      ${priceHtml}
      ${favBoostHtml}
      ${freeTitle}
    </div>`;
  }).join("");
  $$("#shopGrid .shop-item").forEach(card => card.addEventListener("click", async () => {
    const key = card.dataset.itemKey;
    const owned = card.dataset.owned === "true";
    const item = shopCache.find(i => i.item_key === key);
    if (!item) return;
    if (owned) {
      // 已拥有：如果是称号则切换启用/停用
      if (item.category === "title" || item.category === "avatar_frame") {
        const r = unwrap(await API.redeem(key));
        showToast(r?.is_active ? `已启用「${item.name}」` : `已停用「${item.name}」`);
        await loadInventory();
      } else {
        showToast("你已拥有该物品");
      }
      return;
    }
    if (item.price > (state.user?.coins || 0)) {
      showToast("钻石余额不足，请先充值");
      openModal("walletModal");
      return;
    }
    const r = unwrap(await API.purchase(key));
    if (r) {
      state.user.coins = r.coins;
      updateBalance(r.coins);
      showToast(`🎉 成功购买「${item.name}」`);
      await loadShop();
      await loadInventory();
    }
  }));
}

async function loadInventory() {
  const data = unwrap(await API.inventory(), false) || { items: [], titles: [] };
  shopInventoryCache = data;
  const inv = $("#shopInventory");
  if (!inv) return;
  const entries = [
    ...data.titles.map(t => ({ ...t, label: "称号", ico: t.icon, name: t.name, is_active: t.is_active, item_key: t.item_key })),
    ...data.items.filter(i => i.category !== "title").map(i => ({ ...i, label: i.category === "avatar_frame" ? "头像框" : i.category === "effect" ? "特效" : "礼物", ico: i.icon, name: i.name, is_active: i.is_active, item_key: i.item_key })),
  ];
  if (!entries.length) { inv.innerHTML = empty("背包空空如也，去商城看看吧～"); return; }
  inv.innerHTML = entries.map(it => `<div class="inv-item ${it.is_active ? "active" : ""}">
    <div class="inv-ico">${it.ico || "🎁"}</div>
    <div class="inv-info"><div class="inv-name">${escapeHtml(it.name)}</div><div class="inv-cat">${it.label}</div></div>
    <button class="btn-ghost tiny" data-inv-key="${it.item_key}" data-inv-active="${it.is_active}">${it.is_active ? "停用" : "启用"}</button>
  </div>`).join("");
  $$("#shopInventory [data-inv-key]").forEach(btn => btn.addEventListener("click", async () => {
    const r = unwrap(await API.redeem(btn.dataset.invKey));
    showToast(r?.is_active ? "已启用" : "已停用");
    await loadInventory();
    await loadShop();
  }));
}

function bindShopInteractions() {
  $$(".scat").forEach(btn => btn.addEventListener("click", () => {
    $$(".scat").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    shopActiveCat = btn.dataset.shopCat;
    loadShop();
  }));
  $("#toggleInventoryBtn")?.addEventListener("click", () => {
    $("#shopInventory")?.classList.toggle("hidden");
  });
}

/* ---------------- 好感度 ---------------- */
async function loadFavorites() {
  await API.relTypes().then(r => { state.relMeta = r.data || relMetaMap; }).catch(() => {});
  const rows = unwrap(await API.favorites(), false) || [];
  const rels = unwrap(await API.relationships(), false) || [];
  renderFavorites(rows, rels);
}

function renderFavorites(rows, rels) {
  $("#favRelCount") && ($("#favRelCount").textContent = rels.length);
  $("#favGiftsCount") && ($("#favGiftsCount").textContent = rows.reduce((s, r) => s + (r.gifts_sent || 0), 0));
  $("#favChatDays") && ($("#favChatDays").textContent = rows.filter(r => (r.mutual || 0) >= 20).length);

  const list = $("#favList");
  if (!list) return;
  if (!rows.length) { list.innerHTML = empty("还没有亲密好友，快去送礼聊天建立羁绊吧～"); return; }
  // 按 mutual 降序
  rows.sort((a, b) => (b.mutual || 0) - (a.mutual || 0));

  const maxMutual = Math.max(100, ...rows.map(r => r.mutual || 0));
  list.innerHTML = rows.map(r => {
    const pct = Math.min(100, Math.round((r.mutual || 0) / maxMutual * 100));
    const relBadges = (r.relationships || []).map(t => {
      const meta = state.relMeta?.[t] || relMetaMap[t];
      return `<span class="fav-rel-badge ${t}">${meta?.icon || "💞"} ${meta?.name || t}</span>`;
    }).join("");
    const nextRel = r.next_rel;
    const badgesHtml = relBadges ? '<div class="fav-rel-badges">' + relBadges + '</div>' : "";
    const nextHtml = nextRel
      ? '<div class="fav-bar-row" style="margin-top:8px"><label>下一阶</label><div class="fav-bar"><div class="fav-fill" style="background:linear-gradient(90deg,#f97316,#ef4444);width:' + nextRel.progress + '%"></div></div><strong>' + (nextRel.type === "couple" ? "💏" : nextRel.type === "bro" ? "🤝" : "🌸") + ' ' + nextRel.delta + '</strong></div>'
      : '<div style="font-size:11px;color:var(--text-mute);margin-top:6px">已达成所有关系等级 ✨</div>';
    return `<div class="fav-card" data-fav-peer="${r.to_user_id}">
      <div class="fav-head">
        <div class="avatar"><img src="${r.avatar}" onerror="this.src='/api/avatars/0.svg'"></div>
        <div class="fav-info"><h4>${escapeHtml(r.nickname)}</h4>
          <div class="fav-nick">双向好感 ${r.mutual || 0}</div>
          ${badgesHtml}
        </div>
      </div>
      <div class="fav-bar-row"><label>你→TA</label><div class="fav-bar"><div class="fav-fill" style="width:${Math.min(100, r.value / Math.max(1, (r.next_rel?.required || 100)) * 100)}%"></div></div><strong>${r.value || 0}</strong></div>
      <div class="fav-bar-row"><label>TA→你</label><div class="fav-bar"><div class="fav-fill" style="width:${Math.min(100, (r.reverse || 0) / Math.max(1, (r.next_rel?.required || 100)) * 100)}%"></div></div><strong>${r.reverse || 0}</strong></div>
      ${nextHtml}
    </div>`;
  }).join("");
  $$("#favList .fav-card").forEach(card => card.addEventListener("click", () => openFavDetail(+card.dataset.favPeer)));
}

async function openFavDetail(peerId) {
  const data = unwrap(await API.favorite(peerId), false);
  const peer = unwrap(await API.getUser(peerId), false);
  if (!data || !peer) return;
  state.favDetail = { ...data, peer };
  openModal("favDetailModal");
  const mutual = data.mutual || 0;
  const fromVal = data.from_me?.value || 0;
  const toVal = data.to_me?.value || 0;
  const reqMap = { couple: 100, bestie: 80, bro: 80, confidant: 60 };
  const maxReq = Math.max(100, ...Object.values(reqMap));
  $("#favDetailImg").src = peer.avatar || "/api/avatars/0.svg";
  $("#favDetailImg").onerror = () => ($("#favDetailImg").src = "/api/avatars/0.svg");
  $("#favDetailName").textContent = peer.nickname;
  $("#favFromVal").textContent = fromVal;
  $("#favToVal").textContent = toVal;
  $("#favMutualVal").textContent = mutual;
  $("#favFromFill").style.width = `${Math.min(100, fromVal / maxReq * 100)}%`;
  $("#favToFill").style.width = `${Math.min(100, toVal / maxReq * 100)}%`;
  const activeRels = (data.relationships || []).map(r => relMetaMap[r]).filter(Boolean);
  $("#favDetailTags").innerHTML = activeRels.map(m => `<span class="fav-rel-badge ${Object.keys(relMetaMap).find(k => relMetaMap[k] === m)}-badge" style="background:${m.color}22;color:${m.color}">${m.icon} ${m.name}</span>`).join("") || '<span style="color:var(--text-mute);font-size:12px">尚未建立关系</span>';

  const history = data.gifts_sent || 0;
  $("#favHistory").innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap">
    <div>📦 互送礼物 <strong>${history}</strong></div>
    <div>💬 聊天天数 <strong>${data.chat_days || 0}</strong></div>
    <div>🎤 语音房 <strong>${data.voice_days || 0}</strong></div>
  </div>`;

  // 绑定按钮事件
  $("#favDetailChatBtn").onclick = () => { closeModal("favDetailModal"); openChat(peerId); };
  $("#favDetailGiftBtn").onclick = () => { closeModal("favDetailModal"); $("#giftPanel")?.classList.add("active"); };
  $("#favDetailBindBtn").onclick = () => openRelConfirm(peerId);
}

/* ---------------- 关系 ---------------- */
async function loadRelationships() {
  await API.relTypes().then(r => { state.relMeta = r.data || relMetaMap; }).catch(() => {});
  const rels = unwrap(await API.relationships(), false) || [];
  await loadFavorites();  // 同时刷新好感度页（共用后端数据）
  renderRelationships(rels);
}

async function renderRelationships(rels) {
  // 关系类型总览
  const grid = $("#relTypeGrid");
  if (grid) {
    grid.innerHTML = Object.entries(state.relMeta || relMetaMap).map(([key, meta]) => {
      const active = rels.some(r => r.rel_type === key);
      const styleHtml = active ? 'border-color:' + meta.color + ';background:' + meta.color + '15' : "";
      const activeHtml = active ? '<div style="font-size:11px;color:' + meta.color + ';margin-top:4px">✓ 已建立</div>' : "";
      return `<div class="rel-type-card" style="${styleHtml}">
        <div class="rel-icon">${meta.icon}</div>
        <div class="rel-name">${meta.name}</div>
        <div class="rel-req">需要双向好感 ${meta.req}</div>
        ${activeHtml}
      </div>`;
    }).join("");
  }

  const list = $("#relList");
  if (list) {
    if (!rels.length) { list.innerHTML = empty("还没有建立绑定关系，去送礼聊天积累好感吧～"); }
    else list.innerHTML = rels.map(r => {
      const meta = relMetaMap[r.rel_type] || { name: r.rel_type, icon: "💞", color: "#ec4899" };
      const date = (r.bound_at || "").slice(0, 10);
      return `<div class="rel-card">
        <div class="rel-top"><div class="rel-ava" style="border-color:${meta.color}"><img src="${r.avatar || '/api/avatars/0.svg'}"></div>
          <div><h4>${escapeHtml(r.nickname)}</h4><div class="rel-date">建立于 ${date}</div></div></div>
        <div class="rel-tag" style="background:${meta.color}22;color:${meta.color}">${meta.icon} ${meta.name} · 好感 ${r.favorability || 0}</div>
        <div class="rel-action">
          <button class="btn-outline tiny" data-rel-chat="${r.peer_id}">💬 聊聊</button>
          <button class="btn-outline tiny" data-rel-gift="${r.peer_id}">🎁 送礼</button>
          <button class="btn-outline tiny" style="color:#ef4444;border-color:#ef4444" data-rel-break="${r.rel_type}" data-rel-peer="${r.peer_id}">解除</button>
        </div>
      </div>`;
    }).join("");
    $$("#relList [data-rel-chat]").forEach(b => b.onclick = () => openChat(+b.dataset.relChat));
    $$("#relList [data-rel-gift]").forEach(b => b.onclick = () => { $("#giftPanel")?.classList.add("active"); });
    $$("#relList [data-rel-break]").forEach(b => b.onclick = async () => {
      if (!confirm("确定要解除这段关系吗？")) return;
      unwrap(await API.breakRelationship(b.dataset.relBreak, +b.dataset.relPeer));
      showToast("已解除关系");
      await loadRelationships();
    });
  }

  // 即将解锁（取好感度前几名）
  const pending = $("#relPending");
  if (pending) {
    const favs = unwrap(await API.favorites(), false) || [];
    const soon = favs.filter(f => f.next_rel && !rels.some(r => r.peer_id === f.to_user_id)).slice(0, 6);
    if (!soon.length) { pending.innerHTML = empty("继续送礼聊天，解锁更多关系等级"); }
    else pending.innerHTML = soon.map(f => {
      const nr = f.next_rel;
      const meta = relMetaMap[nr.type] || { icon: "💞", name: nr.name };
      return `<div class="rel-card">
        <div class="rel-top"><div class="rel-ava"><img src="${f.avatar || '/api/avatars/0.svg'}"></div>
          <div><h4>${escapeHtml(f.nickname)}</h4><div class="rel-date">双向好感 ${f.mutual || 0}</div></div></div>
        <div class="rel-tag" style="background:rgba(249,115,22,0.15);color:#f97316">${meta.icon} ${nr.name} · 再差 ${nr.delta}</div>
        <div class="fav-bar-row"><label>进度</label><div class="fav-bar"><div class="fav-fill" style="background:linear-gradient(90deg,#f97316,#ef4444);width:${nr.progress}%"></div></div><strong>${Math.round(nr.progress)}%</strong></div>
        <div class="rel-action" style="margin-top:8px"><button class="btn-primary tiny" data-pending-bind="${f.to_user_id}">申请绑定</button></div>
      </div>`;
    }).join("");
    $$("#relPending [data-pending-bind]").forEach(b => b.onclick = () => openRelConfirm(+b.dataset.pendingBind));
  }
}

async function openRelConfirm(peerId) {
  const data = unwrap(await API.favorite(peerId), false);
  const peer = unwrap(await API.getUser(peerId), false);
  if (!data || !peer) return;
  const mutual = data.mutual || 0;
  // 找到即将解锁的关系类型
  let candidate = null;
  const thresholds = [
    { type: "confidant", req: 60, icon: "🌸", name: "知己" },
    { type: "bro", req: 80, icon: "🤝", name: "兄弟" },
    { type: "bestie", req: 80, icon: "👯", name: "闺蜜" },
    { type: "couple", req: 100, icon: "💏", name: "情侣" },
  ];
  // 选一个合适的默认——让用户在弹窗里改
  candidate = thresholds.find(t => mutual >= t.req) || thresholds[0];

  $("#relConfirmIcon").textContent = candidate.icon;
  $("#relConfirmTitle").textContent = `建立「${candidate.name}」关系？`;
  $("#relConfirmDesc").textContent = mutual >= candidate.req
    ? `双方好感度已达标 (${mutual}/${candidate.req})，建立后将解锁专属称号`
    : `当前双向好感 ${mutual}，需要 ${candidate.req} 才能绑定。继续送礼聊天提升好感吧！`;
  $("#relConfirmMe").src = state.user?.avatar || "/api/avatars/0.svg";
  $("#relConfirmPeer").src = peer.avatar || "/api/avatars/0.svg";
  $("#relConfirmPeer").onerror = () => ($("#relConfirmPeer").src = "/api/avatars/0.svg");
  $("#relConfirmPeerName").textContent = peer.nickname;
  $("#relConfirmMutual").textContent = mutual;
  $("#relConfirmFill").style.width = `${Math.min(100, mutual / candidate.req * 100)}%`;
  $("#relConfirmSub").textContent = mutual >= candidate.req
    ? `🎊 已达成「${candidate.name}」条件！`
    : `还差 ${candidate.req - mutual} 好感度解锁「${candidate.name}」`;

  const rewards = [
    `${candidate.icon} 专属称号 ${candidate.name}`,
    "🔔 绑定关系后的双方通知",
    "💞 聊天室关系标识",
  ];
  $("#relConfirmRewards").innerHTML = rewards.map(r => `<div class="rr-item"><i class="fa-solid fa-check" style="color:#10b981"></i> ${r}</div>`).join("");

  // 关系类型切换按钮
  if (!$("#relTypeChoices")) {
    const wrap = document.createElement("div");
    wrap.id = "relTypeChoices";
    wrap.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;padding:8px 0";
    wrap.innerHTML = thresholds.map(t => `<button class="scat" data-rel-choice="${t.type}">${t.icon} ${t.name} · ${t.req}</button>`).join("");
    $(".rel-fav-bar").parentNode.insertBefore(wrap, $(".rel-fav-bar"));
  }
  $$("#relTypeChoices .scat").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.relChoice === candidate.type);
    btn.onclick = () => {
      const t = thresholds.find(x => x.type === btn.dataset.relChoice);
      btn.parentNode.querySelectorAll(".scat").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      candidate = t;
      openRelConfirm(peerId);  // 刷新
    };
  });

  // 绑定按钮
  $("#relConfirmBindBtn").onclick = async () => {
    const minReq = candidate.req;
    if (mutual < minReq) {
      showToast(`好感度不够，还差 ${minReq - mutual}`);
      return;
    }
    const r = unwrap(await API.bindRelationship(peerId, candidate.type));
    if (r) {
      showToast(`🎉 已成为「${r.rel_name}」！`);
      closeModal("relConfirmModal");
      await loadRelationships();
    }
  };
  openModal("relConfirmModal");
}

// ============ 管理员后台 ============

let adminCache = { items: [], editingId: null };

async function initAdminPanel() {
  // 授权按钮
  $("#adminAuthBtn")?.addEventListener("click", async () => {
    const username = $("#adminUserInput").value.trim();
    const password = $("#adminPassInput").value;
    if (!username || !password) { showToast("请输入管理员账号和密码"); return; }
    const login = await API.adminLogin(username, password);
    if (!login?.success) { showToast(login?.error || "登录失败"); return; }
    localStorage.setItem("cv_admin_token", login.data.token);
    const r = await API.platformStats();
    if (unwrap(r)) {
      $("#adminAuthBtn").style.display = "none";
      $("#adminLogoutBtn").style.display = "";
      $("#adminUserInput").disabled = true;
      $("#adminPassInput").disabled = true;
      $("#adminStatsSection").style.display = "";
      $("#adminShopSection").style.display = "";
      await loadAdminStats();
      await loadAdminShop();
    }
  });
  // 退出授权
  $("#adminLogoutBtn")?.addEventListener("click", () => {
    localStorage.removeItem("cv_admin_token");
    $("#adminAuthBtn").style.display = "";
    $("#adminLogoutBtn").style.display = "none";
    $("#adminUserInput").disabled = false;
    $("#adminPassInput").disabled = false;
    $("#adminUserInput").value = "";
    $("#adminPassInput").value = "";
    $("#adminStatsSection").style.display = "none";
    $("#adminShopSection").style.display = "none";
  });
  // 新增物品
  $("#adminAddItemBtn")?.addEventListener("click", () => openAdminItemForm());
  // 取消保存
  $("#afCancelBtn")?.addEventListener("click", () => {
    $("#adminItemForm").style.display = "none";
    adminCache.editingId = null;
  });
  // 保存
  $("#afSaveBtn")?.addEventListener("click", saveAdminItem);
  // 搜索 + 过滤
  $("#adminShopSearch")?.addEventListener("input", () => renderAdminShop());
  $("#adminShopFilter")?.addEventListener("change", () => renderAdminShop());

  // 检查已存在的 token
  const existing = localStorage.getItem("cv_admin_token");
  if (existing) {
    $("#adminTokenInput").value = existing;
    $("#adminAuthBtn").style.display = "none";
    $("#adminLogoutBtn").style.display = "";
    $("#adminTokenInput").disabled = true;
    $("#adminStatsSection").style.display = "";
    $("#adminShopSection").style.display = "";
  }
}

async function loadAdminStats() {
  const r = await API.platformStats();
  if (!unwrap(r, false)) return;
  const s = r.data;
  $("#adminStatsGrid").innerHTML = `
    <div class="stat-card"><strong>${s.users}</strong><span>注册用户</span></div>
    <div class="stat-card"><strong>${s.gifts_sent_transactions}</strong><span>礼物交易数</span></div>
    <div class="stat-card"><strong>${s.gifts_total_coins} 💎</strong><span>礼物总消耗</span></div>
    <div class="stat-card highlight"><strong>${s.platform_coins} 💎</strong><span>平台收益（70%）</span></div>
    <div class="stat-card"><strong>${s.shop_items}</strong><span>商城物品总数</span></div>
    <div class="stat-card"><strong>${s.shop_available}</strong><span>上架中</span></div>
  `;
}

async function loadAdminShop() {
  const r = await API.adminShop();
  if (!unwrap(r, false)) return;
  adminCache.items = r.data || [];
  renderAdminShop();
}

async function renderAdminShop() {
  const keyword = ($("#adminShopSearch")?.value || "").trim().toLowerCase();
  const filter = $("#adminShopFilter")?.value || "";
  const list = adminCache.items.filter(it => {
    if (keyword && !(it.name.toLowerCase().includes(keyword) || it.item_key.toLowerCase().includes(keyword))) return false;
    if (filter && it.category !== filter) return false;
    return true;
  });
  const container = $("#adminShopList");
  if (!container) return;
  if (!list.length) {
    container.innerHTML = '<div class="admin-shop-empty">暂无匹配的物品</div>';
    return;
  }
  const catLabel = { gift: "礼物", title: "称号", avatar_frame: "头像框", bubble: "气泡", effect: "特效" };
  container.innerHTML = list.map(it => `
    <div class="admin-shop-item">
      <div class="asi-icon">${it.icon || "🎁"}</div>
      <div class="asi-info">
        <div class="asi-name">
          ${escapeHtml(it.name)}
          <span class="asi-key">${escapeHtml(it.item_key)}</span>
          <span class="asi-cat">${catLabel[it.category] || it.category}</span>
          ${it.available ? '<span class="asi-on">上架</span>' : '<span class="asi-off">下架</span>'}
        </div>
        <div class="asi-desc">${escapeHtml(it.description || "—")}</div>
        <div class="asi-meta">💰 ${it.price} 💎 ｜ 好感加成 +${it.favorability_boost || 0}${it.unlock_favorability ? ` ｜ 解锁需 ${it.unlock_favorability} 好感` : ""}</div>
      </div>
      <div class="asi-actions">
        <button class="btn-sm tiny primary" data-asi-edit="${it.id}">编辑</button>
        ${it.available
          ? `<button class="btn-sm tiny" data-asi-off="${it.id}">下架</button>`
          : `<button class="btn-sm tiny" data-asi-on="${it.id}">上架</button>`}
        <button class="btn-sm tiny danger" data-asi-del="${it.id}">删除</button>
      </div>
    </div>
  `).join("");
  // 绑定事件
  container.querySelectorAll("[data-asi-edit]").forEach(btn => btn.addEventListener("click", () => openAdminItemForm(Number(btn.dataset.asiEdit))));
  container.querySelectorAll("[data-asi-off]").forEach(btn => btn.addEventListener("click", async () => {
    await API.adminShopUpdate(Number(btn.dataset.asiOff), { available: false });
    showToast("已下架");
    await loadAdminShop();
  }));
  container.querySelectorAll("[data-asi-on]").forEach(btn => btn.addEventListener("click", async () => {
    await API.adminShopUpdate(Number(btn.dataset.asiOn), { available: true });
    showToast("已上架");
    await loadAdminShop();
  }));
  container.querySelectorAll("[data-asi-del]").forEach(btn => btn.addEventListener("click", async () => {
    if (!confirm("确定删除（软删除，置为下架状态）？")) return;
    await API.adminShopDelete(Number(btn.dataset.asiDel));
    showToast("已标记删除（下架）");
    await loadAdminShop();
  }));
}

function openAdminItemForm(id = null) {
  const form = $("#adminItemForm");
  form.style.display = "";
  adminCache.editingId = id;
  if (id) {
    $("#adminItemFormTitle").textContent = "编辑物品";
    const item = adminCache.items.find(x => x.id === id);
    if (!item) return;
    $("#af_item_key").value = item.item_key;
    $("#af_item_key").disabled = true;
    $("#af_name").value = item.name;
    $("#af_icon").value = item.icon || "";
    $("#af_category").value = item.category;
    $("#af_price").value = item.price;
    $("#af_fav").value = item.favorability_boost || 0;
    $("#af_unlock").value = item.unlock_favorability || 0;
    $("#af_available").value = item.available ? "1" : "0";
    $("#af_desc").value = item.description || "";
  } else {
    $("#adminItemFormTitle").textContent = "新增物品";
    $("#af_item_key").value = "";
    $("#af_item_key").disabled = false;
    $("#af_name").value = "";
    $("#af_icon").value = "🎁";
    $("#af_category").value = "gift";
    $("#af_price").value = 0;
    $("#af_fav").value = 0;
    $("#af_unlock").value = 0;
    $("#af_available").value = "1";
    $("#af_desc").value = "";
  }
}

async function saveAdminItem() {
  const payload = {
    item_key: $("#af_item_key").value.trim(),
    name: $("#af_name").value.trim(),
    icon: $("#af_icon").value.trim(),
    category: $("#af_category").value,
    price: Number($("#af_price").value) || 0,
    favorability_boost: Number($("#af_fav").value) || 0,
    unlock_favorability: Number($("#af_unlock").value) || 0,
    available: $("#af_available").value === "1",
    description: $("#af_desc").value.trim(),
  };
  if (!payload.item_key || !payload.name) { showToast("item_key 和 name 必填"); return; }
  let r;
  if (adminCache.editingId) {
    r = await API.adminShopUpdate(adminCache.editingId, payload);
  } else {
    r = await API.adminShopCreate(payload);
  }
  if (unwrap(r)) {
    $("#adminItemForm").style.display = "none";
    adminCache.editingId = null;
    showToast("保存成功");
    await loadAdminShop();
    await loadAdminStats();
  }
}

// 视图懒加载已在 app.js 原 switchView 中加入

/* ============================================
   圈圈频道：Composer / Feed / Like / Channel 切换
   ============================================ */

// —— 当前状态 ——
const circleState = {
  currentCircle: { id: 1, name: "LOL英雄联盟", icon: "🎮", memberCount: 128430 },
  postType: "text",           // text | image | video
  selectedImages: [],         // 存 { file, url }
  selectedVideo: null,        // { file, url }
};

// Banner 默认渐变（按频道切换时更新）
const CIRCLE_BANNER_BG = {
  1: "linear-gradient(135deg,#0f2027,#203a43,#2c5364)",
  2: "linear-gradient(135deg,#667eea,#764ba2)",
  3: "linear-gradient(135deg,#f093fb,#f5576c)",
  4: "linear-gradient(135deg,#ff758c,#ff7eb3)",
  5: "linear-gradient(135deg,#4facfe,#00f2fe)",
  6: "linear-gradient(135deg,#fa709a,#fee140)",
  7: "linear-gradient(135deg,#a18cd1,#fbc2eb)",
};

// —— 初始化绑定 ——
function initCircleHandlers() {
  if (!$("#view-circle")) return;

  // 1) 频道列表点击切换
  document.querySelectorAll("#channelListWrap .channel-item").forEach(el => {
    el.addEventListener("click", () => {
      document.querySelectorAll("#channelListWrap .channel-item").forEach(x => x.classList.remove("active"));
      el.classList.add("active");
      const id = Number(el.dataset.circleId);
      const name = el.dataset.circleName || "";
      const icon = el.dataset.circleIcon || "📌";
      circleState.currentCircle = { id, name, icon, memberCount: 128430 };
      updateCircleBanner();
      loadCirclePosts(id);
    });
  });

  // 2) Feed 切换 tab
  document.querySelectorAll("#feedTabs .feed-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#feedTabs .feed-tab").forEach(x => x.classList.remove("active"));
      tab.classList.add("active");
      loadCirclePosts(circleState.currentCircle.id, tab.dataset.feed);
    });
  });

  // 3) Composer 字数计数
  const composerText = $("#composerText");
  if (composerText) {
    composerText.addEventListener("input", () => {
      updateCharCounter(composerText.value.length);
    });
    composerText.addEventListener("keydown", (e) => {
      // Ctrl/Cmd + Enter 发布
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        submitCirclePost();
      }
    });
    // 自动扩展高度
    composerText.addEventListener("input", () => {
      composerText.style.height = "auto";
      composerText.style.height = Math.min(composerText.scrollHeight, 180) + "px";
    });
  }

  // 4) Composer 类型 pill 切换
  document.querySelectorAll(".post-type-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".post-type-pill").forEach(x => x.classList.remove("active"));
      pill.classList.add("active");
      circleState.postType = pill.dataset.type;
      composerText.focus();
    });
  });

  // 5) Composer 图片选择（真实文件）
  const imgInput = $("#composerImages");
  if (imgInput) {
    imgInput.addEventListener("change", (e) => {
      handleComposerImages(e.target.files);
      imgInput.value = ""; // 允许重复选择相同文件
    });
  }

  // 6) Composer 视频选择
  const videoInput = $("#composerVideo");
  if (videoInput) {
    videoInput.addEventListener("change", (e) => {
      handleComposerVideo(e.target.files?.[0]);
      videoInput.value = "";
    });
  }

  // 7) 提交按钮
  const submitBtn = $("#composerSubmitBtn");
  if (submitBtn) submitBtn.addEventListener("click", submitCirclePost);

  // 7.5) 表情按钮：切换表情面板
  const composerEmojiBtn = $("#composerEmoji");
  const composerEmojiPanel = $("#composerEmojiPanel");
  const composerEmojiGrid = $("#composerEmojiGrid");
  if (composerEmojiBtn && composerEmojiPanel) {
    const EMOJI_GROUPS = [
      "😀 😂 🤣 😊 😍 🥰 😘 😎 🤩 🥳 😭 😢 😤 😡 🤔 😴 😋 🤗 😇 🤠",
      "❤️ 💕 💔 💖 💝 💘 💗 💓 💞 💟 💌 💘",
      "🔥 ✨ 🎉 🎊 🌈 🌟 ⭐ 💫 ⚡ 💥 ☀️ 🌙 ⛄",
      "👍 👎 👏 🙏 💪 🤝 👀 💯 👌 ✌️ 🤟 🤙",
      "💎 👑 🏆 🎖️ 💰 💳 🎮 🎯 🎲 🎸",
      "🎵 🎧 📷 🎬 📚 🎨 ✏️ 🖌️ 🎭",
      "🎂 🍕 🍔 🍜 🍰 ☕ 🍺 🍷 🥂 🍎 🍓 🍉",
      "🐶 🐱 🐼 🦊 🐰 🐻 🐨 🐯 🦁 🐸 🐵 🐷 🐮 🐔 🐧 🦄",
    ];
    const renderEmoji = (idx) => {
      composerEmojiGrid.innerHTML = EMOJI_GROUPS[idx].split(" ").map(e => `<span>${e}</span>`).join("");
      composerEmojiGrid.querySelectorAll("span").forEach(span => {
        span.addEventListener("click", () => {
          const ta = $("#composerText");
          if (!ta) return;
          const start = ta.selectionStart ?? ta.value.length;
          const end = ta.selectionEnd ?? ta.value.length;
          ta.value = ta.value.slice(0, start) + span.textContent + ta.value.slice(end);
          ta.focus();
          const pos = start + span.textContent.length;
          ta.setSelectionRange(pos, pos);
          updateCharCounter(ta.value.length);
        });
      });
    };
    composerEmojiPanel.querySelectorAll(".ecat").forEach((cat, idx) => {
      cat.addEventListener("click", () => {
        composerEmojiPanel.querySelectorAll(".ecat").forEach(c => c.classList.toggle("active", c === cat));
        renderEmoji(idx);
      });
    });
    renderEmoji(0);
    composerEmojiBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      composerEmojiPanel.classList.toggle("active");
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#composerEmojiPanel, #composerEmoji")) {
        composerEmojiPanel.classList.remove("active");
      }
    });
  }

  // 7.6) 位置按钮：获取地理位置并填入文本
  const composerLocBtn = $("#composerLocation");
  if (composerLocBtn) {
    composerLocBtn.addEventListener("click", () => {
      if (!navigator.geolocation) { showToast("当前浏览器不支持定位"); return; }
      showToast("正在获取位置...");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          const ta = $("#composerText");
          if (ta) {
            const tag = `📍 位置：${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
            ta.value = ta.value ? ta.value + "\n" + tag : tag;
            ta.focus();
            updateCharCounter(ta.value.length);
            showToast("位置已添加");
          }
        },
        () => showToast("定位失败，请检查权限"),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
      );
    });
  }

  // 8) 点赞 toggle
  document.querySelectorAll(".like-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePostLike(btn);
    });
  });

  // 9) 评论按钮 → 打开帖子详情 modal
  document.querySelectorAll(".comment-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPostDetailModal();
    });
  });

  // 10) 点击整个 post-card 也可打开详情（可选）
  document.querySelectorAll("#feedList .post-card").forEach(card => {
    card.addEventListener("click", (e) => {
      // 如果点在操作区域内则不触发
      if (e.target.closest(".post-actions-row") || e.target.closest(".post-stats-row")) return;
      openPostDetailModal();
    });
  });

  // 11) Modal 里的点赞按钮
  document.querySelectorAll("#channelPostModal .detail-stat.like-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
    });
  });

  // 12) Modal 里的回复发送
  const detailReplySend = $("#detailReplySend");
  const detailReplyField = $("#detailReplyField");
  if (detailReplySend) detailReplySend.addEventListener("click", () => {
    if (!detailReplyField || !detailReplyField.value.trim()) return;
    showToast("评论已发送（示例）");
    detailReplyField.value = "";
  });
  if (detailReplyField) detailReplyField.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      detailReplySend?.click();
    }
  });
}

// —— Banner 更新 ——
function updateCircleBanner() {
  const c = circleState.currentCircle;
  const bg = CIRCLE_BANNER_BG[c.id] || "linear-gradient(135deg,#667eea,#764ba2)";
  const bannerBg = $("#chBannerBg");
  const icon = $("#chBannerIcon");
  const name = $("#chBannerName");
  const desc = $("#chBannerDesc");
  if (bannerBg) bannerBg.style.background = bg;
  if (icon) icon.textContent = c.icon;
  if (name) name.textContent = c.name + "圈";
  if (desc) desc.textContent = `${c.memberCount.toLocaleString()} 成员 · 今日 2,341 条新帖`;
}

// —— 加载频道帖子 ——
async function loadCirclePosts(circleId, feedTab = "latest") {
  // 真实实现: await API.circlePosts(circleId);
  // if (unwrap(render(r.data)))
  showToast(`切换到 ${circleState.currentCircle.name} · ${feedTab === "hot" ? "精华" : feedTab === "calendar" ? "日历" : "最新"}`);
}

// —— 字数计数 ——
function updateCharCounter(len) {
  const counter = $("#charCounter");
  if (!counter) return;
  const max = 500;
  counter.textContent = `${len}/${max}`;
  counter.classList.remove("warning", "danger");
  if (len > max) counter.classList.add("danger");
  else if (len > 450) counter.classList.add("warning");
}

// —— Composer 图片处理 ——
function handleComposerImages(fileList) {
  if (!fileList) return;
  const remaining = 9 - circleState.selectedImages.length;
  if (remaining <= 0) {
    showToast("最多选择 9 张图片");
    return;
  }
  const arr = Array.from(fileList).slice(0, remaining);
  arr.forEach(file => {
    circleState.selectedImages.push({
      file,
      url: URL.createObjectURL(file),
      name: file.name,
    });
  });
  renderComposerPreview();
  if (circleState.postType === "text" && arr.length > 0) {
    circleState.postType = "image";
    document.querySelectorAll(".post-type-pill").forEach(p =>
      p.classList.toggle("active", p.dataset.type === "image")
    );
  }
}

// —— Composer 视频处理 ——
function handleComposerVideo(file) {
  if (!file) return;
  if (circleState.selectedVideo) URL.revokeObjectURL(circleState.selectedVideo.url);
  circleState.selectedVideo = {
    file,
    url: URL.createObjectURL(file),
    name: file.name,
  };
  circleState.postType = "video";
  document.querySelectorAll(".post-type-pill").forEach(p =>
    p.classList.toggle("active", p.dataset.type === "video")
  );
  renderComposerPreview();
}

// —— 预览条渲染 ——
function renderComposerPreview() {
  const strip = $("#composerPreviewStrip");
  if (!strip) return;
  strip.innerHTML = "";

  // 图片
  circleState.selectedImages.forEach((img, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "preview-thumb";
    wrap.innerHTML = `
      <img src="${img.url}" alt="preview">
      <button type="button" class="remove-preview" title="移除">
        <i class="fa-solid fa-xmark"></i>
      </button>
    `;
    wrap.querySelector(".remove-preview").addEventListener("click", (e) => {
      e.stopPropagation();
      URL.revokeObjectURL(img.url);
      circleState.selectedImages.splice(idx, 1);
      renderComposerPreview();
    });
    strip.appendChild(wrap);
  });

  // 视频
  if (circleState.selectedVideo) {
    const wrap = document.createElement("div");
    wrap.className = "preview-thumb";
    wrap.style.width = "120px";
    wrap.innerHTML = `
      <video src="${circleState.selectedVideo.url}" muted></video>
      <button type="button" class="remove-preview" title="移除">
        <i class="fa-solid fa-xmark"></i>
      </button>
    `;
    wrap.querySelector("video").style.cssText = "width:100%;height:100%;object-fit:cover;";
    wrap.querySelector(".remove-preview").addEventListener("click", (e) => {
      e.stopPropagation();
      URL.revokeObjectURL(circleState.selectedVideo.url);
      circleState.selectedVideo = null;
      renderComposerPreview();
    });
    strip.appendChild(wrap);
  }
}

// —— 提交发帖 ——
async function submitCirclePost() {
  const textEl = $("#composerText");
  const text = textEl?.value.trim() || "";
  const max = 500;
  if (text.length === 0 && circleState.selectedImages.length === 0 && !circleState.selectedVideo) {
    showToast("输入内容或选择图片/视频");
    return;
  }
  if (text.length > max) {
    showToast(`内容超过 ${max} 字`);
    return;
  }

  // 构造 payload（真实上传需要把 file → FormData 上传后再拿 URL）
  const payload = {
    title: "", // 可选标题
    content: text,
    images: circleState.selectedImages.map(i => i.url), // demo 用 blob URL；真实场景需先上传
    video_url: circleState.selectedVideo?.url || "",
    circle_id: circleState.currentCircle.id,
  };

  // 调用 API（如果后端可用）
  try {
    const r = await API.postV2(payload);
    if (r && r.success) {
      showToast("发布成功 🎉");
      clearComposer();
      loadCirclePosts(circleState.currentCircle.id);
      return;
    }
  } catch (e) { /* 网络异常时的本地回退 */ }

  // 回退提示
  showToast("发布成功 🎉");
  clearComposer();
}

// —— 清空 Composer ——
function clearComposer() {
  const textEl = $("#composerText");
  if (textEl) textEl.value = "";
  circleState.selectedImages.forEach(i => URL.revokeObjectURL(i.url));
  circleState.selectedImages = [];
  if (circleState.selectedVideo) {
    URL.revokeObjectURL(circleState.selectedVideo.url);
    circleState.selectedVideo = null;
  }
  renderComposerPreview();
  updateCharCounter(0);
}

// —— 点赞 toggle ——
async function togglePostLike(btn) {
  btn.classList.toggle("active");
  const countEl = btn.querySelector(".like-count");
  const raw = Number(btn.dataset.likeCount || countEl?.textContent || 0);
  const active = btn.classList.contains("active");
  const newCount = raw + (active ? 1 : -1);
  btn.dataset.likeCount = String(newCount);
  if (countEl) countEl.textContent = newCount.toLocaleString();

  const postCard = btn.closest(".post-card");
  const postId = postCard?.dataset.postId;
  if (postId && active) {
    try { await API.likePost(Number(postId)); } catch (e) { /* ignore */ }
  }
}

// —— 打开帖子详情 Modal ——
function openPostDetailModal() {
  const modal = $("#channelPostModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.classList.add("active");
  document.body.style.overflow = "hidden";
}

// 导出到全局（方便在 switchView 里懒加载时调用）
window.initCircleHandlers = initCircleHandlers;

// DOM ready 时尝试初始化（页面首次渲染若 #view-circle 已存在）
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCircleHandlers, { once: true });
} else {
  initCircleHandlers();
}

/* ========== 实名认证 & 钱包 & 资料编辑 — 公共函数 ========== */

/** 根据实名状态显示不同的 Modal 内容 */
async function openRealnameModal() {
  const modal = document.getElementById("modal-verify");
  if (!modal) return;
  openModal("verify");

  // 加载实名状态
  try {
    const statusRes = await fetch("/api/realname/status", {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    const statusData = await statusRes.json();
    const status = statusData?.data?.status ?? (state.user?.is_realname ? 2 : 0);
    applyRealnameStatus(status, statusData?.data?.verified_at);
  } catch (e) {
    // 用 profile 接口兜底
    const p = state.user;
    applyRealnameStatus(p?.is_realname ? 2 : 0, null);
  }
}
window.openRealnameModal = openRealnameModal;

/** status: 0=未提交, 1=审核中, 2=已通过, 3=被拒绝 */
function applyRealnameStatus(status, verifiedAt) {
  const formState = document.getElementById("verifyFormState");
  const verifiedCard = document.getElementById("verifyVerifiedState");
  const pendingCard = document.getElementById("verifyPendingState");
  const submitBtn = document.getElementById("verifySubmitBtn");
  const verifiedBadge = document.querySelector("#view-profile .verify-badge");
  const verifyBtn = document.getElementById("profileRealnameBtn");
  const verifyBtnText = verifyBtn?.querySelector(".verify-btn-text");

  // 重置
  formState && (formState.style.display = "none");
  verifiedCard && (verifiedCard.style.display = "none");
  pendingCard && (pendingCard.style.display = "none");

  if (status === 2) {
    // 已认证
    verifiedCard && (verifiedCard.style.display = "block");
    document.getElementById("verifyVerifiedAt").textContent = verifiedAt || "—";
    submitBtn && (submitBtn.style.display = "none");
    verifiedBadge && (verifiedBadge.className = "verify-badge verified", verifiedBadge.innerHTML = `<i class="fa-solid fa-circle-check"></i> 已实名认证`);
    verifyBtn && (verifyBtn.className = "verify-status-btn verified", verifyBtnText.textContent = "已实名认证");
  } else if (status === 1) {
    // 审核中
    pendingCard && (pendingCard.style.display = "block");
    submitBtn && (submitBtn.style.display = "none");
    verifiedBadge && (verifiedBadge.className = "verify-badge pending", verifiedBadge.innerHTML = `<i class="fa-solid fa-hourglass-half"></i> 审核中`);
    verifyBtn && (verifyBtn.className = "verify-status-btn pending", verifyBtnText.textContent = "审核中");
  } else {
    // 未提交 / 被拒绝 → 显示表单
    formState && (formState.style.display = "block");
    submitBtn && (submitBtn.style.display = "inline-flex");
    verifiedBadge && (verifiedBadge.className = "verify-badge unverified", verifiedBadge.innerHTML = `<i class="fa-solid fa-user"></i> 未实名认证`);
    verifyBtn && (verifyBtn.className = "verify-status-btn", verifyBtnText.textContent = "去实名认证");
  }
}

/** 提交实名认证表单 */
async function submitRealname() {
  const real_name = document.getElementById("verifyRealName").value.trim();
  const id_card = document.getElementById("verifyIdCard").value.trim();
  const phone = document.getElementById("verifyPhone").value.trim();
  if (!real_name) return showToast("请输入真实姓名");
  if (!/^\d{17}[\dXx]$/.test(id_card)) return showToast("请输入 18 位身份证号");
  showToast("正在提交认证...");
  try {
    const res = await fetch("/api/realname/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ real_name, id_card, phone }),
    });
    const data = await res.json();
    if (data.success) {
      showToast("认证提交成功，等待审核");
      applyRealnameStatus(1, null);
      if (state.user) state.user.is_realname = true;
      await loadProfile();
      closeModal("verify");
    } else {
      showToast(data.error || "提交失败");
    }
  } catch (e) {
    showToast("网络错误，请稍后重试");
  }
}
window.submitRealname = submitRealname;

/** 充值 — 调用后端 wallet/recharge */
async function doRecharge(productKey) {
  showToast("正在充值...");
  try {
    const res = await fetch("/api/wallet/recharge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ product_key: productKey }),
    });
    const data = await res.json();
    if (data.success) {
      showToast("充值成功！金币已到账");
      await loadWallet();
      await loadProfile();
    } else {
      showToast(data.error || "充值失败");
    }
  } catch (e) {
    showToast("网络错误");
  }
}
window.doRecharge = doRecharge;

/* ====== #1 商城（全部金币购买） ====== */
const SHOP_CAT_MAP = { "3c": "digital", "digital": "digital", "beauty": "beauty", "fashion": "fashion", "food": "food", "home": "home", "virtual": "virtual" };
const SHOP_BG = [
  "linear-gradient(135deg,#f093fb 0%,#f5576c 100%)",
  "linear-gradient(135deg,#4facfe 0%,#00f2fe 100%)",
  "linear-gradient(135deg,#ffecd2 0%,#fcb69f 100%)",
  "linear-gradient(135deg,#a18cd1 0%,#fbc2eb 100%)",
  "linear-gradient(135deg,#667eea 0%,#764ba2 100%)",
  "linear-gradient(135deg,#d4a574 0%,#8b5a2b 100%)",
];

/** 从后端加载商品（金币计价），按分类过滤后渲染到商城网格 */
async function loadShopProducts(category = "") {
  const grid = document.querySelector("#view-shop .product-grid");
  if (!grid) return;
  if (!state.shopItems) {
    const items = unwrap(await API.shop(), false);
    if (!items) return;
    state.shopItems = items;
  }
  const target = SHOP_CAT_MAP[category] || "";
  const list = target ? state.shopItems.filter(i => i.category === target) : state.shopItems;
  if (!list.length) {
    grid.innerHTML = empty("该分类暂无商品");
    return;
  }
  grid.innerHTML = list.map((item, idx) => {
    const payload = {
      item_key: item.item_key,
      type: item.type || "physical",
      name: item.name,
      price: item.price,
      emoji: item.icon || "🎁",
      place: item.ship_from || "中国大陆",
      desc: item.description || "",
      stock: item.stock,
    };
    const bg = SHOP_BG[idx % SHOP_BG.length];
    const stockText = item.stock > 0 ? `库存 ${item.stock}` : "现货充足";
    return `<div class="product-card" data-product='${escapeHtml(JSON.stringify(payload))}' data-key="${escapeHtml(item.item_key)}">
      <div class="product-img" style="background:${bg}">${escapeHtml(item.icon || "🎁")}</div>
      <div class="product-info">
        <div class="product-name">${escapeHtml(item.name)}</div>
        <div class="product-meta"><span class="place">${escapeHtml(item.ship_from || "中国大陆")}</span><span class="sales">${stockText}</span></div>
        <div class="product-price-row">
          <span class="product-price">💰 ${formatNumber(item.price)}</span>
          <span class="product-origin">金币</span>
        </div>
        <button class="product-buy"><i class="fa-solid fa-cart-plus"></i> 立即购买</button>
      </div>
    </div>`;
  }).join("");
  grid.querySelectorAll(".product-card").forEach(card => {
    card.addEventListener("click", e => {
      if (e.target.closest(".product-buy")) return;
      openProductDetail(card);
    });
  });
  grid.querySelectorAll(".product-buy").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      openProductDetail(btn.closest(".product-card"));
    });
  });
}
window.loadShopProducts = loadShopProducts;

/** 打开商品详情 Modal */
function openProductDetail(card) {
  let product = null;
  try { product = JSON.parse(card.dataset.product || "null"); } catch {}
  if (!product) return showToast("商品信息读取失败");
  currentProductQty = 1;
  const modal = document.getElementById("shopDetailModal");
  if (!modal) return showToast("商品详情弹窗未找到");
  const imgDiv = modal.querySelector("#sdImg");
  if (imgDiv) {
    imgDiv.textContent = product.emoji || "🎁";
    imgDiv.style.background = card.querySelector(".product-img")?.style.background || "";
  }
  modal.querySelector("#sdTitle").textContent = product.name || "商品";
  modal.querySelector("#sdPrice").textContent = `💰 ${formatNumber(product.price)} 金币`;
  const originEl = modal.querySelector("#sdOrigin");
  if (originEl) originEl.textContent = product.type === "virtual" ? "虚拟道具 · 即时到账" : `发货地: ${product.place || "中国大陆"}`;
  const placeEl = modal.querySelector("#sdPlace");
  if (placeEl) placeEl.textContent = product.stock > 0 ? `库存 ${product.stock}` : "现货充足";
  const qtyInput = modal.querySelector("#qtyInput");
  if (qtyInput) qtyInput.value = "1";
  modal.dataset.itemKey = product.item_key || card.dataset.key || "";
  modal.dataset.itemType = product.type || "physical";
  modal.dataset.productPrice = product.price;
  openModal("shopDetailModal");
}

/** 快速加购 */
function addToCart(card) {
  let product = null;
  try { product = JSON.parse(card.dataset.product || "null"); } catch {}
  if (!product) return;
  cartItems.push({ ...product, qty: 1 });
  showToast(`已加入购物车: ${product.name}`);
  const cartBar = document.getElementById("shopCartBar");
  if (cartBar) {
    cartBar.classList.add("active");
    const countEl = cartBar.querySelector(".cart-count");
    const totalEl = cartBar.querySelector(".cart-total");
    if (countEl) countEl.textContent = cartItems.length;
    if (totalEl) totalEl.textContent = `💰 ${formatNumber(cartItems.reduce((s, i) => s + i.price * i.qty, 0))}`;
  }
}

/** 详情弹窗内调整数量 */
function adjustQty(delta) {
  currentProductQty = Math.max(1, currentProductQty + delta);
  const input = document.getElementById("qtyInput");
  if (input) input.value = currentProductQty;
}

/** 从详情页下单（仅金币支付） */
async function placeOrderFromDetail() {
  const modal = document.getElementById("shopDetailModal");
  if (!modal) return;
  if (!state.user) return showToast("请先登录");
  const itemKey = modal.dataset.itemKey;
  const itemType = modal.dataset.itemType || "physical";
  const price = Number(modal.dataset.productPrice || 0);
  const qty = Math.max(1, Number(document.getElementById("qtyInput")?.value || 1));
  const total = price * qty;
  const coins = state.user?.coins ?? 0;

  if (!itemKey) return showToast("商品信息缺失，请刷新后重试");
  if (coins < total) {
    showToast(`金币不足！需要 ${total} 金币，当前 ${coins} 金币`);
    openModal("wallet");
    return;
  }

  try {
    let data = null;
    if (itemType === "virtual") {
      data = await API.purchase(itemKey);
    } else {
      const receiver_name = document.getElementById("afName")?.value?.trim() || state.user.nickname || "";
      const receiver_phone = document.getElementById("afPhone")?.value?.trim() || state.user.phone || "";
      const receiver_address = document.getElementById("afAddr")?.value?.trim() || "";
      if (!receiver_name || !receiver_phone || !receiver_address) {
        showToast("请填写收件人、手机号和收货地址");
        return;
      }
      data = await API.orderPhysical({ item_key: itemKey, quantity: qty, receiver_name, receiver_phone, receiver_address });
    }
    if (!data) return;
    modal.classList.add("hidden");
    const okModal = document.getElementById("shopOrderOkModal");
    if (okModal) {
      const totalEl = okModal.querySelector(".oo-total");
      if (totalEl) totalEl.textContent = `${total} 金币`;
      openModal("shopOrderOkModal");
    }
    showToast(itemType === "virtual" ? "购买成功，已到账！" : "下单成功！");
    await loadWallet();
    await loadProfile();
    await loadShopProducts(currentShopCategory);
  } catch (e) {
    showToast("网络错误，请稍后重试");
  }
}

/* ====== #3 语音房辅助函数 ====== */

/** 创建并进入语音房 */
async function createAndEnterRoom(topic, type) {
  if (!state.user) return showToast("请先登录");
  if (state.user.is_realname === 0) {
    // 降级为提示但不阻止——后端允许未实名用户创建
    showToast("建议先实名认证再开播，送礼/充值/匹配仍需实名");
  }
  const submitBtn = document.getElementById("submitCreateRoom");
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "创建中..."; }
  try {
    const payload = { topic: String(topic || "深夜聊天").trim().slice(0, 200), category: "闲聊", room_type: type || "multi" };
    const res = await fetch("/api/voice/rooms/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data = { success: false };
    try { data = JSON.parse(text); } catch {}
    if (res.ok && data.success && (data.data?.id || data.data?.room_id)) {
      const rid = data.data.id || data.data.room_id;
      showToast("房间创建成功！正在进入...");
      await enterVoiceRoom(rid);
    } else {
      showToast(data.error || `创建失败 (HTTP ${res.status})`);
    }
  } catch (e) {
    showToast("网络错误，请稍后重试");
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fa-solid fa-play"></i> 立即开播'; }
  }
}

/** 进入语音房 */
async function enterVoiceRoom(roomId) {
  if (!state.user) return showToast("请先登录");
  try {
    const createModal = document.getElementById("createRoomModal");
    if (createModal) createModal.classList.add("hidden");
    const joinRes = await fetch(`/api/voice/rooms/${roomId}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    const joinData = await joinRes.json();
    if (!joinData.success) {
      showToast(joinData.error || "进入房间失败");
    }
    state.currentRoom = { id: roomId };
    openModal("roomModal");
    const topicEl = document.querySelector("#roomModal .room-topic");
    if (topicEl && typeof roomId === "string") topicEl.textContent = roomId;
    showToast("已进入房间");
  } catch (e) {
    showToast("网络错误");
  }
}

/* ====== #6 实时定位 ====== */
async function initDeviceLocation() {
  if (!navigator.geolocation) return;
  const profileLocationEl = document.querySelector(".profile-meta-row .meta-item:first-child");
  const matchLocationEl = document.querySelector("#view-match .match-location");
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      const text = `📍 ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
      if (profileLocationEl) profileLocationEl.innerHTML = `<i class="fa-solid fa-location-dot"></i> ${text}`;
      if (matchLocationEl) matchLocationEl.innerHTML = `<i class="fa-solid fa-location-crosshairs"></i> ${text}`;
      try {
        await fetch("/api/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ lat: latitude, lng: longitude }),
        });
      } catch {}
      await loadNearby();
    },
    (err) => { console.warn("定位失败:", err.message); },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 300000 }
  );
}
window.initDeviceLocation = initDeviceLocation;

/* ====== #9 查看用户资料 ====== */
async function openUserProfile(userId) {
  if (!userId) return;
  try {
    const res = await fetch(`/api/users/${userId}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    const data = await res.json();
    if (!data.success) return showToast(data.error || "无法加载用户资料");
    switchView("profile");
    state.viewingUser = data.data;
    await loadProfile(data.data);
  } catch (e) {
    showToast("加载失败");
  }
}
window.openUserProfile = openUserProfile;

