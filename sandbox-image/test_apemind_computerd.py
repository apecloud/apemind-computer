# Copyright 2026 ApeCloud, Inc.

import os
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import apemind_computerd as daemon


def test_start_sets_private_dsh_home(tmp_path):
    daemon._children.clear()
    daemon._ports.clear()
    agent = {"id": "agt-a", "work_dir": str(tmp_path / "a"), "owner_user_id": "user-1"}
    fake = SimpleNamespace(poll=lambda: None)

    def _popen(cmd, cwd, env, stdout, stderr):
        assert env["DSH_HOME"] == str(Path(cwd) / ".dsh")
        assert env["HOME"] == cwd
        assert env["XDG_CONFIG_HOME"] == str(Path(cwd) / ".config")
        assert env["APEMIND_USER_ID"] == "user-1"
        assert env["DSH_HOME"] != os.path.expanduser("~/.dsh")
        assert Path(env["DSH_HOME"]).is_dir()
        ident = Path(cwd) / ".apemind" / "identity"
        assert ident.read_text() == '{"user_id": "user-1"}'
        assert ident.stat().st_mode & 0o777 == 0o600
        return fake

    with patch("apemind_computerd.subprocess.Popen", side_effect=_popen):
        with patch("apemind_computerd._pick_port", return_value=3080):
            daemon._start(agent)
    assert daemon._children["agt-a"] is fake


class _FakeResp:
    def __init__(self, body=b"hi", status=200, headers=None, lines=None):
        self.status = status
        self._body = body
        self._headers = list((headers or {"content-type": "text/plain"}).items())
        self._chunks = list(lines) if lines is not None else None
        self.fp = self

    def getheaders(self):
        return self._headers

    def read(self, amt=None):
        data = self._body
        self._body = b""
        return data

    def readline(self):
        if not self._chunks:
            return b""
        return self._chunks.pop(0)


class _FakeConn:
    def __init__(self, captured, resp):
        self._captured = captured
        self._resp = resp

    def request(self, method, path, body=None, headers=None):
        self._captured["method"] = method
        self._captured["path"] = path
        self._captured["headers"] = {key.lower(): value for key, value in (headers or {}).items()}

    def getresponse(self):
        return self._resp

    def close(self):
        return None


def test_forward_uses_local_agent_port(monkeypatch):
    daemon._ports.clear()
    daemon._ports["agt-t"] = 3088
    captured = {}

    def _conn(host, port, timeout=300):
        captured["host"] = host
        captured["port"] = port
        return _FakeConn(captured, _FakeResp(b"hi"))

    monkeypatch.setattr(daemon.http.client, "HTTPConnection", _conn)
    out = daemon._forward({"id": "r1", "agent_id": "agt-t", "method": "GET", "path": "/", "headers": {}, "body": ""})
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 3088
    assert captured["path"] == "/"
    assert captured["method"] == "GET"
    assert out["status"] == 200
    assert out["body"] == "hi"


def test_forward_without_port_is_unavailable():
    daemon._ports.clear()
    out = daemon._forward({"id": "r2", "agent_id": "missing", "method": "GET", "path": "/", "headers": {}, "body": ""})
    assert out["status"] == 503


def test_forward_keeps_plugin_path_and_forces_identity(monkeypatch):
    daemon._ports.clear()
    daemon._ports["agt-t"] = 3088
    captured = {}

    def _conn(host, port, timeout=300):
        return _FakeConn(captured, _FakeResp(b"ok", headers={"content-type": "application/javascript"}))

    monkeypatch.setattr(daemon.http.client, "HTTPConnection", _conn)
    path = "/plugins/@deepseek-ai/dsh-client-ui-settings/client.js?rev=5d1695c62b38"
    out = daemon._forward(
        {
            "id": "r3",
            "agent_id": "agt-t",
            "method": "GET",
            "path": path,
            "headers": {
                "Accept-Encoding": "gzip",
                "Host": "computer-staging.apemind.ai",
                "Connection": "keep-alive",
            },
            "body": "",
        }
    )
    assert captured["path"] == path
    assert captured["headers"]["accept-encoding"] == "identity"
    assert "host" not in captured["headers"]
    assert "connection" not in captured["headers"]
    assert out["status"] == 200


def test_forward_strips_browser_origin_headers(monkeypatch):
    daemon._ports.clear()
    daemon._ports["agt-t"] = 3088
    captured = {}

    def _conn(host, port, timeout=300):
        return _FakeConn(captured, _FakeResp(b"{}", headers={"content-type": "application/json"}))

    monkeypatch.setattr(daemon.http.client, "HTTPConnection", _conn)
    out = daemon._forward(
        {
            "id": "r4",
            "agent_id": "agt-t",
            "method": "POST",
            "path": "/api/host.listDirectory",
            "headers": {
                "Content-Type": "application/json",
                "Origin": "https://computer-staging.apemind.ai",
                "Referer": "https://computer-staging.apemind.ai/chat",
                "Sec-Fetch-Site": "same-origin",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Dest": "empty",
                "Cookie": "computer_ui=ticket",
            },
            "body": "{}",
        }
    )
    assert "origin" not in captured["headers"]
    assert "referer" not in captured["headers"]
    assert "sec-fetch-site" not in captured["headers"]
    assert "sec-fetch-mode" not in captured["headers"]
    assert "sec-fetch-dest" not in captured["headers"]
    assert captured["headers"]["content-type"] == "application/json"
    assert captured["headers"]["cookie"] == "computer_ui=ticket"
    assert captured["headers"]["accept-encoding"] == "identity"
    assert out["status"] == 200


def test_iter_forward_yields_event_stream_lines(monkeypatch):
    daemon._ports.clear()
    daemon._ports["agt-t"] = 3088
    resp = _FakeResp(
        status=200,
        headers={"content-type": "text/event-stream"},
        lines=[b"data: a\n", b"\n", b"data: b\n"],
    )

    def _conn(host, port, timeout=300):
        return _FakeConn({}, resp)

    monkeypatch.setattr(daemon.http.client, "HTTPConnection", _conn)
    parts = list(
        daemon._iter_forward(
            {"id": "r5", "agent_id": "agt-t", "method": "GET", "path": "/api/events", "headers": {}, "body": ""}
        )
    )
    bodies = [part["body"] for part in parts if part["body"]]
    assert parts[0]["done"] is False
    assert parts[0]["status"] == 200
    assert bodies == ["data: a\n", "\n", "data: b\n"]
    assert parts[-1]["done"] is True


def test_forward_headers_drops_origin_keeps_business():
    out = daemon._forward_headers(
        {
            "Origin": "https://computer-staging.apemind.ai",
            "Referer": "https://computer-staging.apemind.ai/",
            "Sec-Fetch-User": "?1",
            "Content-Type": "application/json",
        }
    )
    lowered = {key.lower(): value for key, value in out.items()}
    assert "origin" not in lowered
    assert "referer" not in lowered
    assert "sec-fetch-user" not in lowered
    assert lowered["content-type"] == "application/json"
    assert lowered["accept-encoding"] == "identity"


def test_tunnel_worker_count_defaults_and_clamps(monkeypatch):
    monkeypatch.delenv("APEMIND_TUNNEL_WORKERS", raising=False)
    assert daemon._tunnel_worker_count() == 8
    monkeypatch.setenv("APEMIND_TUNNEL_WORKERS", "0")
    assert daemon._tunnel_worker_count() == 1
    monkeypatch.setenv("APEMIND_TUNNEL_WORKERS", "99")
    assert daemon._tunnel_worker_count() == 32
    assert daemon._tunnel_worker_count("nope") == 8


def test_start_tunnel_workers_starts_n(monkeypatch):
    started = []

    class _FakeThread:
        def __init__(self, target=None, args=(), name=None, daemon=None):
            started.append(name)

        def start(self):
            return None

    monkeypatch.setattr(daemon.threading, "Thread", _FakeThread)
    threads = daemon._start_tunnel_workers("https://example.test", {"session": "s"}, count=4)
    assert len(threads) == 4
    assert started == ["tunnel-0", "tunnel-1", "tunnel-2", "tunnel-3"]


def test_two_tunnel_once_can_overlap(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    in_flight = {"n": 0, "max": 0}
    lock = threading.Lock()

    def _api(_base, path, payload, timeout=15):
        if path.endswith("/pull"):
            with lock:
                in_flight["n"] += 1
                in_flight["max"] = max(in_flight["max"], in_flight["n"])
            started.set()
            assert release.wait(1)
            with lock:
                in_flight["n"] -= 1
            return {"id": payload.get("session_token"), "agent_id": "agt-t", "path": "/", "headers": {}, "body": ""}
        return {}

    monkeypatch.setattr(daemon, "_api", _api)
    monkeypatch.setattr(
        daemon,
        "_forward",
        lambda item: {"id": item.get("id"), "status": 200, "headers": {}, "body": ""},
    )
    workers = [
        threading.Thread(target=daemon._tunnel_once, args=("https://example.test", "a")),
        threading.Thread(target=daemon._tunnel_once, args=("https://example.test", "b")),
    ]
    for worker in workers:
        worker.start()
    assert started.wait(1)
    deadline = time.time() + 1
    while in_flight["max"] < 2 and time.time() < deadline:
        time.sleep(0.01)
    release.set()
    for worker in workers:
        worker.join(1)
        assert not worker.is_alive()
    assert in_flight["max"] >= 2


def test_api_sends_explicit_user_agent(monkeypatch):
    captured = {}

    class _Resp:
        def read(self):
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def _urlopen(req, timeout=15):
        captured["ua"] = req.get_header("User-agent")
        return _Resp()

    monkeypatch.setattr(daemon.urllib.request, "urlopen", _urlopen)
    daemon._api("https://example.test", "/api/v2/computer-control/join", {"token": "t"})
    assert captured["ua"] == daemon.USER_AGENT


def test_shutdown_flag_is_not_the_stop_function():
    assert daemon._shutdown is False
    assert callable(daemon._stop_agent)


def test_next_backoff_doubles_then_caps():
    assert daemon._next_backoff(5) == 10
    assert daemon._next_backoff(40) == 60
    assert daemon._next_backoff(0) == daemon.POLL_SECONDS


def test_save_state_is_owner_readable_only(tmp_path, monkeypatch):
    monkeypatch.setattr(daemon, "STATE_DIR", tmp_path)
    monkeypatch.setattr(daemon, "STATE_FILE", tmp_path / "session.json")
    daemon._save_state({"session_token": "x"})
    assert (tmp_path / "session.json").stat().st_mode & 0o777 == 0o600


def test_frp_spec_prefers_desired_then_env(monkeypatch):
    monkeypatch.delenv("APEMIND_FRP_SERVER", raising=False)
    monkeypatch.delenv("APEMIND_FRP_TOKEN", raising=False)
    assert daemon._frp_spec({}) is None
    monkeypatch.setenv("APEMIND_FRP_SERVER", "frp.example")
    monkeypatch.setenv("APEMIND_FRP_TOKEN", "tok")
    spec = daemon._frp_spec({})
    assert spec["server"] == "frp.example"
    assert spec["token"] == "tok"
    assert spec["port"] == 7000
    override = daemon._frp_spec({"frp": {"server": "from-desired", "token": "dt", "port": 7001}})
    assert override == {
        "server": "from-desired",
        "token": "dt",
        "port": 7001,
        "domain_suffix": "frp.internal",
        "host_header": "",
    }
    headed = daemon._frp_spec(
        {
            "frp": {
                "server": "from-desired",
                "token": "dt",
                "host_header": "Computer-Staging.apemind.ai:443",
            }
        }
    )
    assert headed["host_header"] == "computer-staging.apemind.ai"


def test_render_frpc_writes_http_proxies():
    body = daemon._render_frpc(
        "cmp1",
        {"server": 'host"x', "port": 7000, "token": "t", "domain_suffix": "frp.internal"},
        {"agt-a": 3080},
    )
    assert 'serverAddr = "host\\"x"' in body
    assert "serverPort = 7000" in body
    assert 'name = "cmp1-agt-a"' in body
    assert "localPort = 3080" in body
    assert 'customDomains = ["cmp1-agt-a.frp.internal"]' in body
    assert "hostHeaderRewrite" not in body
    rewritten = daemon._render_frpc(
        "cmp1",
        {
            "server": "frp.example",
            "port": 7000,
            "token": "t",
            "domain_suffix": "frp.internal",
            "host_header": "computer-staging.apemind.ai",
        },
        {"agt-a": 3080},
    )
    assert 'hostHeaderRewrite = "computer-staging.apemind.ai"' in rewritten


def test_sync_frpc_starts_and_reuses(tmp_path, monkeypatch):
    daemon._ports.clear()
    daemon._ports["agt-a"] = 3080
    daemon._frpc = None
    daemon._frpc_key = ""
    monkeypatch.setattr(daemon, "STATE_DIR", tmp_path)
    monkeypatch.setattr(daemon, "FRPC_BIN", str(tmp_path / "frpc"))
    (tmp_path / "frpc").write_text("#!/bin/sh\n")
    (tmp_path / "frpc").chmod(0o755)
    started = []

    def _popen(cmd, stdout=None, stderr=None):
        started.append(cmd)
        return SimpleNamespace(poll=lambda: None, terminate=lambda: None, wait=lambda timeout: None, kill=lambda: None)

    monkeypatch.setattr(daemon.subprocess, "Popen", _popen)
    spec = {"server": "frp.example", "port": 7000, "token": "t", "domain_suffix": "frp.internal"}
    daemon._sync_frpc("cmp1", spec)
    daemon._sync_frpc("cmp1", spec)
    assert len(started) == 1
    assert started[0][0].endswith("frpc")
    assert started[0][1] == "-c"
    config = (tmp_path / "frpc.toml").read_text()
    assert 'serverAddr = "frp.example"' in config
    assert (tmp_path / "frpc.toml").stat().st_mode & 0o777 == 0o600
    daemon._sync_frpc("cmp1", None)
    assert daemon._frpc is None


def test_observe_reports_stopped_after_stop():
    daemon._children.clear()
    daemon._ports.clear()
    proc = SimpleNamespace(poll=lambda: None, terminate=lambda: None, wait=lambda timeout: None, kill=lambda: None)
    daemon._children["agt-b"] = proc
    daemon._ports["agt-b"] = 3081
    daemon._stop_agent("agt-b")
    rows = daemon._observe({"agt-b"})
    assert rows == [
        {
            "id": "agt-b",
            "observed": "stopped",
            "observed_error": None,
            "observed_port": None,
            "work_dir": None,
        }
    ]
