#!/usr/bin/env python3
# Copyright 2026 ApeCloud, Inc.

"""Outbound Computer daemon: join, heartbeat, start/stop local dsh web."""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
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

_children: dict[str, subprocess.Popen] = {}
_ports: dict[str, int] = {}
_crash_until: dict[str, float] = {}
_shutdown = False


def _log(msg: str) -> None:
    print(f"apemind-computerd: {msg}", flush=True)


def _api(base: str, path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "apemind-computer"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


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
    delay = POLL_SECONDS
    applied_rev: dict[str, int] = {}
    while not _shutdown:
        try:
            if not session:
                state = _join(base, token)
                session = state["session_token"]
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
            delay = POLL_SECONDS
        except urllib.error.HTTPError as exc:
            _log(f"control error {exc.code}")
            if exc.code in (401, 404):
                session = ""
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
