"""Read-only CLI status through the real dynamically loaded plugin router."""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
import importlib.util
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest


@pytest.fixture
def status_client(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("PATH", "")
    api_path = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("enterprise_cli_status_api", api_path)
    assert spec and spec.loader
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    from hermes_platform.resolver import known_dirs

    # Keep tests independent of real Homebrew installations; discovery and
    # subprocess probes still run against real temporary executable files.
    monkeypatch.setattr(known_dirs, "homebrew_dirs", lambda: ())
    monkeypatch.delitem(sys.modules, "_plankton_enterprise_clis", raising=False)
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        yield client


def executable(path, argument, version):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        '#!/bin/sh\n'
        f'[ "$#" = 1 ] && [ "$1" = "{argument}" ] || exit 19\n'
        'read ignored && exit 20\n'
        f'printf "%s\\n" "{version}"\n'
    )
    path.chmod(0o755)
    return path


@contextmanager
def profile_scope(home):
    from agent.secret_scope import set_multiplex_context, reset_multiplex_context
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override

    multiplex = set_multiplex_context(True)
    token = set_hermes_home_override(home)
    try:
        yield
    finally:
        reset_hermes_home_override(token)
        reset_multiplex_context(multiplex)


@pytest.mark.parametrize("binding", ["launch", "override"])
def test_status_tracks_active_profile_a_b_a_with_real_version_probes(status_client, tmp_path, monkeypatch, binding):
    a, b = tmp_path / "profile-a", tmp_path / "profile-b"
    executable(a / "bin" / "aliyun", "version", "aliyun-a")
    executable(b / "bin" / "aliyun", "version", "aliyun-b")
    monkeypatch.setenv("HERMES_HOME", str(a))
    monkeypatch.setenv("PATH", str(a / "bin"))
    for home, expected in ((a, "aliyun-a"), (b, "aliyun-b"), (a, "aliyun-a")):
        if binding == "launch":
            monkeypatch.setenv("HERMES_HOME", str(home))
            monkeypatch.setenv("PATH", str(home / "bin"))
        with profile_scope(home) if binding == "override" else nullcontext():
            response = status_client.get("/clis")
        assert response.status_code == 200
        tools = {row["id"]: row for row in response.json()["tools"]}
        aliyun, lark = tools["aliyun-cli"], tools["lark-cli"]
        assert aliyun["available"] is True
        assert aliyun["version"] == expected
        assert aliyun["source"] == "app"
        assert aliyun["path"] == str(home / "bin" / "aliyun")
        assert aliyun["command"] == "aliyun --help"
        assert lark["available"] is False
        assert lark["source"] is None and lark["path"] is None
        assert lark["version"] == ""
        assert lark["command"] == "lark-cli --help"
        assert all(row["name"] and row["description"] for row in tools.values())


@pytest.mark.parametrize("placement", ["path", "user-local", "symlink", "broken-link", "nonzero", "timeout", "broken-system"])
def test_system_provenance_and_failed_probes_remain_honest(status_client, tmp_path, monkeypatch, placement):
    home = tmp_path / "profile"
    monkeypatch.setenv("HERMES_HOME", str(home))
    app = executable(home / "bin" / "lark-cli", "--version", "bundled-lark")
    system = executable(tmp_path / "system-bin" / "lark-cli", "--version", "system-lark")
    if placement == "path":
        monkeypatch.setenv("PATH", str(system.parent))
    elif placement == "user-local":
        executable(tmp_path / ".local" / "bin" / "lark-cli", "--version", "system-lark")
    elif placement in ("symlink", "broken-link"):
        app.unlink()
        app.symlink_to(system if placement == "symlink" else tmp_path / "missing")
    elif placement == "broken-system":
        monkeypatch.setenv("PATH", str(system.parent))
        system.write_text('#!/bin/sh\nexit 7\n')
    elif placement == "nonzero":
        app.write_text('#!/bin/sh\nprintf "credential-like stderr should not be exposed" >&2\nexit 7\n')
    else:
        # Load via the real route, then shorten only its timeout policy. The
        # following request still executes a real child and real timeout.
        status_client.get("/clis")
        monkeypatch.setattr(sys.modules["_plankton_enterprise_clis"], "VERSION_TIMEOUT_S", 0.1)
        app.write_text('#!/bin/sh\nexec /bin/sleep 5\n')
    response = status_client.get("/clis")
    assert response.status_code == 200
    row = next(row for row in response.json()["tools"] if row["id"] == "lark-cli")
    if placement == "broken-link":
        assert not row["available"] and row["source"] is None and row["path"] is None
    elif placement in ("nonzero", "timeout"):
        assert not row["available"]
        assert row["source"] == "app"
        assert row["version"] == "" and row["error"]
        assert "credential-like" not in row["error"]
    else:
        assert row["available"]
        assert row["source"] == ("app" if placement == "broken-system" else "system")
        assert row["version"] == ("bundled-lark" if placement == "broken-system" else "system-lark")
        assert "error" not in row
