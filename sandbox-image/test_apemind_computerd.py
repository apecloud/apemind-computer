# Copyright 2026 ApeCloud, Inc.

import os
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


def test_forward_uses_local_agent_port(monkeypatch):
    daemon._ports.clear()
    daemon._ports["agt-t"] = 3088
    captured = {}

    class _Resp:
        status = 200
        headers = {"content-type": "text/plain"}

        def read(self):
            return b"hi"

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def _urlopen(req, timeout=20):
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        return _Resp()

    monkeypatch.setattr(daemon.urllib.request, "urlopen", _urlopen)
    out = daemon._forward({"id": "r1", "agent_id": "agt-t", "method": "GET", "path": "/", "headers": {}, "body": ""})
    assert captured["url"] == "http://127.0.0.1:3088/"
    assert captured["method"] == "GET"
    assert out["status"] == 200
    assert out["body"] == "hi"


def test_forward_without_port_is_unavailable():
    daemon._ports.clear()
    out = daemon._forward({"id": "r2", "agent_id": "missing", "method": "GET", "path": "/", "headers": {}, "body": ""})
    assert out["status"] == 503


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
