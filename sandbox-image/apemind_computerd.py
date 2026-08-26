#!/usr/bin/env python3
# Copyright 2026 ApeCloud, Inc.

"""Outbound Computer daemon: join, heartbeat, start/stop local dsh web."""

from __future__ import annotations

import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

STATE_DIR = Path(os.environ.get("APEMIND_STATE_DIR", "/var/lib/apemind-computer"))
STATE_FILE = STATE_DIR / "session.json"
DSH_ROOT = Path(os.environ.get("APEMIND_DSH_ROOT", "/home/gem/dsh"))
BASE_PORT = int(os.environ.get("APEMIND_DSH_BASE_PORT", "3080"))
POLL_SECONDS = float(os.environ.get("APEMIND_POLL_SECONDS", "5"))
BACKOFF_CAP = float(os.environ.get("APEMIND_BACKOFF_CAP", "60"))
CHILD_RESTART_BACKOFF = float(os.environ.get("APEMIND_CHILD_RESTART_BACKOFF", "2"))
TUNNEL_WORKERS_DEFAULT = 8
TUNNEL_WORKERS_MAX = 32
FRPC_BIN = os.environ.get("APEMIND_FRPC_BIN", "/usr/local/bin/frpc")
_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}
# Browser origin headers must not reach loopback dsh: it compares Origin to Host
# and returns 403 forbidden when they disagree.
_BROWSER_ORIGIN_HEADERS = {
    "origin",
    "referer",
}

_children: dict[str, subprocess.Popen] = {}
_ports: dict[str, int] = {}
_crash_until: dict[str, float] = {}
_shutdown = False
_frpc: subprocess.Popen | None = None
_frpc_key = ""


def _log(msg: str) -> None:
    print(f"apemind-computerd: {msg}", flush=True)


USER_AGENT = "apemind-computer/0.1.7"


def _api(base: str, path: str, payload: dict, timeout: float = 15) -> dict:
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def _tunnel_worker_count(raw: str | None = None) -> int:
    value = os.environ.get("APEMIND_TUNNEL_WORKERS", "8") if raw is None else raw
    try:
        return max(1, min(int(value), TUNNEL_WORKERS_MAX))
    except (TypeError, ValueError):
        return TUNNEL_WORKERS_DEFAULT


def _drop_forward_header(name: str) -> bool:
    key = name.lower()
    return key in _HOP_HEADERS or key in _BROWSER_ORIGIN_HEADERS or key.startswith("sec-fetch-")


def _forward_headers(headers: dict | None) -> dict[str, str]:
    outgoing: dict[str, str] = {}
    for key, value in dict(headers or {}).items():
        if _drop_forward_header(str(key)):
            continue
        outgoing[str(key)] = str(value)
    outgoing["Accept-Encoding"] = "identity"
    return outgoing


def _forward(item: dict) -> dict:
    parts = list(_iter_forward(item))
    if not parts:
        return {"id": item.get("id"), "status": 502, "headers": {}, "body": "", "done": True}
    headers = {}
    status = 502
    body = []
    for part in parts:
        if part.get("headers"):
            headers = part["headers"]
        if part.get("status"):
            status = part["status"]
        if part.get("body"):
            body.append(str(part["body"]))
    return {
        "id": item.get("id"),
        "status": status,
        "headers": headers,
        "body": "".join(body),
        "done": True,
    }


def _iter_forward(item: dict):
    req_id = item.get("id")
    port = _ports.get(str(item.get("agent_id") or ""))
    if not port:
        yield {"id": req_id, "status": 503, "headers": {}, "body": "", "done": True}
        return
    path = item.get("path") or "/"
    raw_body = str(item.get("body") or "").encode("latin1")
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=300)
    try:
        conn.request(
            str(item.get("method") or "GET"),
            path,
            body=raw_body or None,
            headers=_forward_headers(item.get("headers")),
        )
        resp = conn.getresponse()
        headers = {key: value for key, value in resp.getheaders()}
        yield {"id": req_id, "status": int(resp.status), "headers": headers, "body": "", "done": False}
        content_type = ""
        for key, value in headers.items():
            if key.lower() == "content-type":
                content_type = value.lower()
                break
        if "text/event-stream" in content_type:
            while True:
                line = resp.fp.readline()
                if not line:
                    break
                yield {
                    "id": req_id,
                    "status": int(resp.status),
                    "headers": {},
                    "body": line.decode("latin1"),
                    "done": False,
                }
        else:
            while True:
                buf = resp.read(2048)
                if not buf:
                    break
                yield {
                    "id": req_id,
                    "status": int(resp.status),
                    "headers": {},
                    "body": buf.decode("latin1"),
                    "done": False,
                }
        yield {"id": req_id, "status": int(resp.status), "headers": {}, "body": "", "done": True}
    except Exception:
        yield {"id": req_id, "status": 502, "headers": {}, "body": "", "done": True}
    finally:
        conn.close()


def _tunnel_once(base: str, session: str) -> None:
    item = _api(base, "/api/v2/computer-control/tunnel/pull", {"session_token": session}, timeout=25)
    if not item.get("id"):
        return
    for reply in _iter_forward(item):
        reply["session_token"] = session
        _api(base, "/api/v2/computer-control/tunnel/reply", reply, timeout=30)


def _tunnel_loop(base: str, holder: dict) -> None:
    while not _shutdown:
        session = holder.get("session") or ""
        if not session:
            time.sleep(1)
            continue
        try:
            _tunnel_once(base, session)
        except Exception as exc:
            _log(f"tunnel error: {exc}")
            time.sleep(1)


def _toml_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _frp_spec(desired: dict | None = None) -> dict | None:
    block = dict((desired or {}).get("frp") or {})
    server = str(block.get("server") or os.environ.get("APEMIND_FRP_SERVER") or "").strip()
    token = str(block.get("token") or os.environ.get("APEMIND_FRP_TOKEN") or "").strip()
    if not server or not token:
        return None
    try:
        port = int(block.get("port") or os.environ.get("APEMIND_FRP_PORT") or 7000)
    except (TypeError, ValueError):
        port = 7000
    suffix = str(
        block.get("domain_suffix") or os.environ.get("APEMIND_FRP_DOMAIN_SUFFIX") or "frp.internal"
    ).strip()
    return {
        "server": server,
        "port": port,
        "token": token,
        "domain_suffix": suffix or "frp.internal",
    }


def _frp_domain(computer_id: str, agent_id: str, suffix: str) -> str:
    return f"{computer_id}-{agent_id}.{suffix}"


def _render_frpc(computer_id: str, spec: dict, ports: dict[str, int]) -> str:
    lines = [
        f'serverAddr = "{_toml_escape(spec["server"])}"',
        f"serverPort = {int(spec['port'])}",
        'auth.method = "token"',
        f'auth.token = "{_toml_escape(spec["token"])}"',
        "loginFailExit = false",
    ]
    for agent_id, port in sorted(ports.items()):
        name = f"{computer_id}-{agent_id}"
        domain = _frp_domain(computer_id, agent_id, spec["domain_suffix"])
        lines.extend(
            [
                "",
                "[[proxies]]",
                f'name = "{_toml_escape(name)}"',
                'type = "http"',
                'localIP = "127.0.0.1"',
                f"localPort = {int(port)}",
                f'customDomains = ["{_toml_escape(domain)}"]',
            ]
        )
    return "\n".join(lines) + "\n"


def _stop_frpc() -> None:
    global _frpc, _frpc_key
    proc = _frpc
    _frpc = None
    _frpc_key = ""
    if proc is None:
        return
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
    _log("frpc stopped")


def _sync_frpc(computer_id: str, spec: dict | None) -> None:
    global _frpc, _frpc_key
    if not computer_id or spec is None or not _ports:
        if _frpc is not None:
            _stop_frpc()
        return
    body = _render_frpc(computer_id, spec, dict(_ports))
    if body == _frpc_key and _frpc is not None and _frpc.poll() is None:
        return
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    config_path = STATE_DIR / "frpc.toml"
    tmp = config_path.with_name(config_path.name + ".tmp")
    tmp.write_text(body)
    tmp.chmod(0o600)
    tmp.replace(config_path)
    _stop_frpc()
    if not Path(FRPC_BIN).is_file():
        _log("frpc missing; skip")
        return
    _frpc = subprocess.Popen(
        [FRPC_BIN, "-c", str(config_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    _frpc_key = body
    _log(f"frpc started {spec['server']}:{spec['port']}")


def _start_tunnel_workers(base: str, holder: dict, count: int | None = None) -> list[threading.Thread]:
    n = _tunnel_worker_count() if count is None else max(1, count)
    threads: list[threading.Thread] = []
    for index in range(n):
        thread = threading.Thread(
            target=_tunnel_loop,
            args=(base, holder),
            name=f"tunnel-{index}",
            daemon=True,
        )
        thread.start()
        threads.append(thread)
    _log(f"tunnel workers {n}")
    return threads


def _load_state() -> dict:
    if STATE_FILE.is_file():
        return json.loads(STATE_FILE.read_text())
    return {}


def _next_backoff(current: float) -> float:
    if current <= 0:
        return POLL_SECONDS
    return min(max(current, POLL_SECONDS) * 2, BACKOFF_CAP)


def _save_state(data: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_name(STATE_FILE.name + ".tmp")
    tmp.write_text(json.dumps(data))
    tmp.chmod(0o600)
    tmp.replace(STATE_FILE)


def _join(base: str, token: str) -> dict:
    state = _load_state()
    if state.get("session_token"):
        return state
    out = _api(base, "/api/v2/computer-control/join", {"token": token})
    _save_state(out)
    return out


def _pick_port() -> int:
    used = set(_ports.values())
    port = BASE_PORT
    while port in used:
        port += 1
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        while True:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                port += 1


def _alive(agent_id: str) -> bool:
    proc = _children.get(agent_id)
    return proc is not None and proc.poll() is None


def _start(agent: dict) -> None:
    agent_id = agent["id"]
    if _alive(agent_id):
        return
    until = _crash_until.get(agent_id, 0)
    if until and time.time() < until:
        return
    work = Path(agent.get("work_dir") or (DSH_ROOT / agent_id))
    work.mkdir(parents=True, exist_ok=True)
    dsh_home = work / ".dsh"
    dsh_home.mkdir(parents=True, exist_ok=True)
    port = _pick_port()
    env = os.environ.copy()
    env["DSH_HOME"] = str(dsh_home)
    env["HOME"] = str(work)
    env["XDG_CONFIG_HOME"] = str(work / ".config")
    env["XDG_DATA_HOME"] = str(work / ".local" / "share")
    owner = str(agent.get("owner_user_id") or "")
    if owner:
        env["APEMIND_USER_ID"] = owner
        ident = work / ".apemind" / "identity"
        ident.parent.mkdir(parents=True, exist_ok=True)
        tmp = ident.with_name(ident.name + ".tmp")
        tmp.write_text(json.dumps({"user_id": owner}))
        tmp.chmod(0o600)
        tmp.replace(ident)
    proc = subprocess.Popen(
        ["dsh", "web", "--no-open", "--port", str(port)],
        cwd=str(work),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    _children[agent_id] = proc
    _ports[agent_id] = port
    _log(f"started {agent_id} on 127.0.0.1:{port}")


def _stop_agent(agent_id: str) -> None:
    proc = _children.pop(agent_id, None)
    _ports.pop(agent_id, None)
    if proc is None:
        return
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
    _log(f"stopped {agent_id}")


def _observe(known_ids: set[str] | None = None) -> list[dict]:
    rows = []
    seen: set[str] = set()
    for agent_id, proc in list(_children.items()):
        code = proc.poll()
        seen.add(agent_id)
        if code is None:
            rows.append(
                {
                    "id": agent_id,
                    "observed": "running",
                    "observed_port": _ports.get(agent_id),
                    "work_dir": None,
                }
            )
        else:
            rows.append(
                {
                    "id": agent_id,
                    "observed": "error" if code != 0 else "stopped",
                    "observed_error": f"exit {code}" if code else None,
                    "observed_port": None,
                    "work_dir": None,
                }
            )
            _children.pop(agent_id, None)
            _ports.pop(agent_id, None)
            if code:
                _crash_until[agent_id] = time.time() + CHILD_RESTART_BACKOFF
    for agent_id in known_ids or set():
        if agent_id in seen:
            continue
        rows.append(
            {
                "id": agent_id,
                "observed": "stopped",
                "observed_error": None,
                "observed_port": None,
                "work_dir": None,
            }
        )
    return rows


def _handle_stop(_signum, _frame) -> None:
    global _shutdown
    _shutdown = True


def main() -> int:
    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)
    base = os.environ.get("APEMIND_URL", "").strip()
    token = os.environ.get("APEMIND_JOIN_TOKEN", "").strip()
    if not base or not token:
        _log("APEMIND_URL and APEMIND_JOIN_TOKEN are required; idle")
        while not _shutdown:
            time.sleep(POLL_SECONDS)
        return 0
    session = ""
    computer_id = ""
    holder = {"session": ""}
    _start_tunnel_workers(base, holder)
    delay = POLL_SECONDS
    applied_rev: dict[str, int] = {}
    while not _shutdown:
        try:
            if not session:
                state = _join(base, token)
                session = state["session_token"]
                computer_id = str(state.get("computer_id") or "")
                holder["session"] = session
                _log(f"joined {state.get('computer_id')}")
            _api(base, "/api/v2/computer-control/heartbeat", {"session_token": session})
            desired = _api(base, "/api/v2/computer-control/desired", {"session_token": session})
            want_ids = set()
            for agent in desired.get("agents", []):
                want_ids.add(agent["id"])
                rev = int(agent.get("revision") or 0)
                if agent.get("desired") == "running":
                    if applied_rev.get(agent["id"], -1) <= rev:
                        _start(agent)
                        applied_rev[agent["id"]] = rev
                else:
                    _stop_agent(agent["id"])
                    applied_rev[agent["id"]] = rev
            for agent_id in list(_children):
                if agent_id not in want_ids:
                    _stop_agent(agent_id)
            _api(
                base,
                "/api/v2/computer-control/observed",
                {"session_token": session, "agents": _observe(want_ids)},
            )
            _sync_frpc(computer_id, _frp_spec(desired))
            delay = POLL_SECONDS
        except urllib.error.HTTPError as exc:
            _log(f"control error {exc.code}")
            if exc.code in (401, 404):
                session = ""
                computer_id = ""
                holder["session"] = ""
                _stop_frpc()
                if STATE_FILE.is_file():
                    STATE_FILE.unlink()
            delay = _next_backoff(delay)
        except Exception as exc:
            _log(f"loop error: {exc}")
            delay = _next_backoff(delay)
        deadline = time.time() + delay
        while not _shutdown and time.time() < deadline:
            time.sleep(min(1.0, max(0.0, deadline - time.time())))
    for agent_id in list(_children):
        _stop_agent(agent_id)
    _stop_frpc()
    return 0


if __name__ == "__main__":
    sys.exit(main())
