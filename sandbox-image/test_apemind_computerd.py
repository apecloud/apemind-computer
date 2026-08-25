# Copyright 2026 ApeCloud, Inc.

import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import apemind_computerd as daemon


def test_start_sets_private_dsh_home(tmp_path):
    daemon._children.clear()
    daemon._ports.clear()
    agent = {"id": "agt-a", "work_dir": str(tmp_path / "a")}
    fake = SimpleNamespace(poll=lambda: None)

    def _popen(cmd, cwd, env, stdout, stderr):
        assert env["DSH_HOME"] == str(Path(cwd) / ".dsh")
        assert env["HOME"] == cwd
        assert env["XDG_CONFIG_HOME"] == str(Path(cwd) / ".config")
        assert env["DSH_HOME"] != os.path.expanduser("~/.dsh")
        assert Path(env["DSH_HOME"]).is_dir()
        return fake

    with patch("apemind_computerd.subprocess.Popen", side_effect=_popen):
        with patch("apemind_computerd._pick_port", return_value=3080):
            daemon._start(agent)
    assert daemon._children["agt-a"] is fake


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
    daemon._stop("agt-b")
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
