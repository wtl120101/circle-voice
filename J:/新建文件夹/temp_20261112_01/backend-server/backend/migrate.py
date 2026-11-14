# -*- coding: utf-8 -*-
"""数据库增量迁移脚本 — 在已有 SQLite 库上安全添加新列/新表。"""
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "circle_voice.db")


def table_columns(conn, table):
    cur = conn.execute(f"PRAGMA table_info({table})")
    return [row[1] for row in cur.fetchall()]


def ensure_table(conn, name, sql):
    conn.execute(f"CREATE TABLE IF NOT EXISTS {name} ({sql})")
    print(f"  [OK] 确保表存在: {name}")


def ensure_column(conn, table, col, col_type, default=None):
    cols = table_columns(conn, table)
    if col not in cols:
        default_clause = f" DEFAULT {default}" if default is not None else ""
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}{default_clause}")
        print(f"  [OK] {table} 新增列: {col} {col_type}{default_clause}")
    else:
        print(f"  [--] {table}.{col} 已存在")


def run():
    conn = sqlite3.connect(DB_PATH)
    print(f"连接数据库: {DB_PATH}")

    # === users 表 ===
    ensure_column(conn, "users", "diamonds", "INTEGER", "0")          # 钻石（免费赠送，只能送钻石礼物）
    ensure_column(conn, "users", "is_realname", "INTEGER", "0")        # 是否实名认证
    ensure_column(conn, "users", "realname_status", "INTEGER", "0")    # 0=未认证 1=审核中 2=已认证 3=拒绝

    # === posts 表（频道帖子） ===
    ensure_column(conn, "posts", "video_url", "TEXT", "NULL")          # 视频地址
    ensure_column(conn, "posts", "images", "TEXT", "NULL")             # 多图 JSON 数组
    ensure_column(conn, "posts", "post_type", "VARCHAR(20)", "'text'") # text/image/video/mixed
    ensure_column(conn, "posts", "title", "VARCHAR(120)", "NULL")       # 帖子标题

    # === voice_rooms 表 ===
    ensure_column(conn, "voice_rooms", "room_type", "VARCHAR(20)", "'multi'")  # single=单人直播  multi=多人语音
    ensure_column(conn, "voice_rooms", "background_music", "TEXT", "NULL")      # 背景音乐 URL
    ensure_column(conn, "voice_rooms", "current_song", "TEXT", "NULL")         # 当前播放歌曲
    ensure_column(conn, "voice_rooms", "mini_game", "VARCHAR(40)", "NULL")     # 多人小游戏 key
    ensure_column(conn, "voice_rooms", "cover_image", "TEXT", "NULL")          # 房间封面

    # === wallet_transactions 表 ===
    ensure_column(conn, "wallet_transactions", "currency", "VARCHAR(10)", "'coins'")  # coins / diamonds

    # === room_messages 表 ===
    ensure_column(conn, "room_messages", "gift_currency", "VARCHAR(10)", "'coins'")

    # === shop_items 表 ===
    ensure_column(conn, "shop_items", "type", "VARCHAR(20)", "'virtual'")        # virtual=虚拟礼物  physical=实物商品
    ensure_column(conn, "shop_items", "stock", "INTEGER", "-1")                  # -1=无限
    ensure_column(conn, "shop_items", "image_url", "TEXT", "NULL")               # 商品图
    ensure_column(conn, "shop_items", "origin_price", "INTEGER", "0")            # 原价
    ensure_column(conn, "shop_items", "sales", "INTEGER", "0")                    # 销量
    ensure_column(conn, "shop_items", "specs", "TEXT", "NULL")                   # 规格 JSON（颜色/尺寸等）
    ensure_column(conn, "shop_items", "ship_from", "VARCHAR(80)", "NULL")         # 发货地
    ensure_column(conn, "shop_items", "currency", "VARCHAR(10)", "'coins'")      # coins / diamonds

    # === 新增实名认证表 ===
    ensure_table(conn, "real_names", """
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
    """)

    # === 新增实物商品订单表 ===
    ensure_table(conn, "product_orders", """
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
    """)

    # === 新增充值订单表 ===
    ensure_table(conn, "recharge_orders", """
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
    """)

    # === 新增音乐播放列表 ===
    ensure_table(conn, "bgm_tracks", """
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title VARCHAR(120) NOT NULL,
        artist VARCHAR(80),
        url TEXT NOT NULL,
        cover TEXT,
        duration INTEGER,
        category VARCHAR(40),
        plays INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    """)

    # === 新增多人小游戏表 ===
    ensure_table(conn, "mini_games", """
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_key VARCHAR(40) UNIQUE NOT NULL,
        name VARCHAR(80) NOT NULL,
        icon VARCHAR(32),
        description TEXT,
        max_players INTEGER DEFAULT 8,
        min_players INTEGER DEFAULT 2,
        available INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    """)

    conn.commit()
    conn.close()
    print("\n✅ 迁移完成！")


if __name__ == "__main__":
    run()
