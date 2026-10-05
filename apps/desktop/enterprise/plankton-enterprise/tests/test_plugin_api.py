"""Tests for the plankton-enterprise dashboard backend CLI resolution.

The red line: the enterprise copy (``<HERMES_HOME>/bin``) is the ONLY working
CLI. A same-named binary on ``PATH`` must NEVER be used — its presence must not
turn a missing enterprise copy into a silent downgrade (KI-PLANKTON-0013).
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
from pathlib import Path

import pytest

PLUGIN_API = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"


def load_plugin_api():
    spec = importlib.util.spec_from_file_location("plankton_enterprise_plugin_api", PLUGIN_API)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def api():
    return load_plugin_api()


def _write_cli(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def test_resolve_prefers_enterprise_copy(monkeypatch, tmp_path, api):
    home = tmp_path / "home"
    cli = _write_cli(home / "bin" / "shaoke-cli", "#!/bin/sh\necho enterprise\n")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("PLANKTON_SHAOKE_CLI", raising=False)

    path, source = api.resolve_cli()
    assert source == "enterprise"
    assert path == str(cli)


def test_resolve_honours_explicit_override(monkeypatch, tmp_path, api):
    override = _write_cli(tmp_path / "custom" / "shaoke-cli", "#!/bin/sh\necho override\n")
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("PLANKTON_SHAOKE_CLI", str(override))

    path, source = api.resolve_cli()
    assert source == "override"
    assert path == str(override)


def test_missing_enterprise_copy_does_not_fall_back_to_path(monkeypatch, tmp_path, api):
    """F5 counterexample: delete the enterprise copy + put a personal one on PATH."""
    home = tmp_path / "home"  # no bin/shaoke-cli here
    personal_dir = tmp_path / "personal-bin"
    personal = _write_cli(personal_dir / "shaoke-cli", '#!/bin/sh\necho \'{"ok":true,"data":{"services":[]}}\'\n')
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("PLANKTON_SHAOKE_CLI", raising=False)
    monkeypatch.setenv("PATH", str(personal_dir) + os.pathsep + os.environ.get("PATH", ""))

    # resolution must NOT return the personal copy
    path, source = api.resolve_cli()
    assert path is None
    assert source == "missing"

    # the endpoint must report an explicit cli-missing — never an ok/empty result
    result = api.list_tools()
    assert result["ok"] is False
    assert result["kind"] == "cli-missing"
    assert result["cliSource"] == "missing"
    assert result["cliPath"] is None
    # a diagnostic hint about the ignored personal copy is allowed (reminder),
    # but the personal binary is NEVER the working CLI.
    assert str(personal) not in (result.get("cliPath") or "")
    assert "note" in result and str(personal) in result["note"]


def test_enterprise_copy_runs_its_own_binary(monkeypatch, tmp_path, api):
    """Sanity: with the enterprise copy present, the endpoint executes IT."""
    home = tmp_path / "home"
    payload = {"ok": True, "data": {"services": [{"name": "svc", "tools": [{"name": "t", "risk": "read"}]}]}}
    cli = _write_cli(home / "bin" / "shaoke-cli", f"#!/bin/sh\necho '{json.dumps(payload)}'\n")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("PLANKTON_SHAOKE_CLI", raising=False)

    result = api.list_tools()
    assert result["ok"] is True
    assert result["cliPath"] == str(cli)
    assert result["cliSource"] == "enterprise"
    assert result["count"] == 1
