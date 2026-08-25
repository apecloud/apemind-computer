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

_children: dict[str, subprocess.Popen] = {}
_ports: dict[str, int] = {}
_stop = False


def _log(msg: str) -> None:
    print(f"apemind-computerd: {msg}", flush=True)


def _api(base: str, path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
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


def _save_state(data: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(data))


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
    work = Path(agent.get("work_dir") or (DSH_ROOT / agent_id))
    work.mkdir(parents=True, exist_ok=True)
    port = _pick_port()
    env = os.environ.copy()
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


def _stop(agent_id: str) -> None:
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


def _observe() -> list[dict]:
    rows = []
    for agent_id, proc in list(_children.items()):
        code = proc.poll()
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
    return rows


def _handle_stop(_signum, _frame) -> None:
    global _stop
    _stop = True


def main() -> int:
    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)
    base = os.environ.get("APEMIND_URL", "").strip()
    token = os.environ.get("APEMIND_JOIN_TOKEN", "").strip()
    if not base or not token:
        _log("APEMIND_URL and APEMIND_JOIN_TOKEN are required; idle")
        while not _stop:
            time.sleep(POLL_SECONDS)
        return 0
    try:
        state = _join(base, token)
    except Exception as exc:
        _log(f"join failed: {exc}")
        return 1
    session = state["session_token"]
    _log(f"joined {state.get('computer_id')}")
    applied_rev: dict[str, int] = {}
    while not _stop:
        try:
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
                    _stop(agent["id"])
                    applied_rev[agent["id"]] = rev
            for agent_id in list(_children):
                if agent_id not in want_ids:
                    _stop(agent_id)
            _api(
                base,
                "/api/v2/computer-control/observed",
                {"session_token": session, "agents": _observe()},
            )
        except urllib.error.HTTPError as exc:
            _log(f"control error {exc.code}")
        except Exception as exc:
            _log(f"loop error: {exc}")
        time.sleep(POLL_SECONDS)
    for agent_id in list(_children):
        _stop(agent_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
