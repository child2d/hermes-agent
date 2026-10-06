"""W5 · the pack READ port (取数口) — read-only by construction.

Design: docs/plankton/N7-technical-design/N7-20261006-plankton-session-packs.md
§0 / §8 with the W5 ruling「取数口＝只读读路径」. The pack renderer fetches its
payload through the host bridge (``ctx.rest`` → ``POST /packs/read``); this route
runs the pack's DECLARED READ command read-only on the plugin's behalf.

What this file PINS (each rule has a counter-example that must hold):
  * only ``READ_TEMPLATES`` (kind:'read') may run — a WRITE template id is
    refused BEFORE any spawn (the door can never write);
  * argv comes from the fixed table: an undeclared flag or a missing required one
    is refused (no free-text argv);
  * the ``{kind, envelope}`` contract matches the desktop ``runRead``;
  * ``READ_TEMPLATES`` mirrors the pack declaration's read templates (drift lock).
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest

PLUGIN_API = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"
PLUGIN_JS = Path(__file__).resolve().parents[1] / "desktop" / "plugin.js"


def load_plugin_api():
    spec = importlib.util.spec_from_file_location("plankton_enterprise_plugin_api_read", PLUGIN_API)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def api():
    return load_plugin_api()


@pytest.fixture()
def cli(monkeypatch, tmp_path, api):
    """A fake enterprise shaoke-cli the route will resolve; returns (home, script)."""
    home = tmp_path / "home"
    path = home / "bin" / "shaoke-cli"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n", encoding="utf-8")
    path.chmod(0o755)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("PLANKTON_SHAOKE_CLI", raising=False)
    return home, path


class _FakeCompleted:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def _ok(payload):
    return json.dumps({"ok": True, "data": payload})


def test_write_template_id_is_refused_before_any_spawn(monkeypatch, api, cli):
    called = {"n": 0}

    def _boom(*_a, **_k):
        called["n"] += 1
        raise AssertionError("a read door must not spawn for a write template")

    monkeypatch.setattr(api.subprocess, "run", _boom)
    result = api.pack_read(api.PackReadRequest(packId="baymax", templateId="create-item", params={}))
    assert result["kind"] == "rejected"
    assert result["note"] == "read-path-cannot-use-write-template"
    assert called["n"] == 0, "refusal must happen BEFORE any spawn"


def test_unknown_template_and_pack_are_refused(api):
    assert api.pack_read(api.PackReadRequest(packId="baymax", templateId="nope", params={}))["note"] == (
        "read-path-cannot-use-write-template"
    )
    assert api.pack_read(api.PackReadRequest(packId="other", templateId="whoami", params={}))["note"] == "pack-not-declared"


def test_undeclared_flag_and_missing_required_are_refused(monkeypatch, api, cli):
    monkeypatch.setattr(api.subprocess, "run", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("no spawn")))
    bad_flag = api.pack_read(api.PackReadRequest(packId="baymax", templateId="list-issues", params={"project-id": "1", "--rm": "-rf"}))
    assert bad_flag["note"] == "unknown-param:--rm"
    missing = api.pack_read(api.PackReadRequest(packId="baymax", templateId="get-issue", params={"project-id": "1"}))
    assert missing["note"] == "missing-param:id"


def test_ok_path_builds_array_argv_and_returns_the_envelope(monkeypatch, api, cli):
    seen = {}

    def _run(argv, **kwargs):
        seen["argv"] = argv
        seen["kwargs"] = kwargs
        return _FakeCompleted(stdout=_ok({"data": [{"issueKey": "PM-1"}], "total": 1}))

    monkeypatch.setattr(api.subprocess, "run", _run)
    result = api.pack_read(api.PackReadRequest(packId="baymax", templateId="list-issues", params={"project-id": "1", "limit": "5"}))
    assert result["kind"] == "ok"
    assert result["envelope"]["ok"] is True
    # array args (no shell), the fixed table's module+command, flags as ``--flag value``
    assert seen["argv"][0].endswith("shaoke-cli")
    assert seen["argv"][1:] == ["baymax", "+issue-list", "--project-id", "1", "--limit", "5"]
    assert seen["kwargs"].get("shell") is not True


def test_failure_envelope_on_stderr_with_noise_is_found(monkeypatch, api, cli):
    def _run(*_a, **_k):
        return _FakeCompleted(stdout="", stderr='upgrade notice line\n{"ok":false,"error":{"message":"nope"}}\n', returncode=1)

    monkeypatch.setattr(api.subprocess, "run", _run)
    result = api.pack_read(api.PackReadRequest(packId="baymax", templateId="whoami", params={}))
    assert result["kind"] == "rejected"
    assert result["note"] == "read-failed"


def test_unparseable_output_is_a_typed_failure(monkeypatch, api, cli):
    monkeypatch.setattr(api.subprocess, "run", lambda *_a, **_k: _FakeCompleted(stdout="not json", returncode=0))
    assert api.pack_read(api.PackReadRequest(packId="baymax", templateId="whoami", params={}))["kind"] == "unparsed"


def test_read_templates_mirror_the_pack_declaration_read_templates(api):
    """Drift lock: the backend's read allow-list must be exactly the pack's read
    templates — a template added to the pack but not here fails CLOSED (refused),
    which is safe; this test makes that a RED instead of a silent gap."""
    source = PLUGIN_JS.read_text(encoding="utf-8")
    declared = set(re.findall(r"\{\s*id:\s*'([a-z0-9-]+)',\s*kind:\s*'read'", source))
    assert declared, "the pack must declare read templates (regexp found none — check plugin.js shape)"
    assert declared == set(api.READ_TEMPLATES.keys()), (
        f"backend read allow-list drifted from the pack declaration: "
        f"only-in-pack={sorted(declared - set(api.READ_TEMPLATES))} only-in-backend={sorted(set(api.READ_TEMPLATES) - declared)}"
    )
    # Every table entry is a read command — no write command may appear.
    for entry in api.READ_TEMPLATES.values():
        assert entry["command"].startswith("+")
        assert entry["command"] not in {"+issue-create", "+issue-update", "+issue-comment", "+issue-link", "+relation-remove"}
