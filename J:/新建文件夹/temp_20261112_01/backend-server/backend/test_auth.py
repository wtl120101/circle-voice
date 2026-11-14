# -*- coding: utf-8 -*-
"""
验证码登录 & 第三方登录 单元测试
================================
使用 Python 标准库 urllib（无需安装 requests），
直接调用 http://localhost:8090 的 REST API，
覆盖 send-code / login / oauth 三个端点的正常与异常场景。

运行方式：  python test_auth.py
"""
import json
import sys
import urllib.request
import urllib.error
import urllib.parse
import random
import time

# ============ 配置 ============
BASE_URL = "http://localhost:8090"
PASS = "\033[92m✅ PASS\033[0m"
FAIL = "\033[91m❌ FAIL\033[0m"
INFO = "\033[96mℹ️\033[0m"
passed = 0
failed = 0
results = []


def http(method, path, body=None, headers=None, timeout=5):
    """统一请求封装。返回 (status_code, data_dict or None, raw_text)"""
    url = BASE_URL + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw), raw
            except json.JSONDecodeError:
                return resp.status, None, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(raw), raw
        except json.JSONDecodeError:
            return e.code, None, raw
    except Exception as e:
        return 0, None, str(e)


def assert_ok(name, result, check_extra=None):
    global passed, failed
    status, data, raw = result
    if data and data.get("success") is True:
        passed += 1
        extra = f"  — {check_extra(data.get('data') or {})}" if check_extra else ""
        results.append((name, "PASS", extra.strip()))
        print(f"  {PASS} {name}{extra}")
        return data.get("data")
    else:
        failed += 1
        err = (data or {}).get("error", raw[:80] if raw else str(status))
        results.append((name, "FAIL", f"  错误: {err}"))
        print(f"  {FAIL} {name}  — 错误: {err}")
        return None


def assert_error(name, result, expected_substr=None):
    global passed, failed
    status, data, raw = result
    if data and data.get("success") is False:
        msg = data.get("error", "")
        if expected_substr and expected_substr not in msg:
            failed += 1
            results.append((name, "FAIL", f"期望错误包含 '{expected_substr}'，实际: '{msg}'"))
            print(f"  {FAIL} {name}  — 期望错误包含 '{expected_substr}'，实际: '{msg}'")
            return None
        passed += 1
        results.append((name, "PASS", f"  错误信息正确: {msg}"))
        print(f"  {PASS} {name}  — 错误信息正确: {msg}")
        return msg
    else:
        failed += 1
        results.append((name, "FAIL", f"  期望失败，实际 status={status} data={data}"))
        print(f"  {FAIL} {name}  — 期望失败，实际 status={status} data={data}")
        return None


def assert_status(name, result, expected):
    global passed, failed
    status, data, raw = result
    if status == expected:
        passed += 1
        results.append((name, "PASS", f"  HTTP {status}"))
        print(f"  {PASS} {name}  — HTTP {status}")
        return True
    else:
        failed += 1
        results.append((name, "FAIL", f"  期望 HTTP {expected}，实际 {status}"))
        print(f"  {FAIL} {name}  — 期望 HTTP {expected}，实际 {status}")
        return False


# ====================================================
# 0. 服务健康检查
# ====================================================
def test_health():
    print(f"\n{INFO} ======== 0. 服务健康检查 ========")
    result = http("GET", "/api/health")
    assert_ok("health 端点", result, lambda d: f"database={d.get('database')}")


# ====================================================
# 1. send-code 验证码发送
# ====================================================
def test_send_code():
    print(f"\n{INFO} ======== 1. /api/auth/send-code 验证码发送 ========")

    # 1.1 正常手机号
    phone = "139" + f"{random.randint(10000000, 99999999)}"
    result = http("POST", "/api/auth/send-code", {"phone": phone})
    data = assert_ok("正常手机号发送验证码", result)
    if data and "dev_code" in data:
        results.append(("  含 dev_code 返回", "PASS", f"dev_code={data['dev_code']}"))
        print(f"  {PASS} 含 dev_code 返回  — dev_code={data['dev_code']}")
        return phone, data["dev_code"]
    return phone, None

    # 1.2 空手机号
    assert_error("空手机号", http("POST", "/api/auth/send-code", {"phone": ""}), "手机号")
    assert_error("无 phone 字段", http("POST", "/api/auth/send-code", {}), "手机号")

    # 1.3 太短手机号
    assert_error("太短手机号", http("POST", "/api/auth/send-code", {"phone": "123"}), "手机号")


# ====================================================
# 2. login 验证码登录
# ====================================================
def test_login(phone, dev_code):
    global passed, failed
    print(f"\n{INFO} ======== 2. /api/auth/login 验证码登录 ========")

    # 2.1 正常验证码登录
    token = None
    if dev_code:
        result = http("POST", "/api/auth/login", {
            "phone": phone, "code": dev_code, "nickname": "验证码测试用户"
        })
        data = assert_ok("正确验证码 + 新手机号 登录创建账号", result,
                         lambda d: f"token_len={len(d.get('token',''))} coins={d.get('user',{}).get('coins')}")
        if data and data.get("token"):
            token = data["token"]

        # 2.2 同手机号 + 同一 code 再次登录 → code 已被消费（pop），应返回"请先获取验证码"
        result2 = http("POST", "/api/auth/login", {
            "phone": phone, "code": dev_code
        })
        assert_error("code 被消费后再次登录", result2, "请先获取验证码")

        # 2.3 再次发送验证码 + 错误验证码
        result3 = http("POST", "/api/auth/send-code", {"phone": phone})
        if result3[1] and result3[1].get("success"):
            wrong = "000000" if result3[1]["data"].get("dev_code") != "000000" else "111111"
            result4 = http("POST", "/api/auth/login", {"phone": phone, "code": wrong})
            assert_error("错误验证码", result4, "验证码错误")

        # 2.4 没发验证码就登录
        other_phone = "139" + f"{random.randint(10000000, 99999999)}"
        result5 = http("POST", "/api/auth/login", {"phone": other_phone, "code": "654321"})
        assert_error("未发送验证码直接登录", result5, "请先获取验证码")

        # 2.5 无 phone 字段
        assert_error("无 phone 字段", http("POST", "/api/auth/login", {"code": "123456"}), "")
    else:
        print(f"  {INFO} 跳过 login 测试：send-code 未返回 dev_code")

    # 2.6 不传 code 也能登录（开发版放行，生产版应关闭）
    phone_no_code = "139" + f"{random.randint(10000000, 99999999)}"
    result = http("POST", "/api/auth/login", {"phone": phone_no_code, "nickname": "无码测试"})
    if result[1] and result[1].get("success"):
        passed += 1
        results.append(("不传 code 登录（开发版放行）", "PASS", "后端允许无 code 登录"))
        print(f"  {PASS} 不传 code 登录（开发版放行）  — 后端允许无 code 登录")
    else:
        failed += 1
        results.append(("不传 code 登录（开发版放行）", "FAIL", "应该放行但没放行"))
        print(f"  {FAIL} 不传 code 登录（开发版放行）")


# ====================================================
# 3. oauth 第三方登录
# ====================================================
def test_oauth():
    global passed, failed
    print(f"\n{INFO} ======== 3. /api/auth/oauth 第三方登录 ========")

    providers = [
        ("wechat", "wechat_openid_test_001", "微信测试用户"),
        ("qq",      "qq_openid_test_001",      "QQ测试用户"),
        ("apple",   "apple_openid_test_001",   "Apple测试用户"),
    ]
    tokens = []

    # 3.1 首次登录 → 自动创建
    for provider, openid, nickname in providers:
        result = http("POST", "/api/auth/oauth", {
            "provider": provider,
            "openid": openid,
            "nickname": nickname,
            "avatar": f"/api/avatars/{hash(openid) % 9}.svg",
            "gender": "secret",
        })
        d = assert_ok(f"{provider} 首次登录", result,
                      lambda x: f"is_new={x.get('is_new')} nickname={x.get('user',{}).get('nickname')}")
        if d and d.get("token"):
            tokens.append(d["token"])

    # 3.2 同一 openid 再次登录 → 已存在，返回同一用户
    result = http("POST", "/api/auth/oauth", {
        "provider": "wechat",
        "openid": "wechat_openid_test_001",  # 同上
        "nickname": "应该不变",
    })
    d = assert_ok("wechat 同一 openid 二次登录", result,
                  lambda x: f"is_new={x.get('is_new')}")
    # is_new 应该为 false，因为用户已存在

    # 3.3 不支持的 provider（FastAPI 可能先校验字段，返回 422 或我们的 json_error）
    r = http("POST", "/api/auth/oauth", {"provider": "unknown_platform", "openid": "xxx_yyy_zzz_aaa"})
    if r[1] and r[1].get("success") is False:
        passed += 1
        results.append(("不支持的 provider", "PASS", f"后端拒绝，错误信息: {r[1].get('error', '')}"))
        print(f"  {PASS} 不支持的 provider  — 后端拒绝，错误信息: {r[1].get('error', '')}")
    elif r[0] == 422:
        passed += 1
        results.append(("不支持的 provider", "PASS", "FastAPI 校验拒绝 (HTTP 422)"))
        print(f"  {PASS} 不支持的 provider  — FastAPI 校验拒绝 (HTTP 422)")
    else:
        failed += 1
        results.append(("不支持的 provider", "FAIL", f"status={r[0]}"))
        print(f"  {FAIL} 不支持的 provider  — status={r[0]}")

    # 3.4 缺少 openid
    assert_status("缺少 openid（FastAPI 校验返回 422）",
                  http("POST", "/api/auth/oauth", {"provider": "wechat"}),
                  422)

    # 3.5 缺少 provider
    assert_status("缺少 provider（FastAPI 校验返回 422）",
                  http("POST", "/api/auth/oauth", {"openid": "xxx"}),
                  422)

    # 3.6 无参数
    assert_status("无参数（FastAPI 校验返回 422）",
                  http("POST", "/api/auth/oauth", {}),
                  422)

    # 3.7 openid 太短
    assert_error("openid 太短", http("POST", "/api/auth/oauth", {
        "provider": "wechat", "openid": "ab",
    }), "")

    return tokens


# ====================================================
# 4. 登录后拿 token 访问 /api/me
# ====================================================
def test_login_and_me():
    global passed, failed
    print(f"\n{INFO} ======== 4. 登录 + /api/auth/me + token 复用 ========")

    # 4.1 验证码完整流程 + 访问 me
    phone = "139" + f"{random.randint(10000000, 99999999)}"
    r1 = http("POST", "/api/auth/send-code", {"phone": phone})
    code = r1[1]["data"]["dev_code"]
    r2 = http("POST", "/api/auth/login", {"phone": phone, "code": code, "nickname": "MeTest"})
    token = r2[1]["data"]["token"]
    result = http("GET", "/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert_ok("用 token 访问 /api/auth/me", result,
              lambda d: f"nickname={d.get('nickname')} phone={d.get('phone')}")

    # 4.2 无 token 访问 me → 失败
    result2 = http("GET", "/api/auth/me")
    assert_error("无 token 访问 /api/auth/me", result2, "请先登录")

    # 4.3 无效 token 访问 me
    result3 = http("GET", "/api/auth/me", headers={"Authorization": "Bearer invalid_token_xyz"})
    assert_status("无效 token → 401", result3, 401)


# ====================================================
# 5. 管理员鉴权 token 不被普通用户覆盖
# ====================================================
def test_admin_token():
    global passed, failed
    print(f"\n{INFO} ======== 5. 管理员 token 鉴权 ========")

    admin_token = "admin_local_2026"

    # 5.1 正确 admin token
    result = http("GET", "/api/platform/stats",
                  headers={"Authorization": f"Bearer {admin_token}"})
    assert_ok("admin_local_2026 访问 /api/platform/stats", result,
              lambda d: f"users={d.get('users')} platform_coins={d.get('platform_coins')}")

    # 5.2 错误 admin token
    result2 = http("GET", "/api/platform/stats",
                   headers={"Authorization": "Bearer wrong_admin_token"})
    assert_error("错误 admin token → 403", result2, "权限不足")

    # 5.3 admin shop list
    result3 = http("GET", "/api/admin/shop",
                   headers={"Authorization": f"Bearer {admin_token}"})
    data = assert_ok("admin 访问 /api/admin/shop", result3,
                     lambda d: f"items_count={len(d) if isinstance(d, list) else 'N/A'}")
    # admin shop 返回的是 list；如果是 dict 则取 items 字段
    initial_count = 0
    if isinstance(data, list):
        initial_count = len(data)
    elif isinstance(data, dict):
        initial_count = len(data.get("items") or [])

    # 5.4 新增商品
    new_key = f"test_item_{int(time.time())}"
    result4 = http("POST", "/api/admin/shop",
                   {"item_key": new_key, "name": "测试物品", "icon": "🎀",
                    "category": "gift", "price": 5, "favorability_boost": 3,
                    "unlock_favorability": 0, "available": 1, "description": "单元测试自动创建"},
                   headers={"Authorization": f"Bearer {admin_token}"})
    assert_ok("admin 新增商城物品", result4, lambda d: f"id={d.get('id')} key={d.get('item_key')}")

    # 5.5 新增后数量 +1
    result5 = http("GET", "/api/admin/shop",
                   headers={"Authorization": f"Bearer {admin_token}"})
    data5 = result5[1].get("data") if result5[1] else None
    count = len(data5) if isinstance(data5, list) else (len((data5 or {}).get("items") or []) if isinstance(data5, dict) else 0)
    if count == initial_count + 1:
        passed += 1
        results.append(("新增后物品数+1", "PASS", f"{initial_count}→{count}"))
        print(f"  {PASS} 新增后物品数+1  — {initial_count}→{count}")
    else:
        failed += 1
        results.append(("新增后物品数+1", "FAIL", f"期望 {initial_count+1} 实际 {count}"))
        print(f"  {FAIL} 新增后物品数+1  — 期望 {initial_count+1} 实际 {count}")


# ====================================================
# 6. 边界 & 异常场景
# ====================================================
def test_edge_cases():
    global passed, failed
    print(f"\n{INFO} ======== 6. 边界 & 异常场景 ========")

    # 6.1 send-code 超长手机号
    assert_error("send-code 超长手机号",
                 http("POST", "/api/auth/send-code", {"phone": "1" * 200}), "")

    # 6.2 login 超长 nickname
    phone = "139" + f"{random.randint(10000000, 99999999)}"
    r1 = http("POST", "/api/auth/send-code", {"phone": phone})
    code = r1[1]["data"]["dev_code"]
    result = http("POST", "/api/auth/login", {
        "phone": phone, "code": code, "nickname": "A" * 200,
    })
    # 后端有 max_length=80，nickname 会被截断或报错
    if result[1] and result[1].get("success"):
        passed += 1
        results.append(("超长 nickname 被截断", "PASS", f"final_nick={result[1]['user']['nickname'][:40]}"))
        print(f"  {PASS} 超长 nickname 被截断  — final_nick={result[1]['user']['nickname'][:40]}")
    else:
        print(f"  {INFO} 超长 nickname 结果: {result}")

    # 6.3 oauth 超长 openid
    assert_status("oauth 超长 openid",
                  http("POST", "/api/auth/oauth", {
                      "provider": "wechat", "openid": "X" * 200,
                  }),
                  422)

    # 6.4 login 发送 GET 应该 405
    result = http("GET", "/api/auth/login")
    # 可能返回 405 或 422 或 403 — 都不是 200 OK
    if result[0] != 200 or not (result[1] and result[1].get("success")):
        passed += 1
        results.append(("login GET 方法不允许", "PASS", f"HTTP {result[0]}"))
        print(f"  {PASS} login GET 方法不允许  — HTTP {result[0]}")
    else:
        failed += 1
        results.append(("login GET 方法不允许", "FAIL", "GET 竟然成功了"))
        print(f"  {FAIL} login GET 方法不允许  — GET 竟然成功了")


# ====================================================
# 主入口
# ====================================================
def main():
    print("=" * 60)
    print("  圈圈语音社 — 验证码 & 第三方登录 单元测试")
    print(f"  目标服务: {BASE_URL}")
    print(f"  时间: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    # 0. 健康检查
    test_health()

    # 1. send-code
    phone, dev_code = test_send_code()

    # 2. login
    test_login(phone, dev_code)

    # 3. oauth
    oauth_tokens = test_oauth()

    # 4. 完整流程 + /api/me
    test_login_and_me()

    # 5. admin token
    test_admin_token()

    # 6. 边界场景
    test_edge_cases()

    # ============ 汇总 ============
    print()
    print("=" * 60)
    print(f"  测试汇总")
    print("=" * 60)
    for name, status, extra in results:
        icon = PASS if status == "PASS" else FAIL
        print(f"  {icon} {name}  {extra}")
    print("-" * 60)
    total = passed + failed
    print(f"  通过: {passed}/{total}  失败: {failed}/{total}")
    print("=" * 60)

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
