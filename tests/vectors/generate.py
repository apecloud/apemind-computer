#!/usr/bin/env python3
"""生成票据格式的跨语言测试向量。

签名实现与控制面（ApeMind）保持一致；Node 侧验证实现必须通过这里生成的全部向量。
用法：
    python3 tests/vectors/generate.py            # 重新生成 tickets.json
    python3 tests/vectors/generate.py --check    # 校验 tickets.json 与生成器一致
"""

from __future__ import annotations

import hashlib
import hmac
import json
import sys
from base64 import urlsafe_b64encode
from pathlib import Path

SECRET = "vector-secret-0123456789abcdef0123456789abcdef"
NOW = 1735689600  # 2025-01-01T00:00:00Z，向量的“当前时间”
FUTURE = 4102444800  # 2100-01-01T00:00:00Z
PAST = 946684800  # 2000-01-01T00:00:00Z


def sign(secret: str, payload: dict) -> str:
    body = (
        urlsafe_b64encode(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
        .decode("ascii")
        .rstrip("=")
    )
    sig = hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"v1.{body}.{sig}"


def build() -> dict:
    ticket_valid = sign(SECRET, {"t": "ticket", "u": "usr_alice-01", "e": FUTURE, "n": "6f2b9d40c1e84a37"})
    session_valid = sign(SECRET, {"t": "session", "u": "usr_alice-01", "e": FUTURE})
    ticket_expired = sign(SECRET, {"t": "ticket", "u": "usr_alice-01", "e": PAST, "n": "0e17c55ab9d24f68"})
    ticket_bad_user = sign(SECRET, {"t": "ticket", "u": "usr/../etc", "e": FUTURE, "n": "a1b2c3d4e5f60718"})
    tampered_sig = ticket_valid[:-1] + ("0" if ticket_valid[-1] != "0" else "1")
    head, body, sig = ticket_valid.split(".")
    tampered_body = f"{head}.{body[:-2]}{'AA' if body[-2:] != 'AA' else 'BB'}.{sig}"
    wrong_prefix = "v2." + ticket_valid.split(".", 1)[1]

    cases = [
        {
            "name": "ticket_valid",
            "type": "ticket",
            "token": ticket_valid,
            "expect": {"valid": True, "user_id": "usr_alice-01", "exp": FUTURE, "nonce": "6f2b9d40c1e84a37"},
        },
        {
            "name": "session_valid",
            "type": "session",
            "token": session_valid,
            "expect": {"valid": True, "user_id": "usr_alice-01", "exp": FUTURE},
        },
        {"name": "ticket_expired", "type": "ticket", "token": ticket_expired, "expect": {"valid": False}},
        {"name": "ticket_bad_user_charset", "type": "ticket", "token": ticket_bad_user, "expect": {"valid": False}},
        {"name": "ticket_tampered_sig", "type": "ticket", "token": tampered_sig, "expect": {"valid": False}},
        {"name": "ticket_tampered_body", "type": "ticket", "token": tampered_body, "expect": {"valid": False}},
        {"name": "wrong_version_prefix", "type": "ticket", "token": wrong_prefix, "expect": {"valid": False}},
        {"name": "session_used_as_ticket", "type": "ticket", "token": session_valid, "expect": {"valid": False}},
        {"name": "ticket_used_as_session", "type": "session", "token": ticket_valid, "expect": {"valid": False}},
        {"name": "garbage", "type": "ticket", "token": "not-a-token", "expect": {"valid": False}},
    ]
    return {"secret": SECRET, "now": NOW, "cases": cases}


def main() -> int:
    out = Path(__file__).parent / "tickets.json"
    data = json.dumps(build(), ensure_ascii=False, indent=2) + "\n"
    if "--check" in sys.argv:
        if not out.exists() or out.read_text(encoding="utf-8") != data:
            print("tickets.json 与生成器输出不一致，请运行 python3 tests/vectors/generate.py 重新生成", file=sys.stderr)
            return 1
        print("tickets.json 与生成器一致")
        return 0
    out.write_text(data, encoding="utf-8")
    print(f"已写入 {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
