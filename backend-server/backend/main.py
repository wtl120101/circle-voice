"""圈圈语音社：FastAPI + SQLAlchemy + WebSocket 全功能本地后端。"""

import asyncio
import hashlib
import hmac
import json
import math
import os
import random
import shutil
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

# 优先从项目根目录 .env 加载环境变量（便于本地配置支付密钥等，不入库）
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import (
    Column, DateTime, Float, Integer, MetaData, String, Table, Text,
    UniqueConstraint, and_, case, create_engine, delete, desc, func,
    insert, or_, select, text, update,
)
from sqlalchemy.event import listens_for

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "circle_voice.db"
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DB_PATH.as_posix()}")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)
elif DATABASE_URL.startswith("mysql://"):
    DATABASE_URL = DATABASE_URL.replace("mysql://", "mysql+pymysql://", 1)

TOKEN_SECRET = os.getenv("TOKEN_SECRET", "circle_voice_local_secret_2026")
TOKEN_EXPIRE_HOURS = 72
# 静态文件目录：优先使用环境变量 STATIC_DIR，否则按本地目录结构推断
STATIC_DIR = Path(os.getenv("STATIC_DIR", str(BASE_DIR.parent.parent / "frontend-netlify")))

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
)
metadata = MetaData()

# 全局验证码存储（生产版：短信通道下发；本地调试可从 response 查看）
phone_codes: dict[str, str] = {}
# 平台钱包 — 礼物收益分成中的 70% 归平台（本地内存计数器）
PLATFORM_WALLET = {"coins": 0}
# 管理员鉴权：通过 /api/admin/login 用账号密码换取带过期时间的签名 token
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
# 管理员密码哈希（启动时由明文密码加盐生成，内存中不保留明文）
ADMIN_PASSWORD_HASH = hashlib.sha256(
    (os.getenv("ADMIN_PASSWORD", "CircleVoice@2026") + TOKEN_SECRET).encode()
).hexdigest()
# 管理员 token 有效期（小时）
ADMIN_TOKEN_EXPIRE_HOURS = int(os.getenv("ADMIN_TOKEN_EXPIRE_HOURS", "2"))
# 登录失败计数（防暴力破解）：{ip: [失败时间戳, ...]}
_admin_login_failures: dict[str, list[float]] = {}
# 单 IP 每分钟最大登录尝试次数
ADMIN_LOGIN_MAX_ATTEMPTS = 5

# ============== 支付配置（微信支付 V3 / 支付宝） ==============
# 优先级：数据库 system_config 表 > 环境变量(.env) > 默认值
# 后台可通过 /api/admin/pay-config 编辑，无需重启服务。
_pay_config_cache = {"data": None, "ts": 0}
_PAY_CONFIG_TTL = 10  # 缓存秒数，后台保存后最多 10 秒生效


def get_pay_config() -> dict:
    """读取支付配置：优先数据库，其次环境变量，最后默认值。带内存缓存。"""
    import time as _time
    now = _time.time()
    cached = _pay_config_cache.get("data")
    if cached and (now - _pay_config_cache.get("ts", 0)) < _PAY_CONFIG_TTL:
        return cached
    cfg = dict(PAY_CONFIG_DEFAULTS)
    # 环境变量兜底（兼容旧部署）
    env_map = {
        "pay_enabled": os.getenv("PAY_ENABLED", "false"),
        "pay_notify_base": os.getenv("PAY_NOTIFY_BASE", "http://127.0.0.1:8000"),
        "wx_appid": os.getenv("WX_APPID", ""),
        "wx_mchid": os.getenv("WX_MCHID", ""),
        "wx_api_v3_key": os.getenv("WX_API_V3_KEY", ""),
        "wx_serial_no": os.getenv("WX_SERIAL_NO", ""),
        "wx_private_key": os.getenv("WX_PRIVATE_KEY", ""),
        "ali_appid": os.getenv("ALI_APPID", ""),
        "ali_private_key": os.getenv("ALI_PRIVATE_KEY", ""),
        "ali_public_key": os.getenv("ALI_PUBLIC_KEY", ""),
        "ali_gateway": os.getenv("ALI_GATEWAY", PAY_CONFIG_DEFAULTS["ali_gateway"]),
    }
    for k, v in env_map.items():
        if v:
            cfg[k] = v
    # 数据库覆盖（后台编辑的值优先）
    try:
        with engine.connect() as conn:
            rows = conn.execute(select(system_config)).mappings().all()
            for row in rows:
                key = row["config_key"]
                if key in cfg:
                    val = row["config_value"]
                    if val is not None:
                        cfg[key] = val
    except Exception as e:
        print(f"[pay] 读取数据库支付配置失败（使用环境变量）: {e}")
    _pay_config_cache["data"] = cfg
    _pay_config_cache["ts"] = now
    return cfg


def invalidate_pay_config_cache():
    """后台保存配置后调用，强制下次读取刷新。"""
    _pay_config_cache["data"] = None
    _pay_config_cache["ts"] = 0


def is_pay_enabled() -> bool:
    return get_pay_config().get("pay_enabled", "false").lower() in ("1", "true", "yes")


def make_order_no(prefix: str = "CV") -> str:
    """生成唯一订单号：前缀 + 时间戳 + 4位随机数"""
    return f"{prefix}{datetime.now().strftime('%Y%m%d%H%M%S')}{random.randint(1000, 9999)}"


def _get_wx_pay():
    """初始化微信支付客户端（仅在配置完整时）"""
    cfg = get_pay_config()
    appid = cfg.get("wx_appid", "")
    mchid = cfg.get("wx_mchid", "")
    api_v3_key = cfg.get("wx_api_v3_key", "")
    serial_no = cfg.get("wx_serial_no", "")
    private_key = cfg.get("wx_private_key", "")
    if not all([appid, mchid, api_v3_key, serial_no, private_key]):
        return None
    try:
        from wechatpayv3 import WeChatPay, WeChatPayType
        return WeChatPay(
            wechatpay_type=WeChatPayType.NATIVE,
            mchid=mchid, private_key=private_key,
            cert_serial_no=serial_no, appid=appid, apiv3_key=api_v3_key,
            notify_url=f"{cfg.get('pay_notify_base', 'http://127.0.0.1:8000')}/api/pay/wechat/notify",
        )
    except Exception as e:
        print(f"[pay] 微信支付初始化失败: {e}")
        return None


def _get_ali_pay():
    """初始化支付宝客户端（仅在配置完整时）"""
    cfg = get_pay_config()
    appid = cfg.get("ali_appid", "")
    private_key = cfg.get("ali_private_key", "")
    public_key = cfg.get("ali_public_key", "")
    if not all([appid, private_key, public_key]):
        return None
    notify_base = cfg.get("pay_notify_base", "http://127.0.0.1:8000")
    try:
        from alipay import AliPay
        return AliPay(
            appid=appid,
            app_notify_url=f"{notify_base}/api/pay/alipay/notify",
            app_private_key_string=private_key,
            alipay_public_key_string=public_key,
            sign_type="RSA2", debug=False,
        )
    except Exception as e:
        print(f"[pay] 支付宝初始化失败: {e}")
        return None


def wx_native_pay(out_trade_no: str, amount_yuan: float, description: str) -> dict:
    """微信支付 Native 下单，返回 code_url 用于生成二维码"""
    wx = _get_wx_pay()
    if not wx:
        return {"enabled": False, "reason": "微信支付未配置"}
    notify_url = f"{get_pay_config().get('pay_notify_base', 'http://127.0.0.1:8000')}/api/pay/wechat/notify"
    code, message = wx.pay(
        description=description, out_trade_no=out_trade_no,
        amount=int(amount_yuan * 100), notify_url=notify_url,
    )
    if code == 200:
        data = json.loads(message)
        return {"enabled": True, "code_url": data.get("code_url")}
    return {"enabled": True, "error": message}


def ali_wap_pay(out_trade_no: str, amount_yuan: float, subject: str) -> dict:
    """支付宝 WAP 支付，返回支付跳转 URL"""
    ali = _get_ali_pay()
    if not ali:
        return {"enabled": False, "reason": "支付宝未配置"}
    cfg = get_pay_config()
    notify_base = cfg.get("pay_notify_base", "http://127.0.0.1:8000")
    gateway = cfg.get("ali_gateway", PAY_CONFIG_DEFAULTS["ali_gateway"])
    order_string = ali.api_alipay_trade_wap_pay(
        out_trade_no=out_trade_no, total_amount=str(amount_yuan),
        subject=subject,
        notify_url=f"{notify_base}/api/pay/alipay/notify",
        return_url=f"{notify_base}/#/wallet",
    )
    pay_url = f"{gateway}?{order_string}"
    return {"enabled": True, "pay_url": pay_url}


def hash_admin_token():
    """生成带过期时间的管理员签名 token。"""
    expire = int(time.time()) + ADMIN_TOKEN_EXPIRE_HOURS * 3600
    signature = hmac.new(TOKEN_SECRET.encode(), f"admin.{expire}".encode(), hashlib.sha256).hexdigest()[:32]
    return f"admin.{expire}.{signature}"


def verify_admin_token(token):
    """校验管理员 token 的签名和有效期。"""
    try:
        parts = token.split(".")
        if len(parts) != 3 or parts[0] != "admin":
            return False
        _, expire, signature = parts
        if int(expire) < time.time():
            return False
        expected = hmac.new(TOKEN_SECRET.encode(), f"admin.{expire}".encode(), hashlib.sha256).hexdigest()[:32]
        return hmac.compare_digest(expected, signature)
    except (ValueError, TypeError, AttributeError):
        return False


def _get_client_ip(request: Request):
    """从请求中提取客户端 IP（兼容反向代理）。"""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def require_admin(request: Request, authorization: str = Header(default="")):
    """管理员鉴权：仅校验带签名和有效期的 admin token，无后门。"""
    token = (authorization or "").replace("Bearer ", "").strip()
    if not token or not verify_admin_token(token):
        raise HTTPException(status_code=403, detail="管理员权限不足或登录已过期")
    return {"role": "admin", "ip": _get_client_ip(request)}


@listens_for(engine, "connect")
def configure_sqlite(dbapi_connection, _):
    if engine.dialect.name != "sqlite":
        return
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.close()


users = Table(
    "users", metadata,
    Column("id", Integer, primary_key=True),
    Column("phone", String(32), unique=True),
    Column("nickname", String(80), nullable=False),
    Column("avatar", Text),
    Column("bio", Text),
    Column("gender", String(16), default="secret"),
    Column("age", Integer),
    Column("location", String(80)),
    Column("lat", Float), Column("lng", Float),
    Column("is_vip", Integer, default=0),
    Column("vip_expire", String(40)),
    Column("coins", Integer, default=128),
    Column("diamonds", Integer, default=0),
    Column("is_realname", Integer, default=0),
    Column("realname_status", Integer, default=0),
    Column("is_banned", Integer, default=0),
    Column("ban_reason", String(200), default=""),
    Column("likes_count", Integer, default=0),
    Column("followers_count", Integer, default=0),
    Column("following_count", Integer, default=0),
    Column("created_at", DateTime, default=datetime.now),
)
matches = Table(
    "matches", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, nullable=False),
    Column("target_id", Integer, nullable=False),
    Column("action", String(16), nullable=False),
    Column("matched", Integer, default=0),
    Column("created_at", DateTime, default=datetime.now),
)
circles = Table(
    "circles", metadata,
    Column("id", Integer, primary_key=True),
    Column("name", String(120), nullable=False),
    Column("icon", String(32)),
    Column("members", Integer, default=0),
    Column("created_at", DateTime, default=datetime.now),
)
posts = Table(
    "posts", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, nullable=False),
    Column("title", String(120)),
    Column("content", Text),
    Column("image", Text),
    Column("images", Text),
    Column("video_url", Text),
    Column("post_type", String(20), default="text"),
    Column("location", String(80)),
    Column("circle_id", Integer),
    Column("likes", Integer, default=0),
    Column("comments", Integer, default=0),
    Column("created_at", DateTime, default=datetime.now),
)
voice_rooms = Table(
    "voice_rooms", metadata,
    Column("id", Integer, primary_key=True),
    Column("host_id", Integer, nullable=False),
    Column("topic", String(200), nullable=False),
    Column("category", String(60)),
    Column("listeners", Integer, default=0),
    Column("status", String(20), default="live"),
    Column("room_type", String(20), default="multi"),
    Column("background_music", Text),
    Column("current_song", Text),
    Column("mini_game", String(40)),
    Column("cover_image", Text),
    Column("started_at", DateTime, default=datetime.now),
)
chat_conversations = Table(
    "chat_conversations", metadata,
    Column("id", Integer, primary_key=True),
    Column("user1_id", Integer, nullable=False),
    Column("user2_id", Integer, nullable=False),
    Column("created_at", DateTime, default=datetime.now),
    UniqueConstraint("user1_id", "user2_id", name="uq_conversation_pair"),
)
chat_messages = Table(
    "chat_messages", metadata,
    Column("id", Integer, primary_key=True),
    Column("conversation_id", Integer, nullable=False),
    Column("sender_id", Integer, nullable=False),
    Column("content", Text, nullable=False),
    Column("msg_type", String(20), default="text"),
    Column("created_at", DateTime, default=datetime.now),
    Column("read", Integer, default=0),
)
notifications = Table(
    "notifications", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, nullable=False),
    Column("from_user_id", Integer),
    Column("type", String(30), nullable=False),
    Column("content", Text),
    Column("is_read", Integer, default=0),
    Column("created_at", DateTime, default=datetime.now),
)
orders = Table(
    "orders", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, nullable=False),
    Column("plan", String(40), nullable=False),
    Column("pay_method", String(30)),
    Column("amount", Float, nullable=False),
    Column("status", String(20), default="pending"),
    Column("out_trade_no", String(64), unique=True),
    Column("created_at", DateTime, default=datetime.now),
)
tasks = Table(
    "tasks", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, nullable=False),
    Column("task_key", String(50), nullable=False),
    Column("completed", Integer, default=0),
    Column("reward", Integer),
    Column("created_at", DateTime, default=datetime.now),
)
post_likes = Table(
    "post_likes", metadata,
    Column("id", Integer, primary_key=True),
    Column("post_id", Integer, nullable=False),
    Column("user_id", Integer, nullable=False),
    Column("created_at", DateTime, default=datetime.now),
    UniqueConstraint("post_id", "user_id", name="uq_post_like"),
)
post_comments = Table(
    "post_comments", metadata,
    Column("id", Integer, primary_key=True),
    Column("post_id", Integer, nullable=False),
    Column("user_id", Integer, nullable=False),
    Column("content", Text, nullable=False),
    Column("created_at", DateTime, default=datetime.now),
)
follows = Table(
    "follows", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, nullable=False),
    Column("target_id", Integer, nullable=False),
    Column("created_at", DateTime, default=datetime.now),
    UniqueConstraint("user_id", "target_id", name="uq_follow_pair"),
)
user_blocks = Table(
    "user_blocks", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, nullable=False),
    Column("blocked_id", Integer, nullable=False),
    Column("created_at", DateTime, default=datetime.now),
    UniqueConstraint("user_id", "blocked_id", name="uq_user_block_pair"),
)
circle_members = Table(
    "circle_members", metadata,
    Column("id", Integer, primary_key=True),
    Column("circle_id", Integer, nullable=False),
    Column("user_id", Integer, nullable=False),
    Column("created_at", DateTime, default=datetime.now),
    UniqueConstraint("circle_id", "user_id", name="uq_circle_member"),
)
room_messages = Table(
    "room_messages", metadata,
    Column("id", Integer, primary_key=True),
    Column("room_id", Integer, nullable=False),
    Column("user_id", Integer, nullable=False),
    Column("content", Text, nullable=False),
    Column("msg_type", String(20), default="text"),
    Column("gift_key", String(30)),
    Column("gift_name", String(50)),
    Column("gift_emoji", String(16)),
    Column("gift_count", Integer, default=0),
    Column("gift_price", Integer, default=0),
    Column("gift_currency", String(10), default="coins"),
    Column("created_at", DateTime, default=datetime.now),
)
room_visits = Table(
    "room_visits", metadata,
    Column("id", Integer, primary_key=True),
    Column("room_id", Integer, nullable=False),
    Column("user_id", Integer, nullable=False),
    Column("visited_on", String(10), nullable=False),
    Column("created_at", DateTime, default=datetime.now),
    UniqueConstraint("room_id", "user_id", "visited_on", name="uq_room_visit_day"),
)
wallet_transactions = Table(
    "wallet_transactions", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, nullable=False),
    Column("kind", String(30), nullable=False),
    Column("coins", Integer, default=0),
    Column("amount", Float, default=0),
    Column("currency", String(10), default="coins"),
    Column("note", String(200)),
    Column("created_at", DateTime, default=datetime.now),
)
task_claims = Table(
    "task_claims", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, nullable=False),
    Column("task_key", String(40), nullable=False),
    Column("claim_date", String(10), nullable=False),
    Column("reward", Integer, nullable=False),
    Column("created_at", DateTime, default=datetime.now),
    UniqueConstraint("user_id", "task_key", "claim_date", name="uq_task_claim_day"),
)

# ---------- 系统配置（支付密钥等后台可编辑项） ----------
system_config = Table(
    "system_config", metadata,
    Column("config_key", String(80), primary_key=True),
    Column("config_value", Text, default=""),
    Column("updated_at", DateTime, default=datetime.now, onupdate=datetime.now),
)

# 支付配置默认值（后台未设置时使用，均为空表示未配置）
PAY_CONFIG_DEFAULTS = {
    "pay_enabled": "false",
    "pay_notify_base": "",
    "wx_appid": "",
    "wx_mchid": "",
    "wx_api_v3_key": "",
    "wx_serial_no": "",
    "wx_private_key": "",
    "ali_appid": "",
    "ali_private_key": "",
    "ali_public_key": "",
    "ali_gateway": "https://openapi.alipay.com/gateway.do",
}

# ---------- 好感度系统 ----------
user_favorites = Table(
    "user_favorites", metadata,
    Column("id", Integer, primary_key=True),
    Column("from_user_id", Integer, nullable=False),
    Column("to_user_id", Integer, nullable=False),
    Column("value", Integer, default=0),
    Column("gifts_sent", Integer, default=0),
    Column("gifts_received", Integer, default=0),
    Column("chat_days", Integer, default=0),
    Column("voice_days", Integer, default=0),
    Column("updated_at", DateTime, default=datetime.now),
    Column("created_at", DateTime, default=datetime.now),
    UniqueConstraint("from_user_id", "to_user_id", name="uq_favorites_pair"),
)

user_relationships = Table(
    "user_relationships", metadata,
    Column("id", Integer, primary_key=True),
    Column("user1_id", Integer, nullable=False),
    Column("user2_id", Integer, nullable=False),
    Column("rel_type", String(20), nullable=False),   # couple / bestie / bro / confidant
    Column("favorability", Integer, default=0),
    Column("status", String(16), default="active"),    # active / broken
    Column("bound_at", DateTime, default=datetime.now),
    Column("broken_at", DateTime),
    UniqueConstraint("user1_id", "user2_id", "rel_type", name="uq_relationship_pair"),
)

# ---------- 商城与道具 ----------
shop_items = Table(
    "shop_items", metadata,
    Column("id", Integer, primary_key=True),
    Column("item_key", String(40), unique=True, nullable=False),
    Column("name", String(80), nullable=False),
    Column("icon", String(32)),
    Column("category", String(20), default="gift"),   # gift / title / avatar_frame / bubble / effect
    Column("type", String(20), default="virtual"),      # virtual / physical
    Column("price", Integer, default=0),
    Column("origin_price", Integer, default=0),
    Column("stock", Integer, default=-1),              # -1=无限
    Column("image_url", Text),
    Column("description", Text),
    Column("favorability_boost", Integer, default=0),  # 赠送时增加的好感度
    Column("unlock_favorability", Integer, default=0),  # 绑定关系后解锁所需好感度
    Column("sales", Integer, default=0),
    Column("specs", Text),
    Column("ship_from", String(80)),
    Column("currency", String(10), default="coins"),
    Column("available", Integer, default=1),
    Column("created_at", DateTime, default=datetime.now),
)

user_items = Table(
    "user_items", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, nullable=False),
    Column("shop_item_id", Integer, nullable=False),
    Column("source", String(20), default="gift"),       # gift / purchase / bind / redeem
    Column("from_user_id", Integer),
    Column("quantity", Integer, default=1),
    Column("is_active", Integer, default=0),
    Column("expires_at", DateTime),
    Column("acquired_at", DateTime, default=datetime.now),
    UniqueConstraint("user_id", "shop_item_id", "from_user_id", name="uq_user_item"),
)

user_titles = Table(
    "user_titles", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, nullable=False),
    Column("shop_item_id", Integer, nullable=False),
    Column("is_active", Integer, default=0),
    Column("expires_at", DateTime),
    Column("acquired_at", DateTime, default=datetime.now),
    UniqueConstraint("user_id", "shop_item_id", name="uq_user_title"),
)

RELATION_TYPES = {
    "couple":        {"name": "情侣",     "favorability_required": 200, "icon": "💏", "color": "#ec4899"},
    "spouse":        {"name": "夫妻",     "favorability_required": 500, "icon": "💍", "color": "#db2777"},
    "bestie":        {"name": "闺蜜",     "favorability_required": 80,  "icon": "👯", "color": "#f472b6"},
    "sisterhood":    {"name": "姐妹淘",   "favorability_required": 120, "icon": "👭", "color": "#fb7185"},
    "bro":           {"name": "兄弟",     "favorability_required": 80,  "icon": "🤝", "color": "#60a5fa"},
    "brotherhood":   {"name": "铁哥们",   "favorability_required": 120, "icon": "🫡", "color": "#3b82f6"},
    "confidant":     {"name": "知己",     "favorability_required": 60,  "icon": "🌸", "color": "#a78bfa"},
    "soulmate":      {"name": "灵魂伴侣", "favorability_required": 300, "icon": "💫", "color": "#8b5cf6"},
    "mentor":        {"name": "师父/徒弟", "favorability_required": 150, "icon": "🎓", "color": "#f59e0b"},
    "colleague":     {"name": "同事搭子", "favorability_required": 100, "icon": "💼", "color": "#64748b"},
    "roommate":      {"name": "室友",     "favorability_required": 90,  "icon": "🏠", "color": "#10b981"},
    "childhood":     {"name": "发小",     "favorability_required": 180, "icon": "🧒", "color": "#14b8a6"},
}

FAVORABILITY_BY_ACTION = {
    "send_gift":       lambda price, count: max(1, price // 2) * count,
    "chat_message":    1,     # 每条私聊消息
    "voice_room":      5,     # 同在一个语音房 30 分钟
    "enter_voice":     2,     # 进房互相关注
    "call":            10,    # 成功通话
    "match":           20,    # 互相匹配
}

AVATARS = [f"/api/avatars/{index}.svg" for index in range(8)]

# ============== 礼物系统：金币礼物 vs 钻石礼物 ==============
# 金币礼物：玩家充值获得金币送，房主有 30% 收益，平台 70%
# 钻石礼物：钻石为免费赠送（签到/任务），只能送钻石礼物，房主无收益

COIN_GIFTS = {
    # —— 便宜小礼物 ——
    "heart":      {"name": "爱心",       "emoji": "💝", "price": 1,   "favorability": 1},
    "flower":     {"name": "小花",       "emoji": "🌸", "price": 2,   "favorability": 1},
    "cookie":     {"name": "饼干",       "emoji": "🍪", "price": 3,   "favorability": 2},
    "coffee":     {"name": "咖啡",       "emoji": "☕", "price": 5,   "favorability": 3},
    "cake":       {"name": "蛋糕",       "emoji": "🍰", "price": 8,   "favorability": 4},
    "rose":       {"name": "玫瑰",       "emoji": "🌹", "price": 10,  "favorability": 5},
    "teddy":      {"name": "小熊",       "emoji": "🧸", "price": 15,  "favorability": 8},
    "balloon":    {"name": "气球",       "emoji": "🎈", "price": 20,  "favorability": 10},
    "crown_small": {"name": "小皇冠",    "emoji": "👑", "price": 30,  "favorability": 15},
    # —— 中等礼物 ——
    "box":        {"name": "礼盒",       "emoji": "🎁", "price": 50,  "favorability": 25},
    "rocket":     {"name": "火箭",       "emoji": "🚀", "price": 66,  "favorability": 33},
    "wine":       {"name": "红酒",       "emoji": "🍷", "price": 88,  "favorability": 44},
    "mic":        {"name": "话筒",       "emoji": "🎤", "price": 100, "favorability": 50},
    "trophy":     {"name": "奖杯",       "emoji": "🏆", "price": 188, "favorability": 94},
    "guitar":     {"name": "吉他",       "emoji": "🎸", "price": 200, "favorability": 100},
    "camera":     {"name": "相机",       "emoji": "📷", "price": 288, "favorability": 144},
    "piano":      {"name": "钢琴",       "emoji": "🎹", "price": 388, "favorability": 194},
    # —— 豪华大礼物 ——
    "rainbow":    {"name": "彩虹",       "emoji": "🌈", "price": 520, "favorability": 260},
    "gold_bull":  {"name": "金牛",       "emoji": "🐂", "price": 666, "favorability": 333},
    "gold_coin":  {"name": "金币堆",     "emoji": "💰", "price": 888, "favorability": 444},
    "dragon":     {"name": "金龙",       "emoji": "🐉", "price": 999, "favorability": 500},
    "luxury_car": {"name": "跑车",       "emoji": "🏎️", "price": 1314,"favorability": 657},
    "yacht":      {"name": "游艇",       "emoji": "🛥️", "price": 1888,"favorability": 944},
    "castle":     {"name": "城堡",       "emoji": "🏰", "price": 5200,"favorability": 2600},
    "starry_sky": {"name": "星空",       "emoji": "🌌", "price": 9999,"favorability": 5000},
}

# 钻石礼物（只有几个，钻石免费赠送，房主无收益）
DIAMOND_GIFTS = {
    "diamond_heart": {"name": "钻石心",  "emoji": "💎", "price": 10,  "favorability": 2},
    "diamond_ring":  {"name": "钻戒",    "emoji": "💍", "price": 50,  "favorability": 10},
    "diamond_star":  {"name": "星钻",    "emoji": "⭐", "price": 100, "favorability": 20},
}

# 统一访问：GIFTS[key] = {**coin_or_diamond_meta, "currency": "coins"/"diamonds", "can_earn": True/False}
GIFTS = {}
for k, v in COIN_GIFTS.items():
    GIFTS[k] = {**v, "currency": "coins", "can_earn": True}
for k, v in DIAMOND_GIFTS.items():
    GIFTS[k] = {**v, "currency": "diamonds", "can_earn": False}

# ============== 商城：实物商品为主（类京东/拼多多） ==============
# type: physical=实物  virtual=虚拟（称号/头像框/特效）
# 实物字段: stock=-1 表示无限库存；image_url 自动用文字生成占位图

SHOP_PRODUCTS = [
    # —— 3C 数码 ——
    {"item_key": "phone_iphone",     "name": "iPhone 15 Pro Max", "icon": "📱", "category": "digital", "type": "physical", "price": 9999, "origin_price": 10999, "stock": 50, "ship_from": "上海",  "description": "A17 Pro 芯片，钛金属设计，潜望长焦", "specs": "颜色:原色钛金属/蓝色钛金属/白色钛金属; 存储:256G/512G/1T"},
    {"item_key": "phone_xiaomi",     "name": "小米 14 Ultra",    "icon": "📲", "category": "digital", "type": "physical", "price": 6499, "origin_price": 7299, "stock": 80, "ship_from": "北京",  "description": "徕卡影像，骁龙 8 Gen3，2K 屏", "specs": "颜色:黑色/白色/绿色; 存储:12+256G/16+512G"},
    {"item_key": "headphone_sony",   "name": "索尼 WH-1000XM5",  "icon": "🎧", "category": "digital", "type": "physical", "price": 2499, "origin_price": 2999, "stock": 120, "ship_from": "深圳", "description": "旗舰降噪耳机，30 小时续航", "specs": "颜色:黑色/银色"},
    {"item_key": "laptop_macbook",   "name": "MacBook Air M3",   "icon": "💻", "category": "digital", "type": "physical", "price": 8999, "origin_price": 9499, "stock": 30, "ship_from": "上海",  "description": "M3 芯片，13.6 英寸 Liquid Retina 屏", "specs": "颜色:午夜色/星光色/银色; 存储:512G/1T"},
    {"item_key": "watch_apple",      "name": "Apple Watch S9",   "icon": "⌚", "category": "digital", "type": "physical", "price": 2899, "origin_price": 3199, "stock": 200, "ship_from": "广州",  "description": "S9 芯片，双指互点手势", "specs": "颜色:午夜色/星光色/银色; 尺寸:41mm/45mm"},
    {"item_key": "powerbank",        "name": "Anker 充电宝 20000mAh", "icon": "🔋", "category": "digital", "type": "physical", "price": 199, "origin_price": 299, "stock": -1, "ship_from": "深圳", "description": "PD 65W 快充，可带上飞机", "specs": "颜色:黑色/白色"},

    # —— 美妆护肤 ——
    {"item_key": "skii_facial",      "name": "SK-II 神仙水 230ml", "icon": "💧", "category": "beauty", "type": "physical", "price": 1450, "origin_price": 1650, "stock": 60, "ship_from": "上海", "description": "Pitera 精华液，改善肤质", "specs": "容量:230ml/330ml"},
    {"item_key": "lancome_lip",      "name": "兰蔻菁纯唇膏",     "icon": "💄", "category": "beauty", "type": "physical", "price": 285, "origin_price": 320, "stock": -1, "ship_from": "上海",  "description": "滋润显色，多色号可选", "specs": "色号:196/274/505/08"},
    {"item_key": "mask_skincare",    "name": "敷尔佳面膜 5 片装","icon": "🧴", "category": "beauty", "type": "physical", "price": 89,  "origin_price": 129, "stock": -1, "ship_from": "广州",  "description": "医用冷敷贴，补水修护", "specs": "规格:5片/盒"},

    # —— 服饰鞋包 ——
    {"item_key": "nike_sneaker",     "name": "Nike Air Jordan 1", "icon": "👟", "category": "fashion", "type": "physical", "price": 1299, "origin_price": 1599, "stock": 45, "ship_from": "福建", "description": "经典篮球鞋，Air 缓震", "specs": "尺码:39/40/41/42/43/44; 配色:芝加哥/黑脚趾"},
    {"item_key": "uniqlo_hoodie",    "name": "优衣库摇粒绒卫衣", "icon": "👕", "category": "fashion", "type": "physical", "price": 199, "origin_price": 299, "stock": -1, "ship_from": "杭州", "description": "秋冬保暖，男女同款", "specs": "尺码:S/M/L/XL; 颜色:黑色/灰色/卡其"},
    {"item_key": "bag_lv_mini",      "name": "LV Speedy 20",     "icon": "👜", "category": "fashion", "type": "physical", "price": 15800, "origin_price": 16800, "stock": 5, "ship_from": "上海", "description": "经典老花手提包", "specs": "颜色:老花/棋盘格"},

    # —— 食品生鲜 ——
    {"item_key": "coffee_nestle",    "name": "雀巢咖啡 速溶 100 条", "icon": "☕", "category": "food", "type": "physical", "price": 89, "origin_price": 129, "stock": -1, "ship_from": "上海", "description": "原味/特浓可选", "specs": "口味:原味/特浓/奶香"},
    {"item_key": "tea_lapsang",      "name": "正山小种红茶 250g", "icon": "🍵", "category": "food", "type": "physical", "price": 168, "origin_price": 268, "stock": -1, "ship_from": "福建", "description": "桐木关原产，桂圆香", "specs": "规格:250g/500g"},
    {"item_key": "fruit_apple",      "name": "烟台红富士苹果 5 斤", "icon": "🍎", "category": "food", "type": "physical", "price": 39, "origin_price": 59, "stock": -1, "ship_from": "山东", "description": "脆甜多汁，75mm+ 大果", "specs": "重量:5斤/10斤"},

    # —— 家居生活 ——
    {"item_key": "pillow_memory",    "name": "乳胶记忆枕",       "icon": "🛏️", "category": "home", "type": "physical", "price": 259, "origin_price": 399, "stock": -1, "ship_from": "南通", "description": "护颈助眠，天然乳胶", "specs": "颜色:白色/灰色"},
    {"item_key": "lamp_midea",       "name": "美的护眼台灯",     "icon": "💡", "category": "home", "type": "physical", "price": 129, "origin_price": 199, "stock": -1, "ship_from": "广东", "description": "LED 无频闪，多角度调节", "specs": "颜色:白色/黑色"},
    {"item_key": "towel_set",        "name": "纯棉浴巾三件套",   "icon": "🧽", "category": "home", "type": "physical", "price": 79, "origin_price": 119, "stock": -1, "ship_from": "河北", "description": "A 类婴儿级纯棉", "specs": "颜色:白色/灰色/粉色"},

    # —— 虚拟商品（称号/头像框/特效，保留少量）——
    {"item_key": "title_lone_wolf",  "name": "独行者",   "icon": "🐺", "category": "title",      "type": "virtual", "price": 300, "favorability_boost": 0, "description": "高冷独立的灵魂"},
    {"item_key": "title_crown",      "name": "王冠殿下", "icon": "👑", "category": "title",      "type": "virtual", "price": 888, "favorability_boost": 0, "description": "天生的王者气息"},
    {"item_key": "title_heart",      "name": "心动男神", "icon": "💘", "category": "title",      "type": "virtual", "price": 999, "favorability_boost": 0, "description": "让无数人怦然心动"},
    {"item_key": "frame_gold",       "name": "黄金边框", "icon": "🟡", "category": "avatar_frame", "type": "virtual", "price": 120, "favorability_boost": 0, "description": "闪耀的金色头像框"},
    {"item_key": "frame_rose",       "name": "玫瑰边框", "icon": "🌹", "category": "avatar_frame", "type": "virtual", "price": 180, "favorability_boost": 0, "description": "浪漫的玫瑰花框"},
    {"item_key": "effect_party",     "name": "派对光环", "icon": "🎉", "category": "effect",     "type": "virtual", "price": 200, "favorability_boost": 0, "description": "进房时的派对特效"},
    {"item_key": "effect_heart",     "name": "爱心雨",   "icon": "💖", "category": "effect",     "type": "virtual", "price": 380, "favorability_boost": 0, "description": "送礼时的爱心雨动效"},
]

TAG_SETS = [
    ["🎬 追剧", "🍰 美食", "🐱 养猫", "🎤 唱歌"],
    ["🎸 吉他", "🏔️ 登山", "📖 阅读"],
    ["📷 摄影", "🎨 设计", "☕ 咖啡"],
    ["🎮 游戏", "🎯 电竞", "🍜 美食"],
]


def clean_dict(mapping):
    result = {}
    for key, value in dict(mapping).items():
        if isinstance(value, datetime):
            value = value.strftime("%Y-%m-%d %H:%M:%S")
        result[key] = value
    return result


def fetch_one(conn, statement):
    row = conn.execute(statement).mappings().first()
    return clean_dict(row) if row else None


def fetch_all(conn, statement):
    return [clean_dict(row) for row in conn.execute(statement).mappings().all()]


def inserted_id(result):
    return result.inserted_primary_key[0]


def json_ok(data=None):
    return {"success": True, "data": data, "error": None}


def json_error(message, status_code=400):
    return JSONResponse({"success": False, "data": None, "error": message}, status_code=status_code)


def require_user(user):
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")
    if user.get("is_banned"):
        raise HTTPException(status_code=403, detail=f"账号已被封禁：{user.get('ban_reason') or '违反社区规则'}")
    return user


def hash_token(user_id):
    expire = int(time.time()) + TOKEN_EXPIRE_HOURS * 3600
    signature = hmac.new(TOKEN_SECRET.encode(), f"{user_id}.{expire}".encode(), hashlib.sha256).hexdigest()[:32]
    return f"{user_id}.{expire}.{signature}"


def verify_token(token):
    try:
        user_id, expire, signature = token.split(".")
        if int(expire) < time.time():
            return None
        expected = hmac.new(TOKEN_SECRET.encode(), f"{user_id}.{expire}".encode(), hashlib.sha256).hexdigest()[:32]
        return int(user_id) if hmac.compare_digest(expected, signature) else None
    except (ValueError, TypeError, AttributeError):
        return None


async def get_current_user(authorization: str = Header(default="")):
    if not authorization.startswith("Bearer "):
        return None
    user_id = verify_token(authorization[7:])
    if user_id is None:
        return None
    with engine.connect() as conn:
        return fetch_one(conn, select(users).where(users.c.id == user_id))


def public_user(row, private=False):
    if not row:
        return None
    data = clean_dict(row)
    if not private:
        data.pop("phone", None)
    data["is_vip"] = bool(data.get("is_vip"))
    data["online"] = manager.is_online(data["id"]) if "manager" in globals() else False
    return data


def get_user_required(conn, user_id):
    row = fetch_one(conn, select(users).where(users.c.id == user_id))
    if not row:
        raise HTTPException(status_code=404, detail="用户不存在")
    return row


def get_conversation_id(conn, first, second):
    low, high = sorted((first, second))
    row = fetch_one(conn, select(chat_conversations).where(
        chat_conversations.c.user1_id == low,
        chat_conversations.c.user2_id == high,
    ))
    if row:
        return row["id"]
    result = conn.execute(insert(chat_conversations).values(user1_id=low, user2_id=high))
    return inserted_id(result)


def distance_km(first, second):
    if not all(first.get(k) is not None for k in ("lat", "lng")) or not all(second.get(k) is not None for k in ("lat", "lng")):
        return 0.0
    lat1, lng1, lat2, lng2 = map(math.radians, [first["lat"], first["lng"], second["lat"], second["lng"]])
    value = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return round(6371 * 2 * math.asin(math.sqrt(value)), 1)


def create_notification(conn, user_id, from_user_id, kind, content):
    if user_id == from_user_id and kind != "system":
        return None
    result = conn.execute(insert(notifications).values(
        user_id=user_id, from_user_id=from_user_id, type=kind, content=content,
    ))
    return inserted_id(result)


async def push_notification(user_id, notification_id):
    if not notification_id:
        return
    with engine.connect() as conn:
        item = fetch_one(conn, select(notifications).where(notifications.c.id == notification_id))
    if item:
        await manager.send_user(user_id, "notification", item)


def adjust_favorability(conn, from_id, to_id, delta, gift=True):
    """增加 from_id → to_id 的好感度；同时增加反向（互有好感）。返回新增后 from->to 的值。"""
    if from_id == to_id or delta <= 0:
        return 0

    upsert_fav(conn, from_id, to_id, delta, gift)
    upsert_fav(conn, to_id, from_id, delta, False)  # 对方给送礼方也加好感（单向更多）

    row = conn.execute(
        select(user_favorites.c.value).where(
            user_favorites.c.from_user_id == from_id, user_favorites.c.to_user_id == to_id
        )
    ).scalar()
    return row or 0


def upsert_fav(conn, from_id, to_id, delta, is_gift_action):
    existing = conn.execute(
        select(user_favorites).where(
            user_favorites.c.from_user_id == from_id, user_favorites.c.to_user_id == to_id
        )
    ).mappings().first()
    if existing:
        values = {"value": user_favorites.c.value + delta, "updated_at": datetime.now()}
        if is_gift_action:
            values["gifts_sent"] = user_favorites.c.gifts_sent + 1
        conn.execute(
            update(user_favorites).where(
                user_favorites.c.from_user_id == from_id, user_favorites.c.to_user_id == to_id
            ).values(**values)
        )
    else:
        conn.execute(insert(user_favorites).values(
            from_user_id=from_id, to_user_id=to_id,
            value=delta, gifts_sent=1 if is_gift_action else 0,
            updated_at=datetime.now(), created_at=datetime.now(),
        ))


def update_relationship_on_favorability(conn, user1_id, user2_id):
    """检查是否满足绑定条件，自动创建/解除关系并解锁称号。"""
    low, high = sorted([user1_id, user2_id])

    favorite_high = conn.execute(
        select(user_favorites.c.value).where(
            user_favorites.c.from_user_id == high, user_favorites.c.to_user_id == low
        )
    ).scalar() or 0
    favorite_low = conn.execute(
        select(user_favorites.c.value).where(
            user_favorites.c.from_user_id == low, user_favorites.c.to_user_id == high
        )
    ).scalar() or 0
    mutual = favorite_high + favorite_low

    # 检查已有关系
    existing_rels = fetch_all(conn,
        select(user_relationships).where(
            or_(
                and_(user_relationships.c.user1_id == low, user_relationships.c.user2_id == high),
                and_(user_relationships.c.user1_id == high, user_relationships.c.user2_id == low),
            )
        )
    )

    new_rels = set()
    for rel_type, meta in RELATION_TYPES.items():
        if mutual >= meta["favorability_required"]:
            new_rels.add(rel_type)

    existing_map = {r["rel_type"]: r for r in existing_rels}

    for rel_type in new_rels:
        if rel_type not in existing_map or existing_map[rel_type]["status"] != "active":
            existing_row = conn.execute(
                select(user_relationships).where(
                    user_relationships.c.user1_id == low, user_relationships.c.user2_id == high,
                    user_relationships.c.rel_type == rel_type,
                )
            ).mappings().first()
            if existing_row:
                conn.execute(update(user_relationships).where(
                    user_relationships.c.id == existing_row["id"]
                ).values(
                    favorability=mutual, status="active",
                    bound_at=datetime.now(), broken_at=None,
                ))
            else:
                conn.execute(insert(user_relationships).values(
                    user1_id=low, user2_id=high, rel_type=rel_type,
                    favorability=mutual, status="active", bound_at=datetime.now(),
                ))
            # 解锁对应称号
            unlock_item_for_pair(conn, rel_type, low, high)

    for rel_type, row in existing_map.items():
        if rel_type not in new_rels and row["status"] == "active":
            conn.execute(update(user_relationships).where(
                user_relationships.c.id == row["id"]
            ).values(status="broken", broken_at=datetime.now(), favorability=mutual))

    return {"mutual": mutual, "active_relationships": list(new_rels)}


def unlock_item_for_pair(conn, rel_type, user1_id, user2_id):
    """建立关系时自动为双方解锁对应称号物品。"""
    key_map = {
        "confidant": "title_confidant",
        "bro":       "title_bro",
        "couple":    "title_couple",
        "bestie":    None,  # 闺蜜用固定名
    }
    item_key = key_map.get(rel_type)
    if rel_type == "bestie":
        item_key = "title_confidant"  # 闺蜜也用知己称号（可按需扩展）
    if not item_key:
        return

    item = fetch_one(conn, select(shop_items).where(shop_items.c.item_key == item_key))
    if not item:
        return

    for uid in (user1_id, user2_id):
        existing = conn.execute(
            select(user_items).where(user_items.c.user_id == uid, user_items.c.shop_item_id == item["id"])
        ).mappings().first()
        if not existing:
            conn.execute(insert(user_items).values(
                user_id=uid, shop_item_id=item["id"], source="bind",
                from_user_id=None, quantity=1, is_active=1,
            ))


class ConnectionManager:
    def __init__(self):
        self.user_sockets = {}
        self.socket_users = {}
        self.room_sockets = {}
        self.socket_rooms = {}
        self.room_mic = {}

    async def connect(self, websocket, user_id):
        await websocket.accept()
        self.user_sockets.setdefault(user_id, set()).add(websocket)
        self.socket_users[websocket] = user_id

    async def disconnect(self, websocket):
        user_id = self.socket_users.pop(websocket, None)
        if user_id in self.user_sockets:
            self.user_sockets[user_id].discard(websocket)
            if not self.user_sockets[user_id]:
                self.user_sockets.pop(user_id, None)
        rooms = self.socket_rooms.pop(websocket, set())
        for room_id in rooms:
            self.leave_room(websocket, room_id, user_id)
            await broadcast_room_state(room_id)
        if user_id:
            await self.broadcast_all("presence", {"user_id": user_id, "online": self.is_online(user_id)})

    def is_online(self, user_id):
        return bool(self.user_sockets.get(user_id))

    def room_user_ids(self, room_id):
        return {self.socket_users[socket] for socket in self.room_sockets.get(room_id, set()) if socket in self.socket_users}

    def room_online(self, room_id):
        return len(self.room_user_ids(room_id))

    def user_in_room(self, room_id, user_id):
        return user_id in self.room_user_ids(room_id)

    def join_room(self, websocket, room_id):
        user_id = self.socket_users[websocket]
        was_present = self.user_in_room(room_id, user_id)
        self.room_sockets.setdefault(room_id, set()).add(websocket)
        self.socket_rooms.setdefault(websocket, set()).add(room_id)
        if not was_present:
            self.room_mic.setdefault(room_id, {})[user_id] = False

    def leave_room(self, websocket, room_id, user_id=None):
        user_id = self.socket_users.get(websocket) if user_id is None else user_id
        self.room_sockets.get(room_id, set()).discard(websocket)
        self.socket_rooms.get(websocket, set()).discard(room_id)
        if user_id is not None and not self.user_in_room(room_id, user_id):
            self.room_mic.get(room_id, {}).pop(user_id, None)

    def set_room_mic(self, room_id, user_id, enabled):
        self.room_mic.setdefault(room_id, {})[user_id] = bool(enabled)

    async def send_socket(self, websocket, event_type, data):
        try:
            await websocket.send_json({"type": event_type, "data": data})
        except (RuntimeError, WebSocketDisconnect):
            pass

    async def send_user(self, user_id, event_type, data):
        for websocket in list(self.user_sockets.get(user_id, set())):
            await self.send_socket(websocket, event_type, data)

    async def send_room_user(self, room_id, user_id, event_type, data):
        for websocket in list(self.room_sockets.get(room_id, set())):
            if self.socket_users.get(websocket) == user_id:
                await self.send_socket(websocket, event_type, data)

    async def broadcast_room(self, room_id, event_type, data):
        for websocket in list(self.room_sockets.get(room_id, set())):
            await self.send_socket(websocket, event_type, data)

    async def broadcast_all(self, event_type, data):
        for websocket in list(self.socket_users):
            await self.send_socket(websocket, event_type, data)


manager = ConnectionManager()


async def broadcast_room_state(room_id):
    user_ids = manager.room_user_ids(room_id)
    rows = []
    if user_ids:
        with engine.connect() as conn:
            rows = fetch_all(conn, select(users).where(users.c.id.in_(user_ids)))
    mic_states = manager.room_mic.get(room_id, {})
    roster = [{
        "id": row["id"], "nickname": row["nickname"], "avatar": row["avatar"],
        "is_vip": bool(row["is_vip"]), "mic": bool(mic_states.get(row["id"])),
    } for row in sorted(rows, key=lambda item: item["id"])]
    online = len(roster)
    await manager.broadcast_room(room_id, "room.presence", {"room_id": room_id, "online": online})
    await manager.broadcast_room(room_id, "room.roster", {"room_id": room_id, "online": online, "users": roster})


def init_database():
    metadata.create_all(engine)
    with engine.begin() as conn:
        # 创建 migrate.py 中定义但不在 metadata 中的表
        conn.execute(text("""CREATE TABLE IF NOT EXISTS real_names (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            real_name VARCHAR(40) NOT NULL,
            id_card VARCHAR(30) NOT NULL,
            phone VARCHAR(20),
            face_image TEXT,
            status INTEGER DEFAULT 0,
            reject_reason VARCHAR(200),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            verified_at DATETIME
        )"""))
        conn.execute(text("""CREATE TABLE IF NOT EXISTS product_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_no VARCHAR(32) UNIQUE NOT NULL,
            user_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,
            quantity INTEGER DEFAULT 1,
            unit_price INTEGER NOT NULL,
            total_price INTEGER NOT NULL,
            currency VARCHAR(10) DEFAULT 'coins',
            receiver_name VARCHAR(40),
            receiver_phone VARCHAR(20),
            receiver_address TEXT,
            status VARCHAR(20) DEFAULT 'pending',
            tracking_no VARCHAR(40),
            remark VARCHAR(200),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            paid_at DATETIME,
            shipped_at DATETIME,
            completed_at DATETIME
        )"""))
        conn.execute(text("""CREATE TABLE IF NOT EXISTS recharge_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_no VARCHAR(32) UNIQUE NOT NULL,
            user_id INTEGER NOT NULL,
            product_key VARCHAR(40) NOT NULL,
            coins INTEGER NOT NULL,
            bonus_coins INTEGER DEFAULT 0,
            amount REAL NOT NULL,
            pay_method VARCHAR(20),
            status VARCHAR(20) DEFAULT 'pending',
            paid_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )"""))
        conn.execute(text("""CREATE TABLE IF NOT EXISTS bgm_tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title VARCHAR(120) NOT NULL,
            artist VARCHAR(80),
            url TEXT NOT NULL,
            cover TEXT,
            duration INTEGER,
            category VARCHAR(40),
            plays INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )"""))
        conn.execute(text("""CREATE TABLE IF NOT EXISTS mini_games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_key VARCHAR(40) UNIQUE NOT NULL,
            name VARCHAR(80) NOT NULL,
            icon VARCHAR(32),
            description TEXT,
            max_players INTEGER DEFAULT 8,
            min_players INTEGER DEFAULT 2,
            available INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )"""))
        # 迁移：为已有 orders 表补充 out_trade_no 列
        cols = [row[1] for row in conn.execute(text("PRAGMA table_info(orders)")).fetchall()]
        if "out_trade_no" not in cols:
            conn.execute(text("ALTER TABLE orders ADD COLUMN out_trade_no VARCHAR(64)"))
        # 迁移：为 users 表补充 is_banned 列
        ucols = [row[1] for row in conn.execute(text("PRAGMA table_info(users)")).fetchall()]
        if "is_banned" not in ucols:
            conn.execute(text("ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0"))
        if "ban_reason" not in ucols:
            conn.execute(text("ALTER TABLE users ADD COLUMN ban_reason VARCHAR(200)"))
        # 初始化支付配置默认项（不存在则插入，已存在不覆盖）
        for key, default_val in PAY_CONFIG_DEFAULTS.items():
            exists = conn.execute(select(system_config).where(system_config.c.config_key == key)).first()
            if not exists:
                conn.execute(insert(system_config).values(
                    config_key=key, config_value=default_val, updated_at=datetime.now(),
                ))
        if conn.execute(select(func.count(users.c.id))).scalar() == 0:
            seed_users = [
                ("13800000001", "电竞老王", AVATARS[0], "晚上一起LOL开黑！", "male", 24, "上海", 31.23, 121.47, 0, 128),
                ("13800000002", "奶糖不加冰", AVATARS[1], "🍬 甜度满分的甜妹一枚", "female", 22, "北京", 39.90, 116.40, 1, 680),
                ("13800000003", "独立音乐人阿树", AVATARS[2], "🎸 用音乐讲故事", "male", 26, "成都", 30.57, 104.07, 0, 256),
                ("13800000004", "小鹿乱撞", AVATARS[3], "咖啡控 · 摄影爱好者", "female", 23, "上海", 31.25, 121.48, 0, 96),
                ("13800000005", "南城以北", AVATARS[4], "登山徒步 · 热爱生活", "male", 28, "深圳", 22.54, 114.06, 1, 320),
                ("13800000006", "画画的阿猫", AVATARS[5], "🎨 自由插画师", "female", 25, "杭州", 30.27, 120.15, 0, 188),
                ("13800000007", "糖糖酱", AVATARS[6], "可盐可甜", "female", 21, "北京", 39.92, 116.42, 0, 64),
                ("13800000008", "清风明月", AVATARS[7], "极简主义", "male", 27, "成都", 30.60, 104.10, 0, 48),
                ("13800000000", "我（你）", AVATARS[0], "👋 欢迎来到圈圈语音社！", "secret", 25, "上海", 31.23, 121.47, 1, 999),
            ]
            conn.execute(insert(users), [dict(zip(
                ("phone", "nickname", "avatar", "bio", "gender", "age", "location", "lat", "lng", "is_vip", "coins"), row,
            )) for row in seed_users])

        user_rows = fetch_all(conn, select(users))
        for row in user_rows:
            if not row.get("avatar") or row["avatar"].startswith("https://trae-api-cn.mchost.guru/"):
                row["avatar"] = AVATARS[(row["id"] - 1) % len(AVATARS)]
                conn.execute(update(users).where(users.c.id == row["id"]).values(avatar=row["avatar"]))
        user_ids = {row["phone"]: row["id"] for row in user_rows}
        if not user_ids:
            return

        if conn.execute(select(func.count(circles.c.id))).scalar() == 0:
            conn.execute(insert(circles), [
                {"name": "LOL英雄联盟圈", "icon": "🎮", "members": 128430},
                {"name": "独立音乐分享圈", "icon": "🎵", "members": 86543},
                {"name": "二次元同好圈", "icon": "🌸", "members": 253210},
                {"name": "单身交友圈", "icon": "💕", "members": 189432},
                {"name": "摄影交流圈", "icon": "📷", "members": 56789},
                {"name": "旅行攻略圈", "icon": "✈️", "members": 78123},
            ])
        circle_rows = fetch_all(conn, select(circles))
        circle_ids = {row["name"]: row["id"] for row in circle_rows}

        if conn.execute(select(func.count(posts.c.id))).scalar() == 0:
            seed_posts = [
                ("13800000001", "今晚LOL开黑，缺个辅助位！来个会玩的，赢了发红包 🎮💸", "上海", "LOL英雄联盟圈", 128, 46),
                ("13800000002", "有人今晚一起连麦看恐怖片吗？我带爆米花🍿 一个人看真的好怕 😭", "北京", "二次元同好圈", 342, 89),
                ("13800000003", "新写了一首歌《凌晨三点的风》，欢迎来我语音房听Demo，给点意见～🎧", "成都", "独立音乐分享圈", 1200, 234),
                ("13800000006", "今天画了一张新插画，欢迎来看看！", "杭州", "摄影交流圈", 567, 89),
                ("13800000007", "周末一起去探店！有推荐的吗？", "北京", "单身交友圈", 89, 23),
                ("13800000008", "周末徒步组队，有兴趣的私！", "成都", "旅行攻略圈", 12, 3),
            ]
            conn.execute(insert(posts), [{
                "user_id": user_ids[phone], "content": content, "location": location,
                "circle_id": circle_ids.get(circle), "likes": likes, "comments": comments,
                "created_at": datetime.now() - timedelta(minutes=index * 17 + 3),
            } for index, (phone, content, location, circle, likes, comments) in enumerate(seed_posts)])

        if conn.execute(select(func.count(voice_rooms.c.id))).scalar() == 0:
            seed_rooms = [
                ("13800000001", "深夜情感电台 · 聊心事 💔", "情感", 1234),
                ("13800000001", "LOL五黑 · 缺一个打野 🎮", "游戏", 876),
                ("13800000003", "唱歌交友 · 点歌就唱 🎤", "音乐", 542),
                ("13800000006", "读书会 · 今晚读《百年孤独》📖", "读书", 328),
                ("13800000002", "ASMR助眠 · 温柔耳语 🌙", "深夜电台", 189),
                ("13800000005", "探店分享 · 成都美食地图 🍜", "美食", 267),
            ]
            conn.execute(insert(voice_rooms), [{
                "host_id": user_ids[phone], "topic": topic, "category": category, "listeners": listeners,
                "started_at": datetime.now() - timedelta(hours=index + 1),
            } for index, (phone, topic, category, listeners) in enumerate(seed_rooms)])

        demo_id = user_ids.get("13800000000")
        if not demo_id:
            return
        if conn.execute(select(func.count(matches.c.id))).scalar() == 0:
            reverse_likes = [user_ids[p] for p in ("13800000002", "13800000008") if p in user_ids]
            for target_id in reverse_likes:
                conn.execute(insert(matches).values(user_id=target_id, target_id=demo_id, action="like"))
            peer_id = user_ids.get("13800000007")
            if peer_id:
                conn.execute(insert(matches).values(user_id=demo_id, target_id=peer_id, action="like", matched=1))
                conn.execute(insert(matches).values(user_id=peer_id, target_id=demo_id, action="like", matched=1))

        if conn.execute(select(func.count(chat_conversations.c.id))).scalar() == 0:
            demo_messages = {
                "13800000007": ["嘿！你也喜欢看恐怖片吗 😱", "今晚可以一起连麦看呀！"],
                "13800000008": ["周末徒步还缺人吗？", "装备已经准备好了。"],
                "13800000006": ["你的插画真好看！", "谢谢，欢迎来圈子交流。"],
            }
            for phone, contents in demo_messages.items():
                peer_id = user_ids.get(phone)
                if not peer_id:
                    continue
                conversation_id = get_conversation_id(conn, demo_id, peer_id)
                for index, content in enumerate(contents):
                    conn.execute(insert(chat_messages).values(
                        conversation_id=conversation_id,
                        sender_id=peer_id if index % 2 == 0 else demo_id,
                        content=content,
                        created_at=datetime.now() - timedelta(minutes=20 - index * 4),
                        read=0 if index % 2 == 0 else 1,
                    ))

        if conn.execute(select(func.count(notifications.c.id))).scalar() == 0:
            conn.execute(insert(notifications).values(
                user_id=demo_id, from_user_id=None, type="system", content="欢迎来到圈圈语音社，完成每日任务可以获得钻石。",
            ))

        if conn.execute(select(func.count(room_messages.c.id))).scalar() == 0:
            first_room = fetch_one(conn, select(voice_rooms).order_by(voice_rooms.c.id).limit(1))
            peer_id = user_ids.get("13800000004")
            if first_room and peer_id:
                conn.execute(insert(room_messages).values(
                    room_id=first_room["id"], user_id=peer_id, content="大家好，欢迎来到语音房！",
                ))

        # 商城种子数据：实物商品 + 虚拟称号/头像框/特效 + 金币/钻石礼物
        if conn.execute(select(func.count(shop_items.c.id))).scalar() == 0:
            all_shop = []
            # 1. 礼物（金币礼物 + 钻石礼物）
            for gift_key, gift in GIFTS.items():
                all_shop.append({
                    "item_key": f"gift_{gift_key}",
                    "name": gift["name"],
                    "icon": gift["emoji"],
                    "category": "gift",
                    "type": "virtual",
                    "price": gift["price"],
                    "origin_price": 0,
                    "stock": -1,
                    "image_url": None,
                    "currency": gift["currency"],
                    "favorability_boost": gift["favorability"],
                    "unlock_favorability": 0,
                    "sales": 0,
                    "specs": None,
                    "ship_from": None,
                    "available": 1,
                    "created_at": datetime.now(),
                    "description": f"送出「{gift['name']}」可增加双方好感度",
                })
            # 2. 实物商品 + 虚拟道具（已统一到 SHOP_PRODUCTS）
            for p in SHOP_PRODUCTS:
                row = dict(p)
                # 补齐 shop_items 表所有列的默认值，避免批量插入时部分字典缺键
                row.setdefault("category", "gift")
                row.setdefault("type", "virtual")
                row.setdefault("origin_price", 0)
                row.setdefault("stock", -1)
                row.setdefault("image_url", None)
                row.setdefault("description", "")
                row.setdefault("favorability_boost", 0)
                row.setdefault("unlock_favorability", 0)
                row.setdefault("sales", 0)
                row.setdefault("specs", None)
                row.setdefault("ship_from", None)
                row.setdefault("currency", "coins")
                row.setdefault("available", 1)
                row.setdefault("created_at", datetime.now())
                all_shop.append(row)
            conn.execute(insert(shop_items), all_shop)

        # 写入 BGM 种子
        bgm_count = conn.execute(text("SELECT COUNT(*) FROM bgm_tracks")).scalar()
        if bgm_count == 0:
            conn.execute(text("""INSERT INTO bgm_tracks (title, artist, url, category) VALUES
                ('夜曲','周杰伦','','流行'),
                ('晴天','周杰伦','','流行'),
                ('稻香','周杰伦','','流行'),
                ('起风了','买辣椒也用券','','流行'),
                ('漠河舞厅','柳爽','','民谣'),
                ('成都','赵雷','','民谣'),
                ('天空之城','久石让','','纯音乐'),
                ('卡农','Pachelbel','','古典')"""))

        # 写入多人小游戏种子
        game_count = conn.execute(text("SELECT COUNT(*) FROM mini_games")).scalar()
        if game_count == 0:
            conn.execute(text("""INSERT INTO mini_games (game_key, name, icon, description, min_players, max_players) VALUES
                ('truth_or_dare','真心话大冒险','🎭','经典聚会游戏',2,12),
                ('number_bomb','数字炸弹','💣','猜数字，踩中炸弹者接受惩罚',2,20),
                ('song_guess','猜歌名','🎵','播放片段猜歌名',2,16),
                ('werewolf','狼人杀','🐺','经典推理游戏',6,12),
                ('who_am_i','你画我猜','🎨','一人描述一人猜',2,8)"""))


init_database()

app = FastAPI(title="圈圈语音社 API", version="2.0.0")
# CORS：限制为本地开发和部署域名，不再全开放
CORS_ORIGINS = [
    o.strip() for o in os.getenv("CORS_ORIGINS", "http://127.0.0.1:8000,http://localhost:8000").split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS, allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# 反向代理头：让 FastAPI 正确识别 Nginx 转发的 HTTPS 协议与客户端 IP
try:
    from fastapi.middleware.proxy_headers import ProxyHeadersMiddleware
    app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=["*"])
except ImportError:
    pass


@app.exception_handler(HTTPException)
async def http_exception_handler(_, exc):
    return json_error(str(exc.detail), exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_, exc):
    return json_error("请求参数不完整或格式不正确", 422)


class LoginReq(BaseModel):
    phone: str = Field(min_length=5, max_length=32)
    nickname: Optional[str] = Field(default=None, max_length=80)
    code: Optional[str] = Field(default=None, max_length=8)
    captcha: Optional[str] = Field(default=None, max_length=8)


class OauthLoginReq(BaseModel):
    provider: str  # wechat / qq / apple
    openid: str = Field(min_length=6, max_length=128)
    nickname: Optional[str] = Field(default=None, max_length=80)
    avatar: Optional[str] = Field(default=None, max_length=255)
    gender: Optional[str] = None


class ProfileReq(BaseModel):
    nickname: Optional[str] = Field(default=None, min_length=1, max_length=80)
    bio: Optional[str] = Field(default=None, max_length=500)
    gender: Optional[str] = None
    age: Optional[int] = Field(default=None, ge=18, le=100)
    location: Optional[str] = Field(default=None, max_length=80)
    lat: Optional[float] = None
    lng: Optional[float] = None
    avatar: Optional[str] = None


class PostReq(BaseModel):
    title: Optional[str] = Field(default=None, max_length=120)
    content: str = Field(min_length=1, max_length=500)
    images: Optional[str] = None          # JSON 数组字符串，多图
    image: Optional[str] = None           # 单图兼容
    video_url: Optional[str] = None
    location: Optional[str] = None
    circle_id: Optional[int] = None


class RealnameSubmitReq(BaseModel):
    real_name: str = Field(min_length=2, max_length=40)
    id_card: str = Field(min_length=15, max_length=30)
    face_image: Optional[str] = None


class VoiceRoomCreateReq(BaseModel):
    topic: str = Field(min_length=2, max_length=200)
    category: str = Field(default="情感", max_length=60)
    room_type: str = Field(default="multi", max_length=20)    # single / multi
    background_music: Optional[str] = None
    cover_image: Optional[str] = None


class ShopOrderReq(BaseModel):
    item_key: str
    quantity: int = Field(default=1, ge=1, le=99)
    receiver_name: Optional[str] = None
    receiver_phone: Optional[str] = None
    receiver_address: Optional[str] = None
    remark: Optional[str] = None


class CommentReq(BaseModel):
    content: str = Field(min_length=1, max_length=300)


class MatchReq(BaseModel):
    target_id: int
    action: str


class ChatSendReq(BaseModel):
    target_id: int
    content: str = Field(min_length=1, max_length=2_000_000)
    msg_type: str = "text"


class VipPayReq(BaseModel):
    plan: str
    pay_method: str = "wechat"


class RechargeReq(BaseModel):
    coins: int
    pay_method: str = "wechat"


class RoomReq(BaseModel):
    topic: str = Field(min_length=2, max_length=200)
    category: str = Field(default="情感", max_length=60)


class RoomMessageReq(BaseModel):
    content: str = Field(min_length=1, max_length=500)


class GiftReq(BaseModel):
    gift_key: str
    count: int = Field(default=1, ge=1, le=99)


class CircleReq(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    icon: str = Field(default="💬", max_length=32)


class ShopPurchaseReq(BaseModel):
    item_key: str


class RelationshipReq(BaseModel):
    target_id: int
    rel_type: str


class TitleActivateReq(BaseModel):
    item_key: str


@app.get("/api/health")
async def health():
    return json_ok({
        "status": "ok", "time": datetime.now().isoformat(), "database": engine.dialect.name,
        "online_users": len(manager.user_sockets),
    })


@app.get("/api/avatars/{avatar_id}.svg")
async def avatar_illustration(avatar_id: int):
    palettes = [
        ("#312e81", "#a855f7", "#f4c7a1", "#20243a"),
        ("#831843", "#ec4899", "#f6c9a8", "#672143"),
        ("#0c4a6e", "#38bdf8", "#eec29e", "#172554"),
        ("#065f46", "#34d399", "#f3c5a5", "#7c2d12"),
        ("#7c2d12", "#fb923c", "#dcb18e", "#1f2937"),
        ("#4c1d95", "#c084fc", "#f0c6a7", "#3f2d20"),
        ("#9f1239", "#fb7185", "#f7cfb3", "#501724"),
        ("#164e63", "#22d3ee", "#e5b995", "#111827"),
    ]
    background, accent, skin, hair = palettes[avatar_id % len(palettes)]
    variant = avatar_id % 4
    fringe = [
        '<path d="M28 50Q31 18 64 18t36 32Q82 33 65 37 45 26 28 50" fill="%s"/>' % hair,
        '<path d="M27 52Q24 16 64 16t38 36Q83 30 65 29 47 48 27 52" fill="%s"/>' % hair,
        '<path d="M26 50Q29 17 63 17t39 33Q79 27 59 38 45 28 26 50" fill="%s"/>' % hair,
        '<path d="M28 48Q32 18 64 18t36 30Q84 35 72 31 54 45 28 48" fill="%s"/>' % hair,
    ][variant]
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="圈圈用户头像">
<defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="{background}"/><stop offset="1" stop-color="{accent}"/></linearGradient></defs>
<rect width="128" height="128" rx="24" fill="url(#bg)"/><circle cx="103" cy="22" r="18" fill="#fff" opacity=".1"/><circle cx="19" cy="108" r="27" fill="#fff" opacity=".08"/>
<path d="M22 128q3-38 42-38t42 38" fill="{accent}"/><path d="M52 78h24v20H52z" fill="{skin}"/>
<ellipse cx="64" cy="53" rx="35" ry="39" fill="{skin}"/>{fringe}
<ellipse cx="51" cy="55" rx="3" ry="4" fill="#27243a"/><ellipse cx="77" cy="55" rx="3" ry="4" fill="#27243a"/>
<path d="M55 70q9 8 18 0" fill="none" stroke="#a85555" stroke-width="3" stroke-linecap="round"/>
<path d="M38 88q26 20 52 0l9 40H29z" fill="{accent}"/><path d="M53 91l11 10 11-10" fill="none" stroke="#fff" stroke-width="3" opacity=".7"/>
</svg>'''
    return Response(content=svg, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})


@app.post("/api/auth/send-code")
async def send_code(req: dict):
    """发送验证码：生成 6 位验证码，通过短信通道下发（生产版对接短信 SDK）。"""
    phone = str(req.get("phone") or "").strip()
    if not phone or len(phone) < 6 or len(phone) > 20 or not phone.isdigit():
        return json_error("手机号格式不正确")
    code = f"{random.randint(0, 999999):06d}"
    phone_codes[phone] = code  # 内存存储，5 分钟有效
    # 生产版：调用短信 SDK 下发验证码；dev_code 仅在本地调试时返回，便于联调
    return json_ok({"expire": 300, "dev_code": code})


@app.post("/api/auth/login")
async def login(req: LoginReq):
    phone = req.phone.strip()
    # 验证码校验（未传验证码时放行，方便联调）
    supplied = req.code or req.captcha
    if supplied:
        expected = phone_codes.get(phone)
        if not expected:
            return json_error("请先获取验证码")
        if supplied != expected:
            return json_error("验证码错误")
        phone_codes.pop(phone, None)

    with engine.begin() as conn:
        user = fetch_one(conn, select(users).where(users.c.phone == phone))
        if not user:
            nickname = (req.nickname or f"用户{phone[-4:]}").strip()
            result = conn.execute(insert(users).values(
                phone=phone, nickname=nickname, avatar=AVATARS[len(phone) % len(AVATARS)],
                bio="这个人很神秘，还没有填写简介。", coins=128,
            ))
            user = fetch_one(conn, select(users).where(users.c.id == inserted_id(result)))
    return json_ok({"token": hash_token(user["id"]), "token_type": "Bearer", "user": public_user(user, True)})


@app.post("/api/auth/oauth")
async def oauth_login(req: OauthLoginReq):
    """第三方登录（模拟实现：openid 存到 users.oauth_{provider}_openid）。"""
    if req.provider not in ("wechat", "qq", "apple"):
        return json_error("不支持的第三方平台")
    oauth_col = f"oauth_{req.provider}_openid"

    # 预先确保所有 3 个 oauth 列都存在（只做一次）
    with engine.begin() as conn:
        for p in ("wechat", "qq", "apple"):
            col = f"oauth_{p}_openid"
            existing = conn.execute(text(f"PRAGMA table_info(users)")).mappings().all()
            col_names = {row["name"] for row in existing}
            if col not in col_names:
                conn.execute(text(f"ALTER TABLE users ADD COLUMN {col} VARCHAR(128)"))

        # 查找已有用户
        find_stmt = text(f"SELECT * FROM users WHERE {oauth_col} = :oid")
        result = conn.execute(find_stmt.bindparams(oid=req.openid)).mappings().first()

        is_new = False
        if result:
            user = dict(result)
        else:
            new_phone = f"{req.provider[:2]}{abs(hash(req.openid)) % 10**10:010d}"
            nickname = req.nickname or f"{req.provider}用户"
            avatar = req.avatar or AVATARS[abs(hash(req.openid)) % len(AVATARS)]
            gender = req.gender if req.gender in ("male", "female", "secret") else "secret"
            conn.execute(text(
                f"INSERT INTO users (phone, nickname, avatar, bio, gender, coins, {oauth_col}) "
                f"VALUES (:ph, :nk, :av, '第三方登录用户', :gd, 128, :oid)"
            ).bindparams(ph=new_phone, nk=nickname, av=avatar, gd=gender, oid=req.openid))
            user = dict(conn.execute(select(users).where(users.c.phone == new_phone)).mappings().first())
            is_new = True

    return json_ok({"token": hash_token(user["id"]), "token_type": "Bearer",
                    "user": public_user(user, True), "is_new": is_new})


@app.get("/api/auth/me")
async def me(user=Depends(get_current_user)):
    require_user(user)
    return json_ok(public_user(user, True))


@app.patch("/api/profile")
async def update_profile(req: ProfileReq, user=Depends(get_current_user)):
    require_user(user)
    values = req.model_dump(exclude_none=True)
    if not values:
        return json_ok(public_user(user, True))
    with engine.begin() as conn:
        conn.execute(update(users).where(users.c.id == user["id"]).values(**values))
        updated = fetch_one(conn, select(users).where(users.c.id == user["id"]))
    return json_ok(public_user(updated, True))


@app.get("/api/profile")
async def profile(user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        user_posts = fetch_all(conn, select(posts).where(posts.c.user_id == user["id"]).order_by(desc(posts.c.created_at)).limit(20))
        post_count = conn.execute(select(func.count(posts.c.id)).where(posts.c.user_id == user["id"])).scalar()
        room_count = conn.execute(select(func.count(voice_rooms.c.id)).where(voice_rooms.c.host_id == user["id"])).scalar()
        gift_count = conn.execute(
            select(func.coalesce(func.sum(room_messages.c.gift_count), 0))
            .select_from(room_messages.join(voice_rooms, room_messages.c.room_id == voice_rooms.c.id))
            .where(voice_rooms.c.host_id == user["id"])
        ).scalar()
    data = public_user(user, True)
    data.update({"posts": user_posts, "post_count": post_count, "room_count": room_count, "gift_count": gift_count or 0})
    return json_ok(data)


@app.get("/api/users/nearby")
async def nearby_users(user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        rows = fetch_all(conn, select(users).where(users.c.id != user["id"]).limit(100))
        following = {row["target_id"] for row in fetch_all(conn, select(follows).where(follows.c.user_id == user["id"]))}
    result = []
    for row in rows:
        item = public_user(row)
        item["distance_km"] = distance_km(user, row)
        item["following"] = row["id"] in following
        result.append(item)
    result.sort(key=lambda item: item["distance_km"])
    return json_ok(result[:20])


@app.get("/api/users/{user_id}")
async def get_user(user_id: int):
    with engine.connect() as conn:
        row = get_user_required(conn, user_id)
    return json_ok(public_user(row))


@app.post("/api/users/{user_id}/follow")
async def follow_user(user_id: int, user=Depends(get_current_user)):
    require_user(user)
    if user_id == user["id"]:
        return json_error("不能关注自己")
    notification_id = None
    with engine.begin() as conn:
        get_user_required(conn, user_id)
        existing = fetch_one(conn, select(follows).where(follows.c.user_id == user["id"], follows.c.target_id == user_id))
        if existing:
            conn.execute(delete(follows).where(follows.c.id == existing["id"]))
            conn.execute(update(users).where(users.c.id == user_id).values(followers_count=case((users.c.followers_count > 0, users.c.followers_count - 1), else_=0)))
            conn.execute(update(users).where(users.c.id == user["id"]).values(following_count=case((users.c.following_count > 0, users.c.following_count - 1), else_=0)))
            following = False
        else:
            conn.execute(insert(follows).values(user_id=user["id"], target_id=user_id))
            conn.execute(update(users).where(users.c.id == user_id).values(followers_count=users.c.followers_count + 1))
            conn.execute(update(users).where(users.c.id == user["id"]).values(following_count=users.c.following_count + 1))
            notification_id = create_notification(conn, user_id, user["id"], "follow", f"{user['nickname']} 关注了你")
            following = True
    await push_notification(user_id, notification_id)
    return json_ok({"following": following})


@app.get("/api/search")
async def global_search(q: str = Query(default="", max_length=100), user=Depends(get_current_user)):
    require_user(user)
    keyword = q.strip()
    if not keyword:
        return json_ok({"users": [], "posts": [], "circles": [], "rooms": []})
    pattern = f"%{keyword}%"
    with engine.connect() as conn:
        user_rows = fetch_all(conn, select(users).where(or_(users.c.nickname.like(pattern), users.c.bio.like(pattern))).limit(8))
        post_rows = fetch_all(conn, select(posts, users.c.nickname, users.c.avatar).join(users, posts.c.user_id == users.c.id).where(posts.c.content.like(pattern)).order_by(desc(posts.c.created_at)).limit(8))
        circle_rows = fetch_all(conn, select(circles).where(circles.c.name.like(pattern)).limit(8))
        room_rows = fetch_all(conn, select(voice_rooms).where(voice_rooms.c.topic.like(pattern), voice_rooms.c.status == "live").limit(8))
    return json_ok({
        "users": [public_user(row) for row in user_rows], "posts": post_rows,
        "circles": circle_rows, "rooms": room_rows,
    })


def feed_page(conn, page, size, current_user, circle_id=None, tab="recommend"):
    filters = []
    if circle_id is not None:
        filters.append(posts.c.circle_id == circle_id)
    if tab == "city" and current_user.get("location"):
        filters.append(posts.c.location == current_user["location"])
    if tab == "following":
        filters.append(posts.c.user_id.in_(select(follows.c.target_id).where(follows.c.user_id == current_user["id"])))
    where = and_(*filters) if filters else True
    total = conn.execute(select(func.count(posts.c.id)).where(where)).scalar()
    statement = select(posts, users.c.nickname, users.c.avatar).join(users, posts.c.user_id == users.c.id).where(where)
    statement = statement.order_by(desc(posts.c.created_at)).limit(size).offset((page - 1) * size)
    items = fetch_all(conn, statement)
    liked = {row["post_id"] for row in fetch_all(conn, select(post_likes).where(post_likes.c.user_id == current_user["id"]))}
    for item in items:
        item["liked"] = item["id"] in liked
        item["comments_list"] = fetch_all(conn, select(post_comments, users.c.nickname, users.c.avatar).join(users, post_comments.c.user_id == users.c.id).where(post_comments.c.post_id == item["id"]).order_by(desc(post_comments.c.id)).limit(3))
    return {"items": items, "total": total, "page": page, "size": size, "pages": math.ceil(total / size) if total else 0}


@app.get("/api/feed/discover")
async def discover(page: int = 1, size: int = 20, tab: str = "recommend", user=Depends(get_current_user)):
    require_user(user)
    page, size = max(page, 1), min(max(size, 1), 50)
    with engine.connect() as conn:
        result = feed_page(conn, page, size, user, tab=tab)
    return json_ok(result)


@app.post("/api/feed/post")
async def create_post(req: PostReq, user=Depends(get_current_user)):
    require_user(user)
    with engine.begin() as conn:
        result = conn.execute(insert(posts).values(
            user_id=user["id"], content=req.content.strip(), image=req.image,
            location=req.location or user.get("location"), circle_id=req.circle_id,
        ))
        post_id = inserted_id(result)
        item = fetch_one(conn, select(posts, users.c.nickname, users.c.avatar).join(users, posts.c.user_id == users.c.id).where(posts.c.id == post_id))
    item.update({"liked": False, "comments_list": []})
    await manager.broadcast_all("feed.new", item)
    return json_ok(item)


@app.post("/api/feed/post/{post_id}/like")
async def like_post(post_id: int, user=Depends(get_current_user)):
    require_user(user)
    notification_id = None
    with engine.begin() as conn:
        post = fetch_one(conn, select(posts).where(posts.c.id == post_id))
        if not post:
            raise HTTPException(status_code=404, detail="动态不存在")
        existing = fetch_one(conn, select(post_likes).where(post_likes.c.post_id == post_id, post_likes.c.user_id == user["id"]))
        if existing:
            conn.execute(delete(post_likes).where(post_likes.c.id == existing["id"]))
            conn.execute(update(posts).where(posts.c.id == post_id).values(likes=case((posts.c.likes > 0, posts.c.likes - 1), else_=0)))
            liked = False
        else:
            conn.execute(insert(post_likes).values(post_id=post_id, user_id=user["id"]))
            conn.execute(update(posts).where(posts.c.id == post_id).values(likes=posts.c.likes + 1))
            notification_id = create_notification(conn, post["user_id"], user["id"], "like", f"{user['nickname']} 给你的动态点了赞")
            liked = True
        likes = conn.execute(select(posts.c.likes).where(posts.c.id == post_id)).scalar()
    await push_notification(post["user_id"], notification_id)
    return json_ok({"liked": liked, "likes": likes})


@app.get("/api/feed/post/{post_id}/comments")
async def comments(post_id: int, user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        items = fetch_all(conn, select(post_comments, users.c.nickname, users.c.avatar).join(users, post_comments.c.user_id == users.c.id).where(post_comments.c.post_id == post_id).order_by(post_comments.c.id))
    return json_ok(items)


@app.post("/api/feed/post/{post_id}/comments")
async def add_comment(post_id: int, req: CommentReq, user=Depends(get_current_user)):
    require_user(user)
    with engine.begin() as conn:
        post = fetch_one(conn, select(posts).where(posts.c.id == post_id))
        if not post:
            raise HTTPException(status_code=404, detail="动态不存在")
        result = conn.execute(insert(post_comments).values(post_id=post_id, user_id=user["id"], content=req.content.strip()))
        conn.execute(update(posts).where(posts.c.id == post_id).values(comments=posts.c.comments + 1))
        notification_id = create_notification(conn, post["user_id"], user["id"], "comment", f"{user['nickname']} 评论了你的动态：{req.content[:80]}")
        item = fetch_one(conn, select(post_comments, users.c.nickname, users.c.avatar).join(users, post_comments.c.user_id == users.c.id).where(post_comments.c.id == inserted_id(result)))
        count = conn.execute(select(posts.c.comments).where(posts.c.id == post_id)).scalar()
    await push_notification(post["user_id"], notification_id)
    return json_ok({"comment": item, "comments": count})


@app.get("/api/match/cards")
async def match_cards(gender: str = "", max_age: int = 100, max_distance: float = 20000, user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        rows = fetch_all(conn, select(users).where(
            users.c.id != user["id"],
            ~users.c.id.in_(select(matches.c.target_id).where(matches.c.user_id == user["id"])),
        ))
    items = []
    for row in rows:
        if gender in ("male", "female") and row.get("gender") != gender:
            continue
        if row.get("age") and row["age"] > max_age:
            continue
        distance = distance_km(user, row)
        if distance > max_distance:
            continue
        item = public_user(row)
        item["distance_km"] = distance
        item["match_rate"] = 75 + ((user["id"] * 7 + row["id"] * 3) % 24)
        item["tags"] = TAG_SETS[row["id"] % len(TAG_SETS)]
        items.append(item)
    random.shuffle(items)
    return json_ok(items[:20])


@app.post("/api/match/action")
async def match_action(req: MatchReq, user=Depends(get_current_user)):
    require_user(user)
    if req.action not in ("like", "pass", "super"):
        return json_error("未知匹配操作")
    if req.target_id == user["id"]:
        return json_error("不能匹配自己")
    notification_ids = []
    with engine.begin() as conn:
        target = get_user_required(conn, req.target_id)
        existing = fetch_one(conn, select(matches).where(matches.c.user_id == user["id"], matches.c.target_id == req.target_id))
        is_like = req.action in ("like", "super")
        reverse = fetch_one(conn, select(matches).where(
            matches.c.user_id == req.target_id, matches.c.target_id == user["id"], matches.c.action.in_(["like", "super"]),
        )) if is_like else None
        matched = bool(reverse)
        values = {"action": req.action, "matched": int(matched), "created_at": datetime.now()}
        if existing:
            conn.execute(update(matches).where(matches.c.id == existing["id"]).values(**values))
        else:
            conn.execute(insert(matches).values(user_id=user["id"], target_id=req.target_id, **values))
        if matched:
            conn.execute(update(matches).where(matches.c.id == reverse["id"]).values(matched=1))
            get_conversation_id(conn, user["id"], req.target_id)
            notification_ids.append((req.target_id, create_notification(conn, req.target_id, user["id"], "match", f"你和 {user['nickname']} 互相喜欢了！")))
            notification_ids.append((user["id"], create_notification(conn, user["id"], req.target_id, "match", f"你和 {target['nickname']} 互相喜欢了！")))
        elif is_like:
            notification_ids.append((req.target_id, create_notification(conn, req.target_id, user["id"], "like", f"{user['nickname']} 喜欢了你")))
    for target_user_id, notification_id in notification_ids:
        await push_notification(target_user_id, notification_id)
    if matched:
        await manager.send_user(req.target_id, "match.success", {"user": public_user(user)})
    return json_ok({"matched": matched, "target": public_user(target)})


@app.delete("/api/match/action/{target_id}")
async def undo_match_action(target_id: int, user=Depends(get_current_user)):
    require_user(user)
    with engine.begin() as conn:
        conn.execute(delete(matches).where(matches.c.user_id == user["id"], matches.c.target_id == target_id))
    return json_ok({"undone": True})


@app.get("/api/match/list")
async def my_matches(user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        rows = fetch_all(conn, select(matches, users.c.id.label("peer_id"), users.c.nickname, users.c.avatar).join(users, matches.c.target_id == users.c.id).where(
            matches.c.user_id == user["id"], matches.c.matched == 1,
        ).order_by(desc(matches.c.created_at)).limit(50))
    for row in rows:
        row["id"] = row["peer_id"]
    return json_ok(rows)


def room_payload(conn, row):
    host = fetch_one(conn, select(users).where(users.c.id == row["host_id"]))
    item = clean_dict(row)
    item["host_nickname"] = host["nickname"] if host else "未知主播"
    item["host_avatar"] = host["avatar"] if host else AVATARS[0]
    item["online"] = manager.room_online(row["id"])
    return item


@app.get("/api/voice/rooms")
async def voice_rooms_api(category: Optional[str] = None, followed: bool = False, user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        statement = select(voice_rooms).where(voice_rooms.c.status == "live")
        if category:
            statement = statement.where(voice_rooms.c.category == category)
        if followed:
            statement = statement.where(voice_rooms.c.host_id.in_(select(follows.c.target_id).where(follows.c.user_id == user["id"])))
        rows = fetch_all(conn, statement.order_by(desc(voice_rooms.c.listeners)))
        return json_ok([room_payload(conn, row) for row in rows])


@app.post("/api/voice/rooms")
async def create_voice_room(req: RoomReq, user=Depends(get_current_user)):
    require_user(user)
    with engine.begin() as conn:
        result = conn.execute(insert(voice_rooms).values(host_id=user["id"], topic=req.topic.strip(), category=req.category.strip()))
        room = fetch_one(conn, select(voice_rooms).where(voice_rooms.c.id == inserted_id(result)))
        payload = room_payload(conn, room)
    await manager.broadcast_all("voice.new", payload)
    return json_ok(payload)


def record_room_visit(conn, room_id, user_id):
    today = datetime.now().strftime("%Y-%m-%d")
    existing = fetch_one(conn, select(room_visits).where(
        room_visits.c.room_id == room_id, room_visits.c.user_id == user_id, room_visits.c.visited_on == today,
    ))
    if not existing:
        conn.execute(insert(room_visits).values(room_id=room_id, user_id=user_id, visited_on=today))


@app.post("/api/voice/rooms/{room_id}/join")
async def join_voice_room(room_id: int, user=Depends(get_current_user)):
    require_user(user)
    with engine.begin() as conn:
        room = fetch_one(conn, select(voice_rooms).where(voice_rooms.c.id == room_id, voice_rooms.c.status == "live"))
        if not room:
            raise HTTPException(status_code=404, detail="语音房不存在或已关闭")
        record_room_visit(conn, room_id, user["id"])
    return json_ok({"joined": True, "room_id": room_id})


@app.get("/api/voice/rooms/{room_id}/messages")
async def voice_room_messages(room_id: int, user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        rows = fetch_all(conn, select(room_messages, users.c.nickname, users.c.avatar).join(users, room_messages.c.user_id == users.c.id).where(room_messages.c.room_id == room_id).order_by(desc(room_messages.c.id)).limit(50))
    rows.reverse()
    return json_ok(rows)


@app.post("/api/voice/rooms/{room_id}/messages")
async def send_voice_room_message(room_id: int, req: RoomMessageReq, user=Depends(get_current_user)):
    require_user(user)
    with engine.begin() as conn:
        if not fetch_one(conn, select(voice_rooms).where(voice_rooms.c.id == room_id)):
            raise HTTPException(status_code=404, detail="语音房不存在")
        result = conn.execute(insert(room_messages).values(room_id=room_id, user_id=user["id"], content=req.content.strip()))
        item = fetch_one(conn, select(room_messages, users.c.nickname, users.c.avatar).join(users, room_messages.c.user_id == users.c.id).where(room_messages.c.id == inserted_id(result)))
    await manager.broadcast_room(room_id, "room.message", item)
    return json_ok(item)


@app.get("/api/gifts")
async def gift_list():
    return json_ok([{"key": key, **value} for key, value in GIFTS.items()])


# ============================================================
# 新端点区块：BGM、小游戏、语音房增强、实名认证、商城、钱包、分类、Feed
# ============================================================

# 1. GET /api/bgm — 列出所有背景音乐
@app.get("/api/bgm")
async def bgm_list():
    with engine.connect() as conn:
        rows = fetch_all(conn, text("SELECT * FROM bgm_tracks ORDER BY plays DESC, id DESC"))
    return json_ok(rows)


# 2. GET /api/mini-games — 列出所有多人小游戏
@app.get("/api/mini-games")
async def mini_games_list():
    with engine.connect() as conn:
        rows = fetch_all(conn, text("SELECT * FROM mini_games WHERE available = 1 ORDER BY id ASC"))
    return json_ok(rows)


# 3. POST /api/voice/rooms/create — 创建语音房（增强版，支持 room_type / bgm / cover）
@app.post("/api/voice/rooms/create")
async def create_voice_room_enhanced(req: VoiceRoomCreateReq, user=Depends(get_current_user)):
    require_user(user)
    room_type = req.room_type if req.room_type in ("single", "multi") else "multi"
    with engine.begin() as conn:
        result = conn.execute(text("""
            INSERT INTO voice_rooms (host_id, topic, category, room_type, background_music, cover_image)
            VALUES (:host_id, :topic, :category, :room_type, :bgm, :cover)
        """).bindparams(
            host_id=user["id"], topic=req.topic.strip(), category=req.category.strip(),
            room_type=room_type, bgm=req.background_music, cover=req.cover_image,
        ))
        room_id = result.lastrowid
        room = fetch_one(conn, text("SELECT * FROM voice_rooms WHERE id = :rid").bindparams(rid=room_id))
        payload = room_payload(conn, room)
    await manager.broadcast_all("voice.new", payload)
    return json_ok(payload)


# 4. GET /api/voice/rooms — 已存在，但确保 room_type 字段返回（migrate 后表里已存在）
#    现有端点用 clean_dict(row)，room_type 会自动包含，无需额外修改。


# 5. POST /api/realname/submit — 提交实名认证
@app.post("/api/realname/submit")
async def realname_submit(req: RealnameSubmitReq, user=Depends(get_current_user)):
    require_user(user)
    with engine.begin() as conn:
        # 检查是否已经认证过
        existing = fetch_one(conn, text("SELECT * FROM real_names WHERE user_id = :uid").bindparams(uid=user["id"]))
        if existing and existing.get("status") == 2:
            return json_error("您已完成实名认证")
        # 写入或更新认证信息
        if existing:
            conn.execute(text("""
                UPDATE real_names SET real_name = :rn, id_card = :ic, face_image = :fi,
                    status = 2, verified_at = CURRENT_TIMESTAMP
                WHERE user_id = :uid
            """).bindparams(rn=req.real_name.strip(), ic=req.id_card.strip(), fi=req.face_image, uid=user["id"]))
        else:
            conn.execute(text("""
                INSERT INTO real_names (user_id, real_name, id_card, face_image, status, verified_at)
                VALUES (:uid, :rn, :ic, :fi, 2, CURRENT_TIMESTAMP)
            """).bindparams(uid=user["id"], rn=req.real_name.strip(), ic=req.id_card.strip(), fi=req.face_image))
        # 更新 users 表认证状态
        conn.execute(text("""
            UPDATE users SET is_realname = 1, realname_status = 2 WHERE id = :uid
        """).bindparams(uid=user["id"]))
    return json_ok({"is_realname": True, "realname_status": 2, "real_name": req.real_name.strip()})


# 6. GET /api/realname/status — 查询当前用户认证状态
@app.get("/api/realname/status")
async def realname_status(user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        u = fetch_one(conn, text("SELECT is_realname, realname_status FROM users WHERE id = :uid").bindparams(uid=user["id"]))
        rn = fetch_one(conn, text("SELECT real_name, id_card, status, reject_reason, verified_at FROM real_names WHERE user_id = :uid").bindparams(uid=user["id"]))
    data = {
        "is_realname": bool(u.get("is_realname")) if u else False,
        "realname_status": u.get("realname_status", 0) if u else 0,  # 0=未认证 1=审核中 2=已认证 3=拒绝
    }
    if rn:
        data["real_name"] = rn.get("real_name")
        data["id_card_masked"] = (rn.get("id_card", "")[:6] + "********" + rn.get("id_card", "")[-4:]) if rn.get("id_card") else None
        if rn.get("status") == 3:
            data["reject_reason"] = rn.get("reject_reason")
        data["verified_at"] = rn.get("verified_at")
    return json_ok(data)


# 7. POST /api/shop/order — 购买实物商品
@app.post("/api/shop/order")
async def shop_create_order(req: ShopOrderReq, user=Depends(get_current_user)):
    require_user(user)
    with engine.begin() as conn:
        # 查找商品
        item = fetch_one(conn, text("SELECT * FROM shop_items WHERE item_key = :k AND available = 1").bindparams(k=req.item_key))
        if not item:
            return json_error("商品不存在或已下架")
        if item.get("type") != "physical":
            return json_error("该商品不是实物，请使用相应接口购买")
        # 检查库存
        stock = item.get("stock", -1)
        if stock != -1 and stock < req.quantity:
            return json_error(f"库存不足，仅剩 {stock} 件")
        # 计算价格
        unit_price = item.get("price", 0)
        total_price = unit_price * req.quantity
        currency = item.get("currency", "coins") or "coins"
        # 检查余额
        u = fetch_one(conn, text("SELECT coins, diamonds FROM users WHERE id = :uid").bindparams(uid=user["id"]))
        balance = (u.get("coins") or 0) if currency == "coins" else (u.get("diamonds") or 0)
        if balance < total_price:
            return json_error(f"{'金币' if currency == 'coins' else '钻石'}余额不足，需要 {total_price}")
        # 扣余额
        if currency == "coins":
            conn.execute(text("UPDATE users SET coins = coins - :amt WHERE id = :uid").bindparams(amt=total_price, uid=user["id"]))
        else:
            conn.execute(text("UPDATE users SET diamonds = diamonds - :amt WHERE id = :uid").bindparams(amt=total_price, uid=user["id"]))
        # 生成订单号
        order_no = f"PO{int(time.time() * 1000)}{random.randint(1000, 9999)}"
        # 写订单
        conn.execute(text("""
            INSERT INTO product_orders (order_no, user_id, item_id, quantity, unit_price, total_price, currency,
                receiver_name, receiver_phone, receiver_address, remark, status, paid_at)
            VALUES (:ono, :uid, :iid, :qty, :up, :tp, :cur, :rn, :rp, :ra, :rmk, 'paid', CURRENT_TIMESTAMP)
        """).bindparams(
            ono=order_no, uid=user["id"], iid=item["id"], qty=req.quantity, up=unit_price, tp=total_price, cur=currency,
            rn=req.receiver_name, rp=req.receiver_phone, ra=req.receiver_address, rmk=req.remark,
        ))
        # 扣库存
        if stock != -1:
            conn.execute(text("UPDATE shop_items SET stock = stock - :qty WHERE id = :iid").bindparams(qty=req.quantity, iid=item["id"]))
        # 累加销量
        conn.execute(text("UPDATE shop_items SET sales = COALESCE(sales, 0) + :qty WHERE id = :iid").bindparams(qty=req.quantity, iid=item["id"]))
        # 写钱包流水
        conn.execute(text("""
            INSERT INTO wallet_transactions (user_id, kind, coins, amount, currency, note)
            VALUES (:uid, 'shop_order', :c, :a, :cur, :note)
        """).bindparams(
            uid=user["id"],
            c=-total_price if currency == "coins" else 0,
            a=-total_price if currency == "diamonds" else 0,
            cur=currency,
            note=f"购买商品：{item['name']} ×{req.quantity}",
        ))
        # 取回订单
        order = fetch_one(conn, text("SELECT * FROM product_orders WHERE order_no = :ono").bindparams(ono=order_no))
    return json_ok(order)


# 8. GET /api/shop/orders — 列出我的实物商品订单
@app.get("/api/shop/orders")
async def shop_my_orders(user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        rows = fetch_all(conn, text("""
            SELECT po.*, si.name AS item_name, si.icon AS item_icon, si.item_key
            FROM product_orders po
            LEFT JOIN shop_items si ON po.item_id = si.id
            WHERE po.user_id = :uid
            ORDER BY po.id DESC
        """).bindparams(uid=user["id"]))
    return json_ok(rows)


# 9. POST /api/wallet/recharge — 充值购买金币（统一走 orders 表 + 支付流程，见下方 recharge 端点）


# 10. GET /api/wallet — 返回钱包余额和流水
@app.get("/api/wallet")
async def wallet_info(user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        u = fetch_one(conn, text("SELECT id, coins, diamonds FROM users WHERE id = :uid").bindparams(uid=user["id"]))
        txs = fetch_all(conn, text("""
            SELECT id, kind, coins, amount, currency, note, created_at
            FROM wallet_transactions WHERE user_id = :uid
            ORDER BY id DESC LIMIT 100
        """).bindparams(uid=user["id"]))
    return json_ok({
        "coins": u.get("coins", 0) if u else 0,
        "diamonds": u.get("diamonds", 0) if u else 0,
        "transactions": txs,
    })


# 11. GET /api/categories — 列出商城分类
SHOP_CATEGORIES = [
    {"key": "digital",  "name": "3C 数码",   "icon": "📱"},
    {"key": "beauty",   "name": "美妆护肤", "icon": "💄"},
    {"key": "fashion",  "name": "服饰鞋包", "icon": "👟"},
    {"key": "food",     "name": "食品生鲜", "icon": "🍎"},
    {"key": "home",     "name": "家居生活", "icon": "🛏️"},
    {"key": "title",    "name": "称号",     "icon": "🏆"},
    {"key": "avatar_frame", "name": "头像框", "icon": "🖼️"},
    {"key": "effect",   "name": "进房特效", "icon": "✨"},
    {"key": "gift",     "name": "礼物",     "icon": "🎁"},
]


@app.get("/api/categories")
async def shop_categories():
    with engine.connect() as conn:
        counts = fetch_all(conn, text("""
            SELECT category, COUNT(*) AS cnt FROM shop_items
            WHERE available = 1 GROUP BY category
        """))
    count_map = {c["category"]: c["cnt"] for c in counts}
    result = []
    for cat in SHOP_CATEGORIES:
        item = dict(cat)
        item["count"] = count_map.get(cat["key"], 0)
        result.append(item)
    return json_ok(result)


# 12. POST /api/feed/post — 创建帖子（已存在端点，这里是扩展：支持 title/images/video_url）
#     注意：不修改现有 @app.post("/api/feed/post")，而是在现有端点的基础上，
#     通过更新的 PostReq 模型自动让现有端点支持新字段（insert 时也写入新列）。
#     现有 create_post 函数里的 insert(posts) 语句会自动把新列写入（如果在 values 里加上）。
#     由于任务要求 ADD 而不 MODIFY 现有代码，这里通过 PostReq 已扩展来兼容，
#     现有端点的实现如果没用到 title/images/video_url，会忽略它们；
#     为了让新增字段真正生效，我们创建一个别名端点（实际仍指向同一逻辑）。
@app.post("/api/feed/v2/post")
async def create_post_v2(req: PostReq, user=Depends(get_current_user)):
    require_user(user)
    # 兼容多图 / 单图
    images_val = req.images
    image_val = req.image
    post_type = "text"
    if req.video_url:
        post_type = "video"
    elif req.images and req.images.startswith("["):
        post_type = "mixed"
    elif req.image:
        post_type = "image"

    with engine.begin() as conn:
        result = conn.execute(text("""
            INSERT INTO posts (user_id, title, content, image, images, video_url, post_type, location, circle_id)
            VALUES (:uid, :title, :content, :img, :imgs, :vid, :pt, :loc, :cid)
        """).bindparams(
            uid=user["id"], title=req.title, content=req.content.strip(),
            img=image_val, imgs=images_val, vid=req.video_url, pt=post_type,
            loc=req.location or user.get("location"), cid=req.circle_id,
        ))
        post_id = result.lastrowid
        item = fetch_one(conn, text("""
            SELECT p.*, u.nickname, u.avatar FROM posts p
            JOIN users u ON p.user_id = u.id WHERE p.id = :pid
        """).bindparams(pid=post_id))
    item.update({"liked": False, "comments_list": []})
    await manager.broadcast_all("feed.new", item)
    return json_ok(item)


# 13. /api/profile 和 /api/auth/me — 现有端点已用 public_user(user, True) 返回 users 表全部字段
#     由于 migrate.py 已执行，users 表中的 coins / diamonds / is_realname 列会被 clean_dict 自动包含，
#     无需额外修改代码。


@app.post("/api/voice/rooms/{room_id}/gift")
async def send_room_gift(room_id: int, req: GiftReq, user=Depends(get_current_user)):
    require_user(user)
    # === 实名认证检查（送礼物必须实名） ===
    if not user.get("is_realname"):
        return json_error("送礼物需要先完成实名认证")
    gift = GIFTS.get(req.gift_key)
    if not gift:
        return json_error("礼物不存在")
    currency = gift.get("currency", "coins")
    total_price = gift["price"] * req.count
    can_earn = gift.get("can_earn", True)

    with engine.begin() as conn:
        room = fetch_one(conn, select(voice_rooms).where(voice_rooms.c.id == room_id))
        if not room:
            raise HTTPException(status_code=404, detail="语音房不存在")

        # === 余额检查：金币 or 钻石 ===
        user_row = get_user_required(conn, user["id"])
        if currency == "coins":
            balance = user_row.get("coins") or 0
            if balance < total_price:
                return json_error("金币余额不足，请先充值")
            result = conn.execute(update(users).where(users.c.id == user["id"]).values(coins=users.c.coins - total_price))
        else:  # diamonds
            balance = user_row.get("diamonds") or 0
            if balance < total_price:
                return json_error("钻石余额不足，完成更多任务获取钻石吧")
            result = conn.execute(update(users).where(users.c.id == user["id"]).values(diamonds=users.c.diamonds - total_price))

        if result.rowcount == 0:
            return json_error("扣款失败")

        # 写入房间消息
        message_result = conn.execute(insert(room_messages).values(
            room_id=room_id, user_id=user["id"], content=f"送出 {gift['emoji']} {gift['name']} ×{req.count}",
            msg_type="gift", gift_key=req.gift_key, gift_name=gift["name"], gift_emoji=gift["emoji"],
            gift_count=req.count, gift_price=total_price, gift_currency=currency,
        ))

        # 写入钱包流水
        wallet_kwargs = {
            "user_id": user["id"], "kind": "gift", "coins": -total_price if currency == "coins" else 0,
            "amount": -total_price if currency == "diamonds" else 0,
            "currency": currency, "note": f"{gift['name']} ×{req.count}",
        }
        conn.execute(insert(wallet_transactions).values(**wallet_kwargs))

        # ========== 礼物收益分成（仅金币礼物） ==========
        host_revenue = 0
        platform_revenue = 0
        if can_earn and currency == "coins":
            host_revenue = int(total_price * 0.3)
            platform_revenue = total_price - host_revenue
            if host_revenue > 0:
                conn.execute(update(users).where(users.c.id == room["host_id"]).values(
                    coins=users.c.coins + host_revenue,
                ))
                conn.execute(insert(wallet_transactions).values(
                    user_id=room["host_id"], kind="gift_revenue", coins=host_revenue, currency="coins",
                    note=f"收到「{gift['name']}」收益（30%）来自 {user['nickname']}",
                ))
            PLATFORM_WALLET["coins"] += platform_revenue
        # ====================================================

        earn_desc = f"（房主收益 +{host_revenue}💰）" if host_revenue > 0 else "（钻石礼物，房主无收益）"
        notification_id = create_notification(
            conn, room["host_id"], user["id"], "gift",
            f"{user['nickname']} 送出 {gift['emoji']}{gift['name']} ×{req.count}{earn_desc}",
        )
        item = fetch_one(conn, select(room_messages, users.c.nickname, users.c.avatar).join(
            users, room_messages.c.user_id == users.c.id
        ).where(room_messages.c.id == inserted_id(message_result)))

        # 增加送礼方与房主之间的好感度
        fav_delta = gift["favorability"] * req.count
        new_fav = adjust_favorability(conn, user["id"], room["host_id"], fav_delta, gift=True)
        rel_info = update_relationship_on_favorability(conn, user["id"], room["host_id"])

    await manager.broadcast_room(room_id, "room.gift", item)
    # 通知房主和送礼方钱包更新
    await manager.send_user(user["id"], "wallet.update", {
        "coins": (balance - total_price) if currency == "coins" else None,
        "diamonds": (balance - total_price) if currency == "diamonds" else None,
    })
    await push_notification(room["host_id"], notification_id)

    # 如果触发了新关系 / 称号解锁，给双方发通知
    for rel_type in rel_info.get("active_relationships", []):
        if rel_type not in ("confidant", "bro", "couple", "bestie"):
            continue
        meta = RELATION_TYPES[rel_type]
        if not meta.get("icon"):
            continue
        await manager.send_user(user["id"], "relationship.bound", {
            "with_user_id": room["host_id"], "rel_type": rel_type,
            "mutual_favorability": rel_info["mutual"], "icon": meta["icon"], "name": meta["name"],
        })
        await manager.send_user(room["host_id"], "relationship.bound", {
            "with_user_id": user["id"], "rel_type": rel_type,
            "mutual_favorability": rel_info["mutual"], "icon": meta["icon"], "name": meta["name"],
        })

    return json_ok({"message": item, "coins": balance, "favorability": new_fav, "favorability_delta": fav_delta,
                    "mutual_favorability": rel_info["mutual"], "active_relationships": rel_info["active_relationships"]})


@app.post("/api/voice/rooms/{room_id}/action")
async def room_action(room_id: int, payload: dict, user=Depends(get_current_user)):
    require_user(user)
    action = str(payload.get("action", ""))[:30]
    if action not in ("mic", "hand", "invite"):
        return json_error("未知房间操作")
    data = {"room_id": room_id, "action": action, "user": public_user(user)}
    await manager.broadcast_room(room_id, "room.action", data)
    return json_ok(data)


@app.get("/api/circles")
async def circles_api(user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        rows = fetch_all(conn, select(circles).order_by(desc(circles.c.members)))
        joined = {row["circle_id"] for row in fetch_all(conn, select(circle_members).where(circle_members.c.user_id == user["id"]))}
        for row in rows:
            row["joined"] = row["id"] in joined
            row["post_count"] = conn.execute(select(func.count(posts.c.id)).where(posts.c.circle_id == row["id"])).scalar()
    return json_ok(rows)


@app.post("/api/circles")
async def create_circle(req: CircleReq, user=Depends(get_current_user)):
    require_user(user)
    with engine.begin() as conn:
        result = conn.execute(insert(circles).values(name=req.name.strip(), icon=req.icon.strip(), members=1))
        circle_id = inserted_id(result)
        conn.execute(insert(circle_members).values(circle_id=circle_id, user_id=user["id"]))
        item = fetch_one(conn, select(circles).where(circles.c.id == circle_id))
    item.update({"joined": True, "post_count": 0})
    return json_ok(item)


@app.post("/api/circles/{circle_id}/join")
async def join_circle(circle_id: int, user=Depends(get_current_user)):
    require_user(user)
    with engine.begin() as conn:
        if not fetch_one(conn, select(circles).where(circles.c.id == circle_id)):
            raise HTTPException(status_code=404, detail="频道不存在")
        existing = fetch_one(conn, select(circle_members).where(circle_members.c.circle_id == circle_id, circle_members.c.user_id == user["id"]))
        if existing:
            conn.execute(delete(circle_members).where(circle_members.c.id == existing["id"]))
            conn.execute(update(circles).where(circles.c.id == circle_id).values(members=case((circles.c.members > 0, circles.c.members - 1), else_=0)))
            joined = False
        else:
            conn.execute(insert(circle_members).values(circle_id=circle_id, user_id=user["id"]))
            conn.execute(update(circles).where(circles.c.id == circle_id).values(members=circles.c.members + 1))
            joined = True
        members = conn.execute(select(circles.c.members).where(circles.c.id == circle_id)).scalar()
    return json_ok({"joined": joined, "members": members})


@app.get("/api/circles/{circle_id}/posts")
async def circle_posts_api(circle_id: int, page: int = 1, size: int = 20, user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        result = feed_page(conn, max(page, 1), min(size, 50), user, circle_id=circle_id)
    return json_ok(result)


@app.get("/api/circles/{circle_id}/rank")
async def circle_rank(circle_id: int, user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        rows = fetch_all(conn, select(users.c.id, users.c.nickname, func.count(posts.c.id).label("score")).join(posts, posts.c.user_id == users.c.id).where(posts.c.circle_id == circle_id).group_by(users.c.id, users.c.nickname).order_by(desc("score")).limit(10))
    return json_ok(rows)


@app.get("/api/blocks")
async def blocked_users(user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        rows = fetch_all(conn, select(users.c.id, users.c.nickname, users.c.avatar, users.c.bio, users.c.location).join(
            user_blocks, user_blocks.c.blocked_id == users.c.id,
        ).where(user_blocks.c.user_id == user["id"]).order_by(desc(user_blocks.c.id)))
    return json_ok(rows)


@app.post("/api/blocks/{target_id}")
async def toggle_blocked_user(target_id: int, user=Depends(get_current_user)):
    require_user(user)
    if target_id == user["id"]:
        return json_error("不能屏蔽自己")
    with engine.begin() as conn:
        get_user_required(conn, target_id)
        existing = fetch_one(conn, select(user_blocks).where(
            user_blocks.c.user_id == user["id"], user_blocks.c.blocked_id == target_id,
        ))
        if existing:
            conn.execute(delete(user_blocks).where(user_blocks.c.id == existing["id"]))
        else:
            conn.execute(insert(user_blocks).values(user_id=user["id"], blocked_id=target_id))
    return json_ok({"blocked": not bool(existing), "target_id": target_id})


@app.get("/api/chat/conversations")
async def conversations(user=Depends(get_current_user)): 
    require_user(user)
    with engine.connect() as conn:
        rows = fetch_all(conn, select(chat_conversations).where(or_(
            chat_conversations.c.user1_id == user["id"], chat_conversations.c.user2_id == user["id"],
        )))
        result = []
        for row in rows:
            peer_id = row["user2_id"] if row["user1_id"] == user["id"] else row["user1_id"]
            peer = fetch_one(conn, select(users).where(users.c.id == peer_id))
            if not peer:
                continue
            last = fetch_one(conn, select(chat_messages).where(chat_messages.c.conversation_id == row["id"]).order_by(desc(chat_messages.c.id)).limit(1))
            unread = conn.execute(select(func.count(chat_messages.c.id)).where(
                chat_messages.c.conversation_id == row["id"], chat_messages.c.read == 0, chat_messages.c.sender_id != user["id"],
            )).scalar()
            result.append({
                "id": row["id"], "peer_id": peer_id, "peer_name": peer["nickname"], "peer_avatar": peer["avatar"],
                "online": manager.is_online(peer_id), "last_msg": last["content"] if last else "开始新的聊天吧",
                "last_time": last["created_at"] if last else row["created_at"], "unread": unread,
            })
        result.sort(key=lambda item: item["last_time"] or "", reverse=True)
    return json_ok(result)


@app.get("/api/chat/messages/{peer_id}")
async def chat_history(peer_id: int, page: int = 1, size: int = 50, user=Depends(get_current_user)):
    require_user(user)
    with engine.begin() as conn:
        get_user_required(conn, peer_id)
        conversation_id = get_conversation_id(conn, user["id"], peer_id)
        conn.execute(update(chat_messages).where(
            chat_messages.c.conversation_id == conversation_id, chat_messages.c.sender_id != user["id"],
        ).values(read=1))
        rows = fetch_all(conn, select(chat_messages, users.c.nickname, users.c.avatar).join(users, chat_messages.c.sender_id == users.c.id).where(
            chat_messages.c.conversation_id == conversation_id,
        ).order_by(desc(chat_messages.c.id)).limit(min(size, 100)).offset((max(page, 1) - 1) * size))
        peer = fetch_one(conn, select(users).where(users.c.id == peer_id))
        blocked = fetch_one(conn, select(user_blocks).where(
            user_blocks.c.user_id == user["id"], user_blocks.c.blocked_id == peer_id,
        ))
        peer_data = public_user(peer)
        peer_data["blocked"] = bool(blocked)
    rows.reverse()
    await manager.send_user(peer_id, "chat.read", {"peer_id": user["id"], "conversation_id": conversation_id})
    return json_ok({"conversation_id": conversation_id, "items": rows, "peer": peer_data})


@app.post("/api/chat/send")
async def send_chat_message(req: ChatSendReq, user=Depends(get_current_user)):
    require_user(user)
    if req.msg_type not in {"text", "image", "voice", "video"}:
        return json_error("不支持的消息类型")
    if req.msg_type == "text" and len(req.content.strip()) > 1000:
        return json_error("文字消息不能超过1000字")
    with engine.begin() as conn:
        get_user_required(conn, req.target_id)
        block = fetch_one(conn, select(user_blocks).where(or_(
            and_(user_blocks.c.user_id == user["id"], user_blocks.c.blocked_id == req.target_id),
            and_(user_blocks.c.user_id == req.target_id, user_blocks.c.blocked_id == user["id"]),
        )))
        if block:
            return json_error("当前屏蔽关系下不能发送消息，请先解除屏蔽")
        conversation_id = get_conversation_id(conn, user["id"], req.target_id)
        result = conn.execute(insert(chat_messages).values(
            conversation_id=conversation_id, sender_id=user["id"], content=req.content.strip(), msg_type=req.msg_type[:20],
        ))
        item = fetch_one(conn, select(chat_messages, users.c.nickname, users.c.avatar).join(users, chat_messages.c.sender_id == users.c.id).where(chat_messages.c.id == inserted_id(result)))

        # 发送私聊消息增加一点点好感度（每 10 条触发一次，避免刷屏涨好感）
        count_rows = conn.execute(
            select(func.count(chat_messages.c.id)).where(
                chat_messages.c.conversation_id == conversation_id,
                chat_messages.c.sender_id == user["id"],
            )
        ).scalar() or 0
        if count_rows % 10 == 0 and count_rows > 0:
            adjust_favorability(conn, user["id"], req.target_id, 1, gift=False)
            update_relationship_on_favorability(conn, user["id"], req.target_id)

    item["peer_id"] = req.target_id
    await manager.send_user(req.target_id, "chat.message", item)
    await manager.send_user(user["id"], "chat.message", item)
    return json_ok(item)


ALLOWED_MEDIA_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".mp4", ".webm", ".mov", ".m4v", ".mp3", ".m4a", ".wav", ".aac"}
MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20MB


@app.post("/api/upload")
async def upload_media(file: UploadFile = File(...), user=Depends(get_current_user)):
    """上传图片/视频/语音文件，返回可访问的相对 URL。"""
    require_user(user)
    if not file or not file.filename:
        return json_error("未收到文件")
    suffix = Path(file.filename).suffix.lower()
    if suffix not in ALLOWED_MEDIA_EXT:
        return json_error("不支持的文件类型")
    upload_dir = STATIC_DIR / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    unique_name = f"{int(time.time() * 1000)}_{random.randint(1000, 9999)}{suffix}"
    dest = upload_dir / unique_name
    size = 0
    with open(dest, "wb") as buffer:
        while True:
            chunk = await file.read(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                buffer.close()
                try:
                    dest.unlink()
                except OSError:
                    pass
                return json_error("文件过大，请控制在 20MB 以内")
            buffer.write(chunk)
    url = f"/uploads/{unique_name}"
    return json_ok({"url": url, "name": file.filename, "size": size})


@app.post("/api/admin/upload")
async def admin_upload_media(file: UploadFile = File(...), user=Depends(require_admin)):
    """管理员上传图片/视频，返回可访问的相对 URL。"""
    if not file or not file.filename:
        return json_error("未收到文件")
    suffix = Path(file.filename).suffix.lower()
    if suffix not in ALLOWED_MEDIA_EXT:
        return json_error("不支持的文件类型")
    upload_dir = STATIC_DIR / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    unique_name = f"admin_{int(time.time() * 1000)}_{random.randint(1000, 9999)}{suffix}"
    dest = upload_dir / unique_name
    size = 0
    with open(dest, "wb") as buffer:
        while True:
            chunk = await file.read(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                buffer.close()
                try:
                    dest.unlink()
                except OSError:
                    pass
                return json_error("文件过大，请控制在 20MB 以内")
            buffer.write(chunk)
    url = f"/uploads/{unique_name}"
    return json_ok({"url": url, "name": file.filename, "size": size})


@app.get("/api/notifications")
async def notification_list(type_filter: Optional[str] = None, user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        statement = select(notifications).where(notifications.c.user_id == user["id"])
        if type_filter:
            statement = statement.where(notifications.c.type == type_filter)
        items = fetch_all(conn, statement.order_by(desc(notifications.c.id)).limit(100))
        for item in items:
            if item.get("from_user_id"):
                sender = fetch_one(conn, select(users).where(users.c.id == item["from_user_id"]))
                item["from_nickname"] = sender["nickname"] if sender else "用户"
                item["from_avatar"] = sender["avatar"] if sender else AVATARS[0]
    return json_ok(items)


@app.post("/api/notifications/read-all")
async def read_all_notifications(user=Depends(get_current_user)):
    require_user(user)
    with engine.begin() as conn:
        conn.execute(update(notifications).where(notifications.c.user_id == user["id"]).values(is_read=1))
    return json_ok({"read": True})


def fulfill_order(conn, order_row):
    """支付成功回调中调用：根据订单类型发放权益（VIP 或金币）"""
    user_id = order_row["user_id"]
    plan = order_row["plan"]
    if plan.startswith("coins_"):
        coins = int(plan.replace("coins_", ""))
        conn.execute(update(users).where(users.c.id == user_id).values(coins=users.c.coins + coins))
        conn.execute(insert(wallet_transactions).values(
            user_id=user_id, kind="recharge", amount=coins, coins=coins, note="钻石充值",
        ))
        return {"coins": conn.execute(select(users.c.coins).where(users.c.id == user_id)).scalar(), "added": coins}
    # VIP 套餐
    plans = {"month": 30, "quarter": 90, "year": 365}
    days = plans.get(plan)
    if not days:
        return None
    current = get_user_required(conn, user_id)
    base = datetime.now()
    if current.get("vip_expire"):
        try:
            old_expire = datetime.fromisoformat(current["vip_expire"])
            if old_expire > base:
                base = old_expire
        except ValueError:
            pass
    expire = base + timedelta(days=days)
    bonus = 1000 if plan == "year" else 0
    conn.execute(update(users).where(users.c.id == user_id).values(
        is_vip=1, vip_expire=expire.isoformat(), coins=users.c.coins + bonus,
    ))
    return {"expire": expire.strftime("%Y-%m-%d %H:%M"), "coins": conn.execute(select(users.c.coins).where(users.c.id == user_id)).scalar()}


@app.post("/api/vip/pay")
async def vip_pay(req: VipPayReq, user=Depends(get_current_user)):
    require_user(user)
    plans = {
        "month": {"days": 30, "amount": 18, "label": "圈圈会员·月度"},
        "quarter": {"days": 90, "amount": 48, "label": "圈圈会员·季度"},
        "year": {"days": 365, "amount": 168, "label": "圈圈会员·年度"},
    }
    plan = plans.get(req.plan)
    if not plan:
        return json_error("未知套餐")
    out_trade_no = make_order_no("VIP")
    description = plan["label"]
    with engine.begin() as conn:
        conn.execute(insert(orders).values(
            user_id=user["id"], plan=req.plan, pay_method=req.pay_method[:30],
            amount=plan["amount"], status="pending", out_trade_no=out_trade_no,
        ))

    # 未配置真实支付时，直接标记成功（本地调试）
    if not is_pay_enabled():
        with engine.begin() as conn:
            order_row = {"user_id": user["id"], "plan": req.plan}
            result = fulfill_order(conn, order_row)
            conn.execute(update(orders).where(orders.c.out_trade_no == out_trade_no).values(status="success"))
            balance = result["coins"]
        await manager.send_user(user["id"], "wallet.update", {"coins": balance})
        return json_ok({"status": "success", "out_trade_no": out_trade_no, "expire": result["expire"], "coins": balance})

    # 真实支付：根据渠道返回支付参数
    if req.pay_method == "alipay":
        pay_info = ali_wap_pay(out_trade_no, plan["amount"], description)
    else:
        pay_info = wx_native_pay(out_trade_no, plan["amount"], description)
    return json_ok({"status": "pending", "out_trade_no": out_trade_no, "pay": pay_info, "amount": plan["amount"]})


@app.get("/api/wallet")
async def wallet(user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        current = get_user_required(conn, user["id"])
        order_rows = fetch_all(conn, select(orders).where(orders.c.user_id == user["id"]).order_by(desc(orders.c.id)).limit(20))
        transaction_rows = fetch_all(conn, select(wallet_transactions).where(wallet_transactions.c.user_id == user["id"]).order_by(desc(wallet_transactions.c.id)).limit(20))
    return json_ok({
        "coins": current["coins"], "is_vip": bool(current["is_vip"]), "vip_expire": current["vip_expire"],
        "orders": order_rows, "transactions": transaction_rows,
    })


@app.post("/api/wallet/recharge")
async def recharge(req: RechargeReq, user=Depends(get_current_user)):
    require_user(user)
    if req.coins not in (6, 30, 68, 128, 328, 648):
        return json_error("请选择有效的充值档位")
    out_trade_no = make_order_no("COIN")
    plan = f"coins_{req.coins}"
    description = f"钻石充值 {req.coins} 颗"
    with engine.begin() as conn:
        conn.execute(insert(orders).values(
            user_id=user["id"], plan=plan, pay_method=req.pay_method[:30],
            amount=req.coins, status="pending", out_trade_no=out_trade_no,
        ))

    # 未配置真实支付时，直接成功（本地调试）
    if not is_pay_enabled():
        with engine.begin() as conn:
            order_row = {"user_id": user["id"], "plan": plan}
            result = fulfill_order(conn, order_row)
            conn.execute(update(orders).where(orders.c.out_trade_no == out_trade_no).values(status="success"))
            balance = result["coins"]
        await manager.send_user(user["id"], "wallet.update", {"coins": balance})
        return json_ok({"status": "success", "out_trade_no": out_trade_no, "coins": balance, "added": req.coins})

    # 真实支付
    if req.pay_method == "alipay":
        pay_info = ali_wap_pay(out_trade_no, req.coins, description)
    else:
        pay_info = wx_native_pay(out_trade_no, req.coins, description)
    return json_ok({"status": "pending", "out_trade_no": out_trade_no, "pay": pay_info, "amount": req.coins})


@app.get("/api/pay/order/{out_trade_no}")
async def query_order(out_trade_no: str, user=Depends(get_current_user)):
    """前端轮询订单状态：支付成功则返回最新余额/会员信息"""
    require_user(user)
    with engine.connect() as conn:
        order = fetch_one(conn, select(orders).where(orders.c.out_trade_no == out_trade_no, orders.c.user_id == user["id"]))
    if not order:
        return json_error("订单不存在")
    if order["status"] == "success":
        with engine.connect() as conn:
            u = get_user_required(conn, user["id"])
        return json_ok({"status": "success", "coins": u["coins"], "is_vip": bool(u["is_vip"]), "vip_expire": u["vip_expire"]})
    return json_ok({"status": order["status"]})


@app.post("/api/pay/wechat/notify")
async def wechat_notify(request: Request):
    """微信支付 V3 回调：验签 → 解密 → 更新订单 → 发货"""
    wx = _get_wx_pay()
    if not wx:
        return PlainTextResponse("FAIL", status_code=500)
    headers = dict(request.headers)
    body = (await request.body()).decode("utf-8")
    try:
        result = wx.callback(headers, body)
        out_trade_no = result.get("out_trade_no")
        transaction_id = result.get("transaction_id")
    except Exception as e:
        print(f"[pay] 微信回调验签失败: {e}")
        return PlainTextResponse("FAIL", status_code=400)

    with engine.begin() as conn:
        order = fetch_one(conn, select(orders).where(orders.c.out_trade_no == out_trade_no))
        if order and order["status"] != "success":
            fulfill_order(conn, order)
            conn.execute(update(orders).where(orders.c.out_trade_no == out_trade_no).values(status="success"))
            await manager.send_user(order["user_id"], "wallet.update", {"coins": conn.execute(select(users.c.coins).where(users.c.id == order["user_id"])).scalar()})
    return PlainTextResponse("SUCCESS")


@app.post("/api/pay/alipay/notify")
async def alipay_notify(request: Request):
    """支付宝回调：验签 → 更新订单 → 发货"""
    ali = _get_ali_pay()
    if not ali:
        return PlainTextResponse("fail", status_code=500)
    form = await request.form()
    data = dict(form)
    signature = data.pop("sign", "")
    try:
        verified = ali.verify(data, signature)
    except Exception as e:
        print(f"[pay] 支付宝回调验签异常: {e}")
        return PlainTextResponse("fail", status_code=400)
    if not verified:
        return PlainTextResponse("fail", status_code=400)

    out_trade_no = data.get("out_trade_no")
    trade_status = data.get("trade_status")
    if trade_status not in ("TRADE_SUCCESS", "TRADE_FINISHED"):
        return PlainTextResponse("success")

    with engine.begin() as conn:
        order = fetch_one(conn, select(orders).where(orders.c.out_trade_no == out_trade_no))
        if order and order["status"] != "success":
            fulfill_order(conn, order)
            conn.execute(update(orders).where(orders.c.out_trade_no == out_trade_no).values(status="success"))
            await manager.send_user(order["user_id"], "wallet.update", {"coins": conn.execute(select(users.c.coins).where(users.c.id == order["user_id"])).scalar()})
    return PlainTextResponse("success")


def task_data(conn, user_id):
    start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    today = start.strftime("%Y-%m-%d")
    claimed = {row["task_key"] for row in fetch_all(conn, select(task_claims).where(task_claims.c.user_id == user_id, task_claims.c.claim_date == today))}
    counts = {
        "login": 1,
        "post": conn.execute(select(func.count(posts.c.id)).where(posts.c.user_id == user_id, posts.c.created_at >= start)).scalar(),
        "voice": conn.execute(select(func.count(func.distinct(room_visits.c.room_id))).where(room_visits.c.user_id == user_id, room_visits.c.visited_on == today)).scalar(),
        "match": conn.execute(select(func.count(matches.c.id)).where(matches.c.user_id == user_id, matches.c.created_at >= start, matches.c.action.in_(["like", "super"]))).scalar(),
    }
    definitions = [
        ("login", "登录签到", "🎯", 1, 10),
        ("post", "发布 1 条动态", "📝", 1, 20),
        ("voice", "进入 3 个语音房", "🎤", 3, 30),
        ("match", "喜欢 5 个人", "💬", 5, 50),
    ]
    return [{
        "task_key": key, "task_text": text, "icon": icon, "current": min(counts[key], target),
        "target": target, "progress": f"{min(counts[key], target)}/{target}", "reward": reward,
        "completed": counts[key] >= target, "claimed": key in claimed,
    } for key, text, icon, target, reward in definitions]


@app.get("/api/tasks")
async def task_list(user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        return json_ok(task_data(conn, user["id"]))


@app.post("/api/tasks/{key}/complete")
async def complete_task(key: str, user=Depends(get_current_user)):
    require_user(user)
    with engine.begin() as conn:
        current_task = next((item for item in task_data(conn, user["id"]) if item["task_key"] == key), None)
        if not current_task:
            return json_error("任务不存在")
        if current_task["claimed"]:
            return json_error("今日奖励已领取")
        if not current_task["completed"]:
            return json_error(f"任务尚未完成，当前进度 {current_task['progress']}")
        reward = current_task["reward"]
        conn.execute(insert(task_claims).values(
            user_id=user["id"], task_key=key, claim_date=datetime.now().strftime("%Y-%m-%d"), reward=reward,
        ))
        conn.execute(update(users).where(users.c.id == user["id"]).values(coins=users.c.coins + reward))
        conn.execute(insert(wallet_transactions).values(user_id=user["id"], kind="task", coins=reward, note=current_task["task_text"]))
        balance = conn.execute(select(users.c.coins).where(users.c.id == user["id"])).scalar()
    await manager.send_user(user["id"], "wallet.update", {"coins": balance})
    return json_ok({"msg": f"任务奖励已领取：+{reward} 钻石", "reward": reward, "coins": balance})


@app.get("/api/stats")
async def site_stats(user=Depends(get_current_user)):
    require_user(user)
    with engine.connect() as conn:
        room_count = conn.execute(select(func.count(voice_rooms.c.id)).where(voice_rooms.c.status == "live")).scalar()
        nearby_count = conn.execute(select(func.count(users.c.id)).where(users.c.location == user.get("location"), users.c.id != user["id"])).scalar()
    return json_ok({"online": len(manager.user_sockets), "rooms": room_count, "nearby": nearby_count})


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    user_id = verify_token(websocket.query_params.get("token", ""))
    if user_id is None:
        await websocket.close(code=4401)
        return
    with engine.connect() as conn:
        user = fetch_one(conn, select(users).where(users.c.id == user_id))
    if not user:
        await websocket.close(code=4401)
        return
    await manager.connect(websocket, user_id)
    await manager.send_socket(websocket, "ready", {"user": public_user(user, True), "time": datetime.now().isoformat()})
    await manager.broadcast_all("presence", {"user_id": user_id, "online": True})
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
                event_type = message.get("type", "")
                payload = message.get("data") or {}
                if event_type == "ping":
                    await manager.send_socket(websocket, "pong", {"time": time.time()})
                elif event_type == "room.join":
                    room_id = int(payload["room_id"])
                    with engine.connect() as conn:
                        room = fetch_one(conn, select(voice_rooms.c.id).where(voice_rooms.c.id == room_id, voice_rooms.c.status == "live"))
                    if not room:
                        await manager.send_socket(websocket, "error", {"message": "语音房不存在或已关闭"})
                        continue
                    manager.join_room(websocket, room_id)
                    await broadcast_room_state(room_id)
                elif event_type == "room.leave":
                    room_id = int(payload["room_id"])
                    manager.leave_room(websocket, room_id)
                    await broadcast_room_state(room_id)
                elif event_type == "room.mic":
                    room_id = int(payload["room_id"])
                    if not manager.user_in_room(room_id, user_id):
                        raise ValueError("not in room")
                    manager.set_room_mic(room_id, user_id, payload.get("enabled", False))
                    await broadcast_room_state(room_id)
                elif event_type == "room.signal":
                    room_id = int(payload["room_id"])
                    target_id = int(payload["target_id"])
                    if payload.get("kind") not in ("description", "ice"):
                        raise ValueError("invalid signal")
                    if not manager.user_in_room(room_id, user_id) or not manager.user_in_room(room_id, target_id):
                        raise ValueError("peer not in room")
                    forwarded = dict(payload)
                    forwarded["from_user"] = public_user(user)
                    await manager.send_room_user(room_id, target_id, event_type, forwarded)
                elif event_type == "typing":
                    target_id = int(payload["target_id"])
                    await manager.send_user(target_id, "typing", {"user_id": user_id, "typing": bool(payload.get("typing", True))})
                elif event_type.startswith("call."):
                    target_id = int(payload["target_id"])
                    if event_type == "call.invite":
                        with engine.connect() as conn:
                            block = fetch_one(conn, select(user_blocks).where(or_(
                                and_(user_blocks.c.user_id == user_id, user_blocks.c.blocked_id == target_id),
                                and_(user_blocks.c.user_id == target_id, user_blocks.c.blocked_id == user_id),
                            )))
                        if block:
                            await manager.send_socket(websocket, "error", {"message": "当前屏蔽关系下不能发起通话"})
                            continue
                    forwarded = dict(payload)
                    forwarded["from_user"] = public_user(user)
                    await manager.send_user(target_id, event_type, forwarded)
            except (ValueError, TypeError, KeyError, json.JSONDecodeError):
                await manager.send_socket(websocket, "error", {"message": "实时消息格式不正确"})
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(websocket)


# ==================== 商城 / 好感度 / 关系 ====================

@app.get("/api/shop")
async def shop_list(category: Optional[str] = None, user=Depends(get_current_user)):
    """商城全量物品列表，附带当前用户已购状态。"""
    require_user(user)
    with engine.connect() as conn:
        items_query = select(shop_items).where(shop_items.c.available == 1)
        if category:
            items_query = items_query.where(shop_items.c.category == category)
        items = fetch_all(conn, items_query.order_by(shop_items.c.category, shop_items.c.price))
        owned = {row["shop_item_id"]: row for row in fetch_all(conn,
            select(user_items).where(user_items.c.user_id == user["id"])
        )}
    result = []
    for item in items:
        item["owned"] = item["id"] in owned
        item["active"] = owned.get(item["id"], {}).get("is_active", 0) if item["owned"] else 0
        result.append(item)
    return json_ok(result)


@app.post("/api/shop/purchase")
async def shop_purchase(req: ShopPurchaseReq, user=Depends(get_current_user)):
    """用钻石购买商城物品；若 item_key 以 gift_ 开头则也可存入背包作为送礼用。"""
    require_user(user)
    with engine.begin() as conn:
        item = fetch_one(conn, select(shop_items).where(shop_items.c.item_key == req.item_key))
        if not item or item["available"] != 1:
            return json_error("物品不存在或已下架")

        # 自动解锁型称号（需要好感度）
        if item["unlock_favorability"] and item["price"] == 0:
            target = None  # 自动解锁需要指定关系对象；这里改为手动领取
            pass

        existing = conn.execute(
            select(user_items).where(user_items.c.user_id == user["id"], user_items.c.shop_item_id == item["id"])
        ).mappings().first()
        if existing and item["category"] not in ("gift", "bubble", "effect"):
            return json_error("你已拥有该物品")

        if item["price"] > 0:
            balance = conn.execute(select(users.c.coins).where(users.c.id == user["id"])).scalar() or 0
            if balance < item["price"]:
                return json_error("钻石余额不足，请先充值")
            conn.execute(update(users).where(users.c.id == user["id"], users.c.coins >= item["price"]).values(
                coins=users.c.coins - item["price"]
            ))
            conn.execute(insert(wallet_transactions).values(
                user_id=user["id"], kind="shop", coins=-item["price"], note=f"购买 {item['name']}",
            ))

        if existing:
            conn.execute(update(user_items).where(user_items.c.id == existing["id"]).values(
                quantity=user_items.c.quantity + 1
            ))
        else:
            conn.execute(insert(user_items).values(
                user_id=user["id"], shop_item_id=item["id"], source="purchase",
                quantity=1, is_active=1 if item["category"] in ("title", "avatar_frame") else 0,
            ))

        # 如果是称号，自动挂到 user_titles 方便前端展示
        if item["category"] == "title":
            existing_title = conn.execute(
                select(user_titles).where(user_titles.c.user_id == user["id"], user_titles.c.shop_item_id == item["id"])
            ).mappings().first()
            if not existing_title:
                conn.execute(insert(user_titles).values(
                    user_id=user["id"], shop_item_id=item["id"], is_active=1,
                ))
            else:
                conn.execute(update(user_titles).where(user_titles.c.id == existing_title["id"]).values(is_active=1))

        balance = conn.execute(select(users.c.coins).where(users.c.id == user["id"])).scalar()

    await manager.send_user(user["id"], "wallet.update", {"coins": balance})
    return json_ok({"item": item, "coins": balance, "owned": True})


@app.post("/api/shop/redeem")
async def shop_redeem(item_key: str, user=Depends(get_current_user)):
    """用背包中的 item 兑换；当前简单实现：已拥有物品设为启用/停用。"""
    require_user(user)
    with engine.begin() as conn:
        item = fetch_one(conn, select(shop_items).where(shop_items.c.item_key == item_key))
        if not item:
            return json_error("物品不存在")
        existing = conn.execute(
            select(user_items).where(user_items.c.user_id == user["id"], user_items.c.shop_item_id == item["id"])
        ).mappings().first()
        if not existing:
            return json_error("你尚未拥有该物品，请先购买或赠送获得")
        toggle = 0 if existing["is_active"] else 1
        conn.execute(update(user_items).where(user_items.c.id == existing["id"]).values(is_active=toggle))
        if item["category"] == "title":
            conn.execute(update(user_titles).where(
                user_titles.c.user_id == user["id"], user_titles.c.shop_item_id == item["id"]
            ).values(is_active=toggle))
    return json_ok({"item": item, "is_active": bool(toggle)})


@app.get("/api/me/inventory")
async def my_inventory(user=Depends(get_current_user)):
    """当前用户拥有的全部物品 + 称号 + 装扮。"""
    require_user(user)
    with engine.connect() as conn:
        items = fetch_all(conn,
            select(user_items, shop_items.c.item_key, shop_items.c.name, shop_items.c.icon, shop_items.c.category)
            .join(shop_items, user_items.c.shop_item_id == shop_items.c.id)
            .where(user_items.c.user_id == user["id"])
            .order_by(shop_items.c.category, shop_items.c.name)
        )
        titles = fetch_all(conn,
            select(user_titles, shop_items.c.item_key, shop_items.c.name, shop_items.c.icon)
            .join(shop_items, user_titles.c.shop_item_id == shop_items.c.id)
            .where(user_titles.c.user_id == user["id"])
            .order_by(user_titles.c.is_active.desc())
        )
    return json_ok({"items": items, "titles": titles})


# ============ 平台数据统计 & 商城管理（管理员） ============

class AdminLoginReq(BaseModel):
    username: str
    password: str


@app.post("/api/admin/login")
async def admin_login(req: AdminLoginReq, request: Request):
    """管理员登录：校验账号密码（加盐哈希），通过后返回带过期时间的签名 token。"""
    ip = _get_client_ip(request)
    now = time.time()
    # 清理 1 分钟前的失败记录
    _admin_login_failures[ip] = [t for t in _admin_login_failures.get(ip, []) if now - t < 60]
    if len(_admin_login_failures[ip]) >= ADMIN_LOGIN_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="尝试次数过多，请 1 分钟后再试")
    # 密码加盐哈希比对，不保留明文
    password_hash = hashlib.sha256((req.password + TOKEN_SECRET).encode()).hexdigest()
    if req.username.strip() == ADMIN_USERNAME and hmac.compare_digest(password_hash, ADMIN_PASSWORD_HASH):
        _admin_login_failures.pop(ip, None)  # 登录成功，清除失败记录
        return json_ok({"token": hash_admin_token(), "username": ADMIN_USERNAME, "expire_hours": ADMIN_TOKEN_EXPIRE_HOURS})
    # 登录失败，记录时间戳
    _admin_login_failures.setdefault(ip, []).append(now)
    raise HTTPException(status_code=401, detail="账号或密码错误")


# 允许后台编辑的支付配置字段白名单
_PAY_CONFIG_FIELDS = set(PAY_CONFIG_DEFAULTS.keys())


@app.get("/api/admin/pay-config")
async def admin_pay_config_get(user=Depends(require_admin)):
    """读取支付配置（私钥字段脱敏返回，仅显示首尾）。"""
    cfg = get_pay_config()
    # 私钥脱敏：只显示前 20 + *** + 后 20
    masked = {}
    for k, v in cfg.items():
        if k.endswith("_key") or k.endswith("_private_key") or k.endswith("_public_key"):
            if v and len(v) > 40:
                masked[k] = v[:20] + "***" + v[-20:]
            else:
                masked[k] = v
        else:
            masked[k] = v
    # 附带各支付方式的配置完整度状态
    wx_ready = all([cfg.get("wx_appid"), cfg.get("wx_mchid"), cfg.get("wx_api_v3_key"),
                    cfg.get("wx_serial_no"), cfg.get("wx_private_key")])
    ali_ready = all([cfg.get("ali_appid"), cfg.get("ali_private_key"), cfg.get("ali_public_key")])
    return json_ok({
        "config": masked,
        "pay_enabled": is_pay_enabled(),
        "wx_ready": wx_ready,
        "ali_ready": ali_ready,
    })


@app.post("/api/admin/pay-config")
async def admin_pay_config_save(req: dict, user=Depends(require_admin)):
    """保存支付配置（仅白名单字段）。空字符串表示清空该字段，沿用环境变量兜底。"""
    saved = {}
    with engine.begin() as conn:
        for key, value in req.items():
            if key not in _PAY_CONFIG_FIELDS:
                continue
            val = "" if value is None else str(value).strip()
            # upsert
            existing = conn.execute(select(system_config).where(system_config.c.config_key == key)).first()
            if existing:
                conn.execute(update(system_config).where(system_config.c.config_key == key).values(
                    config_value=val, updated_at=datetime.now(),
                ))
            else:
                conn.execute(insert(system_config).values(
                    config_key=key, config_value=val, updated_at=datetime.now(),
                ))
            saved[key] = val
    invalidate_pay_config_cache()
    cfg = get_pay_config()
    wx_ready = all([cfg.get("wx_appid"), cfg.get("wx_mchid"), cfg.get("wx_api_v3_key"),
                    cfg.get("wx_serial_no"), cfg.get("wx_private_key")])
    ali_ready = all([cfg.get("ali_appid"), cfg.get("ali_private_key"), cfg.get("ali_public_key")])
    return json_ok({
        "saved": saved,
        "pay_enabled": is_pay_enabled(),
        "wx_ready": wx_ready,
        "ali_ready": ali_ready,
        "message": "配置已保存，10 秒内生效",
    })


@app.post("/api/admin/pay-config/test")
async def admin_pay_config_test(req: dict, user=Depends(require_admin)):
    """测试支付连通性：用测试订单号调起下单，验证签名/证书是否正确。"""
    method = str(req.get("method") or "").strip()
    test_no = make_order_no("TEST")
    if method == "wechat":
        result = wx_native_pay(test_no, 0.01, "支付连通性测试")
        return json_ok({"method": "wechat", "out_trade_no": test_no, "result": result})
    elif method == "alipay":
        result = ali_wap_pay(test_no, 0.01, "支付连通性测试")
        return json_ok({"method": "alipay", "out_trade_no": test_no, "result": result})
    return json_error("method 必须是 wechat 或 alipay")


# ============================================================
# 管理后台：全模块接口
# ============================================================

def _paginate(query, page: int, size: int):
    """通用分页：返回 (rows, total)。query 需是 select 语句。"""
    page = max(1, int(page or 1))
    size = min(100, max(1, int(size or 20)))
    return query.limit(size).offset((page - 1) * size), page, size


# ---------- 用户管理 ----------
@app.get("/api/admin/users")
async def admin_users(page: int = 1, size: int = 20, keyword: str = "", user=Depends(require_admin)):
    """用户列表：支持搜索（手机号/昵称）、分页。"""
    with engine.connect() as conn:
        stmt = select(users)
        if keyword:
            kw = f"%{keyword}%"
            stmt = stmt.where(or_(users.c.phone.like(kw), users.c.nickname.like(kw)))
        total = conn.execute(select(func.count()).select_from(stmt.subquery())).scalar()
        stmt = stmt.order_by(desc(users.c.id))
        stmt, page, size = _paginate(stmt, page, size)
        rows = fetch_all(conn, stmt)
    return json_ok({"list": rows, "total": total, "page": page, "size": size})


@app.get("/api/admin/users/{user_id}")
async def admin_user_detail(user_id: int, user=Depends(require_admin)):
    """用户详情 + 钱包 + 订单。"""
    with engine.connect() as conn:
        u = fetch_one(conn, select(users).where(users.c.id == user_id))
        if not u:
            return json_error("用户不存在")
        u_orders = fetch_all(conn, select(orders).where(orders.c.user_id == user_id).order_by(desc(orders.c.id)).limit(10))
        u_txs = fetch_all(conn, select(wallet_transactions).where(wallet_transactions.c.user_id == user_id).order_by(desc(wallet_transactions.c.id)).limit(10))
        rn = fetch_one(conn, text("SELECT real_name, id_card, face_image, status, reject_reason, verified_at FROM real_names WHERE user_id = :uid").bindparams(uid=user_id))
    return json_ok({"user": u, "orders": u_orders, "transactions": u_txs, "realname": rn})


@app.post("/api/admin/users/{user_id}/ban")
async def admin_user_ban(user_id: int, req: dict, user=Depends(require_admin)):
    """封禁用户。"""
    reason = str(req.get("reason") or "违反社区规则")[:200]
    with engine.begin() as conn:
        conn.execute(update(users).where(users.c.id == user_id).values(is_banned=1, ban_reason=reason))
    return json_ok({"banned": True, "user_id": user_id})


@app.post("/api/admin/users/{user_id}/unban")
async def admin_user_unban(user_id: int, user=Depends(require_admin)):
    """解禁用户。"""
    with engine.begin() as conn:
        conn.execute(update(users).where(users.c.id == user_id).values(is_banned=0, ban_reason=None))
    return json_ok({"banned": False, "user_id": user_id})


@app.get("/api/admin/realname")
async def admin_realname_list(page: int = 1, size: int = 20, status: int = 0, user=Depends(require_admin)):
    """实名认证审核列表。status: 0=全部 1=审核中 2=已通过 3=已拒绝。"""
    with engine.connect() as conn:
        stmt = text("SELECT rn.*, u.nickname, u.avatar FROM real_names rn JOIN users u ON u.id = rn.user_id")
        params = {}
        if status:
            stmt = text(str(stmt) + " WHERE rn.status = :st ORDER BY rn.id DESC")
            params["st"] = status
        else:
            stmt = text(str(stmt) + " ORDER BY rn.id DESC")
        total = conn.execute(text(f"SELECT COUNT(*) FROM real_names {'WHERE status = :st' if status else ''}"), params).scalar()
        offset = (max(1, page) - 1) * min(100, max(1, size))
        rows = conn.execute(text(str(stmt) + f" LIMIT {min(100,max(1,size))} OFFSET {offset}"), params).mappings().all()
        rows = [dict(r) for r in rows]
    return json_ok({"list": rows, "total": total, "page": page, "size": size})


@app.post("/api/admin/realname/{user_id}/review")
async def admin_realname_review(user_id: int, req: dict, user=Depends(require_admin)):
    """实名审核：pass=1通过 / 0拒绝。"""
    passed = bool(req.get("pass"))
    reason = str(req.get("reason") or "")[:200]
    with engine.begin() as conn:
        if passed:
            conn.execute(text("UPDATE real_names SET status=2, verified_at=CURRENT_TIMESTAMP WHERE user_id=:uid").bindparams(uid=user_id))
            conn.execute(update(users).where(users.c.id == user_id).values(is_realname=1, realname_status=2))
        else:
            conn.execute(text("UPDATE real_names SET status=3, reject_reason=:rr WHERE user_id=:uid").bindparams(rr=reason, uid=user_id))
            conn.execute(update(users).where(users.c.id == user_id).values(is_realname=0, realname_status=3))
    return json_ok({"reviewed": True, "user_id": user_id, "passed": passed})


# ---------- 内容管理 ----------
@app.get("/api/admin/posts")
async def admin_posts(page: int = 1, size: int = 20, keyword: str = "", user=Depends(require_admin)):
    """动态列表，支持搜索内容。"""
    with engine.connect() as conn:
        stmt = select(posts.c.id, posts.c.user_id, posts.c.content, posts.c.post_type, posts.c.likes, posts.c.comments, posts.c.created_at, users.c.nickname).join(users, users.c.id == posts.c.user_id)
        if keyword:
            stmt = stmt.where(posts.c.content.like(f"%{keyword}%"))
        total = conn.execute(select(func.count()).select_from(stmt.subquery())).scalar()
        stmt = stmt.order_by(desc(posts.c.id))
        stmt, page, size = _paginate(stmt, page, size)
        rows = fetch_all(conn, stmt)
    return json_ok({"list": rows, "total": total, "page": page, "size": size})


@app.delete("/api/admin/posts/{post_id}")
async def admin_post_delete(post_id: int, user=Depends(require_admin)):
    """删除动态。"""
    with engine.begin() as conn:
        conn.execute(delete(posts).where(posts.c.id == post_id))
        conn.execute(delete(post_comments).where(post_comments.c.post_id == post_id))
        conn.execute(delete(post_likes).where(post_likes.c.post_id == post_id))
    return json_ok({"deleted": post_id})


@app.get("/api/admin/comments")
async def admin_comments(page: int = 1, size: int = 20, user=Depends(require_admin)):
    """评论列表。"""
    with engine.connect() as conn:
        total = conn.execute(select(func.count(post_comments.c.id))).scalar()
        stmt = select(post_comments, users.c.nickname).join(users, users.c.id == post_comments.c.user_id).order_by(desc(post_comments.c.id))
        stmt, page, size = _paginate(stmt, page, size)
        rows = fetch_all(conn, stmt)
    return json_ok({"list": rows, "total": total, "page": page, "size": size})


@app.delete("/api/admin/comments/{comment_id}")
async def admin_comment_delete(comment_id: int, user=Depends(require_admin)):
    """删除评论。"""
    with engine.begin() as conn:
        conn.execute(delete(post_comments).where(post_comments.c.id == comment_id))
    return json_ok({"deleted": comment_id})


@app.get("/api/admin/circles")
async def admin_circles(user=Depends(require_admin)):
    """圈子列表。"""
    with engine.connect() as conn:
        rows = fetch_all(conn, select(circles).order_by(desc(circles.c.members)))
    return json_ok(rows)


@app.delete("/api/admin/circles/{circle_id}")
async def admin_circle_delete(circle_id: int, user=Depends(require_admin)):
    """删除圈子。"""
    with engine.begin() as conn:
        conn.execute(delete(circles).where(circles.c.id == circle_id))
    return json_ok({"deleted": circle_id})


# ---------- 语音房管理 ----------
@app.get("/api/admin/rooms")
async def admin_rooms(page: int = 1, size: int = 20, user=Depends(require_admin)):
    """语音房列表。"""
    with engine.connect() as conn:
        total = conn.execute(select(func.count(voice_rooms.c.id))).scalar()
        stmt = select(voice_rooms.c.id, voice_rooms.c.topic, voice_rooms.c.category, voice_rooms.c.listeners, voice_rooms.c.status, voice_rooms.c.started_at, users.c.nickname.label("host_name")).join(users, users.c.id == voice_rooms.c.host_id).order_by(desc(voice_rooms.c.id))
        stmt, page, size = _paginate(stmt, page, size)
        rows = fetch_all(conn, stmt)
    return json_ok({"list": rows, "total": total, "page": page, "size": size})


@app.post("/api/admin/rooms/{room_id}/close")
async def admin_room_close(room_id: int, user=Depends(require_admin)):
    """解散/封禁语音房。"""
    with engine.begin() as conn:
        conn.execute(update(voice_rooms).where(voice_rooms.c.id == room_id).values(status="closed"))
    return json_ok({"closed": room_id})


# ---------- 聊天管理 ----------
@app.get("/api/admin/chat/conversations")
async def admin_chat_conversations(page: int = 1, size: int = 20, user=Depends(require_admin)):
    """会话列表。"""
    with engine.connect() as conn:
        total = conn.execute(select(func.count(chat_conversations.c.id))).scalar()
        stmt = select(chat_conversations.c.id, chat_conversations.c.user1_id, chat_conversations.c.user2_id, chat_conversations.c.created_at).order_by(desc(chat_conversations.c.id))
        stmt, page, size = _paginate(stmt, page, size)
        rows = fetch_all(conn, stmt)
    return json_ok({"list": rows, "total": total, "page": page, "size": size})


@app.get("/api/admin/chat/messages/{conversation_id}")
async def admin_chat_messages(conversation_id: int, page: int = 1, size: int = 50, user=Depends(require_admin)):
    """查看会话消息。"""
    with engine.connect() as conn:
        total = conn.execute(select(func.count(chat_messages.c.id)).where(chat_messages.c.conversation_id == conversation_id)).scalar()
        stmt = select(chat_messages, users.c.nickname).join(users, users.c.id == chat_messages.c.sender_id).where(chat_messages.c.conversation_id == conversation_id).order_by(desc(chat_messages.c.id))
        stmt, page, size = _paginate(stmt, page, size)
        rows = fetch_all(conn, stmt)
    return json_ok({"list": rows, "total": total, "page": page, "size": size})


@app.delete("/api/admin/chat/messages/{msg_id}")
async def admin_chat_message_delete(msg_id: int, user=Depends(require_admin)):
    """删除违规消息。"""
    with engine.begin() as conn:
        conn.execute(delete(chat_messages).where(chat_messages.c.id == msg_id))
    return json_ok({"deleted": msg_id})


# ---------- 礼物管理 ----------
@app.get("/api/admin/gifts")
async def admin_gifts(user=Depends(require_admin)):
    """礼物列表（金币/钻石）+ 分成配置。"""
    with engine.connect() as conn:
        host_ratio = conn.execute(select(system_config.c.config_value).where(system_config.c.config_key == "gift_host_ratio")).scalar() or "0.3"
    return json_ok({
        "coin_gifts": [{"key": k, **v} for k, v in COIN_GIFTS.items()],
        "diamond_gifts": [{"key": k, **v} for k, v in DIAMOND_GIFTS.items()],
        "host_ratio": float(host_ratio),
        "platform_ratio": round(1 - float(host_ratio), 2),
    })


@app.post("/api/admin/gifts/ratio")
async def admin_gift_ratio(req: dict, user=Depends(require_admin)):
    """设置金币礼物房主分成比例（0~1），平台分成 = 1 - 该值。"""
    ratio = float(req.get("host_ratio", 0.3))
    ratio = max(0.0, min(1.0, ratio))
    with engine.begin() as conn:
        existing = conn.execute(select(system_config).where(system_config.c.config_key == "gift_host_ratio")).first()
        if existing:
            conn.execute(update(system_config).where(system_config.c.config_key == "gift_host_ratio").values(config_value=str(ratio)))
        else:
            conn.execute(insert(system_config).values(config_key="gift_host_ratio", config_value=str(ratio)))
    return json_ok({"host_ratio": ratio, "platform_ratio": round(1 - ratio, 2)})


# ---------- 财务管理 ----------
@app.get("/api/admin/orders")
async def admin_orders(page: int = 1, size: int = 20, status: str = "", user=Depends(require_admin)):
    """订单列表，支持按状态筛选。"""
    with engine.connect() as conn:
        stmt = select(orders, users.c.nickname).join(users, users.c.id == orders.c.user_id)
        if status:
            stmt = stmt.where(orders.c.status == status)
        total = conn.execute(select(func.count()).select_from(stmt.subquery())).scalar()
        stmt = stmt.order_by(desc(orders.c.id))
        stmt, page, size = _paginate(stmt, page, size)
        rows = fetch_all(conn, stmt)
    return json_ok({"list": rows, "total": total, "page": page, "size": size})


@app.get("/api/admin/finance")
async def admin_finance(user=Depends(require_admin)):
    """财务统计：充值总额、VIP 收入、平台分成、订单数。"""
    with engine.connect() as conn:
        recharge_total = conn.execute(select(func.coalesce(func.sum(orders.c.amount), 0)).where(orders.c.status == "success", orders.c.plan.like("coins_%"))).scalar() or 0
        vip_total = conn.execute(select(func.coalesce(func.sum(orders.c.amount), 0)).where(orders.c.status == "success", ~orders.c.plan.like("coins_%"))).scalar() or 0
        order_count = conn.execute(select(func.count(orders.c.id)).where(orders.c.status == "success")).scalar() or 0
        tx_count = conn.execute(select(func.count(wallet_transactions.c.id))).scalar() or 0
    return json_ok({
        "recharge_total": recharge_total,
        "vip_total": vip_total,
        "total_revenue": recharge_total + vip_total,
        "order_count": order_count,
        "transaction_count": tx_count,
        "platform_coins": PLATFORM_WALLET["coins"],
    })


@app.get("/api/admin/transactions")
async def admin_transactions(page: int = 1, size: int = 20, kind: str = "", user=Depends(require_admin)):
    """钱包流水列表。"""
    with engine.connect() as conn:
        stmt = select(wallet_transactions, users.c.nickname).join(users, users.c.id == wallet_transactions.c.user_id)
        if kind:
            stmt = stmt.where(wallet_transactions.c.kind == kind)
        total = conn.execute(select(func.count()).select_from(stmt.subquery())).scalar()
        stmt = stmt.order_by(desc(wallet_transactions.c.id))
        stmt, page, size = _paginate(stmt, page, size)
        rows = fetch_all(conn, stmt)
    return json_ok({"list": rows, "total": total, "page": page, "size": size})


# ---------- 系统设置：公告 / Banner / 功能开关 ----------
@app.get("/api/admin/settings")
async def admin_settings_get(user=Depends(require_admin)):
    """读取系统设置（公告、Banner、功能开关）。"""
    keys = ["announcement", "banner", "feature_post", "feature_voice", "feature_match", "feature_shop"]
    with engine.connect() as conn:
        rows = conn.execute(select(system_config).where(system_config.c.config_key.in_(keys))).mappings().all()
    data = {r["config_key"]: r["config_value"] for r in rows}
    for k in keys:
        data.setdefault(k, "")
    return json_ok(data)


@app.post("/api/admin/settings")
async def admin_settings_save(req: dict, user=Depends(require_admin)):
    """保存系统设置。"""
    saved = {}
    with engine.begin() as conn:
        for key, val in req.items():
            v = "" if val is None else str(val)
            existing = conn.execute(select(system_config).where(system_config.c.config_key == key)).first()
            if existing:
                conn.execute(update(system_config).where(system_config.c.config_key == key).values(config_value=v, updated_at=datetime.now()))
            else:
                conn.execute(insert(system_config).values(config_key=key, config_value=v, updated_at=datetime.now()))
            saved[key] = v
    return json_ok(saved)


# ---------- 增强数据看板 ----------
@app.get("/api/admin/dashboard")
async def admin_dashboard(user=Depends(require_admin)):
    """运营数据看板：核心指标。"""
    today = datetime.now().strftime("%Y-%m-%d")
    with engine.connect() as conn:
        total_users = conn.execute(select(func.count(users.c.id))).scalar() or 0
        vip_users = conn.execute(select(func.count(users.c.id)).where(users.c.is_vip == 1)).scalar() or 0
        banned_users = conn.execute(select(func.count(users.c.id)).where(users.c.is_banned == 1)).scalar() or 0
        today_users = conn.execute(select(func.count(users.c.id)).where(func.date(users.c.created_at) == today)).scalar() or 0
        total_posts = conn.execute(select(func.count(posts.c.id))).scalar() or 0
        total_rooms = conn.execute(select(func.count(voice_rooms.c.id))).scalar() or 0
        active_rooms = conn.execute(select(func.count(voice_rooms.c.id)).where(voice_rooms.c.status == "live")).scalar() or 0
        total_orders = conn.execute(select(func.count(orders.c.id))).scalar() or 0
        paid_orders = conn.execute(select(func.count(orders.c.id)).where(orders.c.status == "success")).scalar() or 0
        revenue = conn.execute(select(func.coalesce(func.sum(orders.c.amount), 0)).where(orders.c.status == "success")).scalar() or 0
        realname_pending = conn.execute(text("SELECT COUNT(*) FROM real_names WHERE status=1")).scalar() or 0
    return json_ok({
        "total_users": total_users, "vip_users": vip_users, "banned_users": banned_users,
        "today_new_users": today_users, "total_posts": total_posts,
        "total_rooms": total_rooms, "active_rooms": active_rooms,
        "total_orders": total_orders, "paid_orders": paid_orders, "revenue": revenue,
        "realname_pending": realname_pending,
    })


@app.get("/api/platform/stats")
async def platform_stats(user=Depends(require_admin)):
    """平台整体数据：用户数、礼物总收入、平台收入、商城物品数。"""
    with engine.connect() as conn:
        users_count = conn.execute(select(func.count(users.c.id))).scalar() or 0
        gifts_sent = conn.execute(select(func.count(wallet_transactions.c.id)).where(
            wallet_transactions.c.kind == "gift"
        )).scalar() or 0
        gift_revenue = conn.execute(select(func.coalesce(func.sum(func.abs(wallet_transactions.c.coins)), 0)).where(
            wallet_transactions.c.kind == "gift"
        )).scalar() or 0
        shop_count = conn.execute(select(func.count(shop_items.c.id))).scalar() or 0
        shop_available = conn.execute(select(func.count(shop_items.c.id)).where(shop_items.c.available == 1)).scalar() or 0
        top_gifts = fetch_all(conn, select(room_messages.c.gift_name, func.count(room_messages.c.id).label("count"), func.coalesce(func.sum(room_messages.c.gift_count), 0).label("total")).where(room_messages.c.msg_type == "gift").group_by(room_messages.c.gift_name).order_by(desc("count")).limit(10))
        top_rooms = fetch_all(conn, select(voice_rooms.c.id, voice_rooms.c.topic, func.count(room_messages.c.id).label("gift_count")).join(room_messages, voice_rooms.c.id == room_messages.c.room_id).where(room_messages.c.msg_type == "gift").group_by(voice_rooms.c.id).order_by(desc("gift_count")).limit(5))
    return json_ok({
        "users": users_count,
        "gifts_sent_transactions": gifts_sent,
        "gifts_total_coins": gift_revenue,
        "platform_coins": PLATFORM_WALLET["coins"],
        "shop_items": shop_count,
        "shop_available": shop_available,
        "top_gifts": top_gifts,
        "top_rooms": top_rooms,
    })


@app.get("/api/admin/shop")
async def admin_shop_list(user=Depends(require_admin)):
    """管理员：商城全量物品（含下架）。"""
    with engine.connect() as conn:
        items = fetch_all(conn, select(shop_items).order_by(shop_items.c.category, shop_items.c.price))
    return json_ok(items)


@app.get("/api/admin/shop/{item_id}")
async def admin_shop_detail(item_id: int, user=Depends(require_admin)):
    """管理员：获取单个商城物品详情。"""
    with engine.connect() as conn:
        item = fetch_one(conn, select(shop_items).where(shop_items.c.id == item_id))
    if not item:
        return json_error("物品不存在")
    return json_ok(item)


@app.post("/api/admin/shop")
async def admin_shop_create(req: dict, user=Depends(require_admin)):
    """管理员：新增商城物品。"""
    item_key = str(req.get("item_key") or "").strip()[:40]
    name = str(req.get("name") or "").strip()[:80]
    if not item_key or not name:
        return json_error("item_key 和 name 必填")
    category = str(req.get("category") or "gift").strip()[:20]
    if category not in ("gift", "title", "avatar_frame", "bubble", "effect"):
        return json_error("category 必须是 gift/title/avatar_frame/bubble/effect")
    icon = str(req.get("icon") or "🎁").strip()[:32]
    price = int(req.get("price") or 0)
    if price < 0:
        return json_error("price 不能为负数")
    description = str(req.get("description") or "")[:255]
    image_url = str(req.get("image_url") or "")[:500]
    favorability_boost = int(req.get("favorability_boost") or 0)
    unlock_favorability = int(req.get("unlock_favorability") or 0)
    available = 1 if req.get("available", 1) else 0
    with engine.begin() as conn:
        existing = fetch_one(conn, select(shop_items).where(shop_items.c.item_key == item_key))
        if existing:
            return json_error(f"item_key '{item_key}' 已存在")
        result = conn.execute(insert(shop_items).values(
            item_key=item_key, name=name, icon=icon, category=category,
            price=price, description=description, image_url=image_url,
            favorability_boost=favorability_boost,
            unlock_favorability=unlock_favorability, available=available,
        ))
        item = fetch_one(conn, select(shop_items).where(shop_items.c.id == inserted_id(result)))
    return json_ok(item)


@app.put("/api/admin/shop/{item_id}")
async def admin_shop_update(item_id: int, req: dict, user=Depends(require_admin)):
    """管理员：修改商城物品。"""
    with engine.begin() as conn:
        item = fetch_one(conn, select(shop_items).where(shop_items.c.id == item_id))
        if not item:
            return json_error("物品不存在")
        updates = {}
        if "name" in req:
            updates["name"] = str(req["name"])[:80]
        if "icon" in req:
            updates["icon"] = str(req["icon"])[:32]
        if "category" in req and req["category"] in ("gift", "title", "avatar_frame", "bubble", "effect"):
            updates["category"] = str(req["category"])[:20]
        if "price" in req:
            price = int(req["price"])
            if price < 0:
                return json_error("price 不能为负数")
            updates["price"] = price
        if "description" in req:
            updates["description"] = str(req["description"])[:255]
        if "image_url" in req:
            updates["image_url"] = str(req["image_url"])[:500]
        if "favorability_boost" in req:
            updates["favorability_boost"] = int(req["favorability_boost"])
        if "unlock_favorability" in req:
            updates["unlock_favorability"] = int(req["unlock_favorability"])
        if "available" in req:
            updates["available"] = 1 if req["available"] else 0
        if updates:
            conn.execute(update(shop_items).where(shop_items.c.id == item_id).values(**updates))
        updated = fetch_one(conn, select(shop_items).where(shop_items.c.id == item_id))
    return json_ok(updated)


@app.delete("/api/admin/shop/{item_id}")
async def admin_shop_delete(item_id: int, user=Depends(require_admin)):
    """管理员：下架商城物品（软删除：available=0）。"""
    with engine.begin() as conn:
        item = fetch_one(conn, select(shop_items).where(shop_items.c.id == item_id))
        if not item:
            return json_error("物品不存在")
        conn.execute(update(shop_items).where(shop_items.c.id == item_id).values(available=0))
    return json_ok({"deleted": item_id, "name": item["name"]})


# ---------- 好感度 ----------

@app.get("/api/favorites")
async def list_favorites(user=Depends(get_current_user)):
    """当前用户对所有好友的好感度列表。"""
    require_user(user)
    with engine.connect() as conn:
        rows = fetch_all(conn,
            select(user_favorites, users.c.nickname, users.c.avatar)
            .join(users, user_favorites.c.to_user_id == users.c.id)
            .where(user_favorites.c.from_user_id == user["id"])
            .order_by(user_favorites.c.value.desc())
        )
        # 补充双向好感度和关系
        for row in rows:
            mutual_row = conn.execute(
                select(user_favorites.c.value).where(
                    user_favorites.c.from_user_id == row["to_user_id"], user_favorites.c.to_user_id == user["id"]
                )
            ).scalar() or 0
            row["mutual"] = row["value"] + mutual_row
            row["reverse"] = mutual_row
            active_rels = fetch_all(conn,
                select(user_relationships).where(
                    or_(
                        and_(user_relationships.c.user1_id == user["id"], user_relationships.c.user2_id == row["to_user_id"]),
                        and_(user_relationships.c.user1_id == row["to_user_id"], user_relationships.c.user2_id == user["id"]),
                    ),
                    user_relationships.c.status == "active",
                )
            )
            row["relationships"] = [r["rel_type"] for r in active_rels]
            # 计算下一关系还差多少
            row["next_rel"] = None
            for rel_type, meta in sorted(RELATION_TYPES.items(), key=lambda kv: kv[1]["favorability_required"]):
                if row["mutual"] < meta["favorability_required"]:
                    row["next_rel"] = {
                        "type": rel_type,
                        "name": meta["name"],
                        "icon": meta["icon"],
                        "required": meta["favorability_required"],
                        "progress": min(100, row["mutual"] / meta["favorability_required"] * 100),
                        "delta": meta["favorability_required"] - row["mutual"],
                    }
                    break
    return json_ok(rows)


@app.get("/api/favorites/{peer_id}")
async def get_favorite(peer_id: int, user=Depends(get_current_user)):
    """查看与某个具体用户的好感度（双向）。"""
    require_user(user)
    with engine.connect() as conn:
        get_user_required(conn, peer_id)
        a_to_b = fetch_one(conn,
            select(user_favorites).where(
                user_favorites.c.from_user_id == user["id"], user_favorites.c.to_user_id == peer_id
            )
        )
        b_to_a = fetch_one(conn,
            select(user_favorites).where(
                user_favorites.c.from_user_id == peer_id, user_favorites.c.to_user_id == user["id"]
            )
        )
        active_rels = fetch_all(conn,
            select(user_relationships).where(
                or_(
                    and_(user_relationships.c.user1_id == user["id"], user_relationships.c.user2_id == peer_id),
                    and_(user_relationships.c.user1_id == peer_id, user_relationships.c.user2_id == user["id"]),
                ),
                user_relationships.c.status == "active",
            )
        )
    return json_ok({
        "from_me": a_to_b or {"value": 0},
        "to_me": b_to_a or {"value": 0},
        "mutual": (a_to_b or {}).get("value", 0) + (b_to_a or {}).get("value", 0),
        "relationships": active_rels,
        "relation_meta": RELATION_TYPES,
    })


@app.post("/api/favorites/{peer_id}/manual")
async def add_favorite_manual(peer_id: int, payload: dict, user=Depends(get_current_user)):
    """手动增加好感度（调试用：发送一条语音房消息/通话记录后触发）。"""
    require_user(user)
    delta = int(payload.get("delta") or 0)
    source = str(payload.get("source") or "manual")
    if delta <= 0 or delta > 200:
        return json_error("好感度增量必须在 1-200 之间")
    with engine.begin() as conn:
        get_user_required(conn, peer_id)
        new_fav = adjust_favorability(conn, user["id"], peer_id, delta, gift=False)
        rel_info = update_relationship_on_favorability(conn, user["id"], peer_id)
    return json_ok({"favorability": new_fav, "delta": delta, "source": source, "relationships": rel_info})


# ---------- 关系 ----------

@app.get("/api/relationships")
async def list_relationships(user=Depends(get_current_user)):
    """当前用户所有已建立的绑定关系。"""
    require_user(user)
    with engine.connect() as conn:
        rows = fetch_all(conn,
            select(user_relationships, users.c.id.label("peer_id"), users.c.nickname, users.c.avatar)
            .join(users, or_(
                and_(user_relationships.c.user1_id == users.c.id, user_relationships.c.user2_id == user["id"]),
                and_(user_relationships.c.user2_id == users.c.id, user_relationships.c.user1_id == user["id"]),
            ))
            .where(or_(
                and_(user_relationships.c.user1_id == user["id"], user_relationships.c.user2_id != user["id"]),
                and_(user_relationships.c.user2_id == user["id"], user_relationships.c.user1_id != user["id"]),
            ), user_relationships.c.status == "active")
            .order_by(user_relationships.c.bound_at.desc())
        )
    for row in rows:
        rel = RELATION_TYPES.get(row["rel_type"], {})
        row["rel_name"] = rel.get("name", row["rel_type"])
        row["rel_icon"] = rel.get("icon", "💞")
        row["rel_color"] = rel.get("color", "#ec4899")
    return json_ok(rows)


@app.post("/api/relationships/bind")
async def bind_relationship(req: RelationshipReq, user=Depends(get_current_user)):
    """主动申请/确认绑定关系；双方必须已达到好感度阈值。"""
    require_user(user)
    meta = RELATION_TYPES.get(req.rel_type)
    if not meta:
        return json_error(f"未知关系类型：{req.rel_type}")
    with engine.begin() as conn:
        get_user_required(conn, req.target_id)
        if req.target_id == user["id"]:
            return json_error("不能和自己绑定关系")

        # 计算双向好感度总和
        a_to_b = conn.execute(
            select(func.coalesce(func.sum(user_favorites.c.value), 0)).where(
                user_favorites.c.from_user_id == user["id"], user_favorites.c.to_user_id == req.target_id
            )
        ).scalar() or 0
        b_to_a = conn.execute(
            select(func.coalesce(func.sum(user_favorites.c.value), 0)).where(
                user_favorites.c.from_user_id == req.target_id, user_favorites.c.to_user_id == user["id"]
            )
        ).scalar() or 0
        mutual = a_to_b + b_to_a
        if mutual < meta["favorability_required"]:
            return json_error(f"双方好感度仅 {mutual}，需要 {meta['favorability_required']} 才能绑定为「{meta['name']}」")

        # 检查对方是否也愿意（简化：直接绑定，后续可加申请流程）
        low, high = sorted([user["id"], req.target_id])
        existing = conn.execute(
            select(user_relationships).where(
                user_relationships.c.user1_id == low, user_relationships.c.user2_id == high,
                user_relationships.c.rel_type == req.rel_type,
            )
        ).mappings().first()

        if existing and existing["status"] == "active":
            return json_error("你们已经是这种关系了")

        if existing:
            conn.execute(update(user_relationships).where(user_relationships.c.id == existing["id"]).values(
                favorability=mutual, status="active", bound_at=datetime.now(), broken_at=None,
            ))
        else:
            conn.execute(insert(user_relationships).values(
                user1_id=low, user2_id=high, rel_type=req.rel_type,
                favorability=mutual, status="active", bound_at=datetime.now(),
            ))

        unlock_item_for_pair(conn, req.rel_type, low, high)

    # 推送双方绑定通知
    await manager.send_user(user["id"], "relationship.bound", {
        "with_user_id": req.target_id, "rel_type": req.rel_type,
        "mutual_favorability": mutual, "icon": meta["icon"], "name": meta["name"],
    })
    await manager.send_user(req.target_id, "relationship.bound", {
        "with_user_id": user["id"], "rel_type": req.rel_type,
        "mutual_favorability": mutual, "icon": meta["icon"], "name": meta["name"],
    })

    return json_ok({"rel_type": req.rel_type, "rel_name": meta["name"], "rel_icon": meta["icon"], "mutual_favorability": mutual})


@app.post("/api/relationships/{rel_type}/break")
async def break_relationship(rel_type: str, payload: dict, user=Depends(get_current_user)):
    target_id = int(payload.get("target_id") or 0)
    require_user(user)
    if not target_id:
        return json_error("缺少 target_id")
    meta = RELATION_TYPES.get(rel_type)
    if not meta:
        return json_error(f"未知关系类型：{rel_type}")
    with engine.begin() as conn:
        low, high = sorted([user["id"], target_id])
        conn.execute(update(user_relationships).where(
            user_relationships.c.user1_id == low, user_relationships.c.user2_id == high,
            user_relationships.c.rel_type == rel_type, user_relationships.c.status == "active",
        ).values(status="broken", broken_at=datetime.now()))
    return json_ok({"status": "broken", "rel_type": rel_type})


@app.get("/api/rel-types")
async def rel_types():
    """返回全部关系类型及其解锁条件。"""
    return json_ok(RELATION_TYPES)


@app.get("/admin")
async def admin_page():
    return FileResponse(str(STATIC_DIR / "admin.html"))


@app.get("/{full_path:path}")
async def serve_static(full_path: str):
    allowed = {".html", ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webmanifest", ".webp", ".bmp", ".mp4", ".webm", ".mov", ".m4v", ".mp3", ".m4a", ".wav", ".aac"}
    candidate = (STATIC_DIR / full_path).resolve()
    try:
        candidate.relative_to(STATIC_DIR)
    except ValueError:
        raise HTTPException(status_code=403, detail="禁止访问")
    if full_path and candidate.is_file() and candidate.suffix.lower() in allowed:
        return FileResponse(str(candidate))
    # 根路径返回 SPA 首页，其余无效路径返回 404 页面
    if not full_path:
        return FileResponse(str(STATIC_DIR / "index.html"))
    return FileResponse(str(STATIC_DIR / "404.html"), status_code=404)


if __name__ == "__main__":
    import uvicorn
    print("=" * 54)
    print("圈圈语音社 FastAPI 全功能后端")
    print("数据库:", engine.dialect.name, DATABASE_URL)
    print("本地访问: http://127.0.0.1:8090")
    print("API 文档: http://127.0.0.1:8090/docs")
    print("=" * 54)
    uvicorn.run(app, host="0.0.0.0", port=8090, log_level="info")
