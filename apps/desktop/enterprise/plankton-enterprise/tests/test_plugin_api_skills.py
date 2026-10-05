"""Skill-market backend tests — the batch-2 step-2 acceptance carriers.

Covers:
  * the FOUR independently-visible failure classes (unauthorized / network /
    format mismatch / hash mismatch) plus the extra taxonomy members;
  * an empty catalog is a SUCCESS, never a failure;
  * hash parity: the local hash is the engine's OWN ``content_hash``;
  * the "disable" write goes to the ENGINE's own enable state;
  * human confirmation is required for uninstall / overwrite;
  * the skill store is refused inside a personal tree.

The CLI is never actually spawned: ``_exec_cli`` / ``_http_get`` are injected.
"""

from __future__ import annotations

import importlib.util
import io
import json
import zipfile
from pathlib import Path

import pytest

PLUGIN_API = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"


def load_plugin_api():
    spec = importlib.util.spec_from_file_location("plankton_enterprise_plugin_api_skills", PLUGIN_API)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def api(tmp_path, monkeypatch):
    module = load_plugin_api()
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    # Enterprise copy present (a stub); `_exec_cli` is injected so it never runs.
    cli = home / "bin" / "shaoke-cli"
    cli.parent.mkdir(parents=True, exist_ok=True)
    cli.write_text("#!/bin/sh\n", encoding="utf-8")
    cli.chmod(0o755)
    monkeypatch.delenv("PLANKTON_SHAOKE_CLI", raising=False)
    module._TEST_HOME = home  # type: ignore[attr-defined]
    return module


def _fake_exec(module, *, rc=0, out="", err=""):
    def run(cli_path, args, timeout_s):
        return rc, out, err
    module._exec_cli = run  # type: ignore[assignment]


def _list_page(items, next_cursor=None):
    return json.dumps({"ok": True, "data": {"items": items, "nextCursor": next_cursor}})


def _seed_skill(home: Path, install_path: str, body: str = "v1"):
    target = home / "skills" / install_path
    target.mkdir(parents=True, exist_ok=True)
    (target / "SKILL.md").write_text(body, encoding="utf-8")
    return target


# ── failure taxonomy: FOUR classes, each independently visible ───────────────


def test_catalog_unauthorized_is_its_own_kind(api):
    _fake_exec(api, rc=1, out="", err='{"error":{"code":401,"message":"unauthorized"}}')
    result = api.list_skills()
    assert result["ok"] is True
    assert result["catalog"]["ok"] is False
    assert result["catalog"]["kind"] == "unauthorized"


def test_catalog_network_failure_is_its_own_kind(api):
    _fake_exec(api, rc=1, out="", err="dial tcp 8.129.91.240:8000: connect: connection refused")
    result = api.list_skills()
    assert result["catalog"]["ok"] is False
    assert result["catalog"]["kind"] == "network-failed"


def test_catalog_not_json_is_its_own_kind(api):
    _fake_exec(api, rc=0, out="<html>not json</html>", err="")
    result = api.list_skills()
    assert result["catalog"]["kind"] == "not-json"


def test_catalog_shape_mismatch_is_its_own_kind(api):
    _fake_exec(api, rc=0, out=json.dumps({"data": {"items": "nope"}}), err="")
    result = api.list_skills()
    assert result["catalog"]["kind"] == "shape-mismatch"


def test_hash_mismatch_is_its_own_kind_and_visible(api):
    home = api._TEST_HOME
    target = _seed_skill(home, "cat/x", "original")
    engine_hash = api.engine_content_hash(target)
    api.write_ledger(home, [{
        "reference": "u/x", "slug": "x", "name": "x", "category": "cat",
        "version": "1", "contentHash": engine_hash, "installPath": "cat/x",
    }])
    # Local edits after install → hash differs from the record.
    (target / "SKILL.md").write_text("tampered", encoding="utf-8")
    _fake_exec(api, rc=0, out=_list_page([]), err="")
    result = api.list_skills()
    assert result["installed"][0]["hashState"] == "mismatch"


def test_empty_catalog_is_a_success_not_a_failure(api):
    _fake_exec(api, rc=0, out=_list_page([]), err="")
    result = api.list_skills()
    assert result["ok"] is True
    assert result["catalog"] == {"ok": True, "count": 0, "pages": 1}
    assert result["count"] == 0


def test_catalog_failure_still_renders_local_installed_facts(api):
    home = api._TEST_HOME
    target = _seed_skill(home, "cat/x")
    api.write_ledger(home, [{
        "reference": "u/x", "slug": "x", "name": "x", "category": "cat",
        "version": "1", "contentHash": api.engine_content_hash(target), "installPath": "cat/x",
    }])
    _fake_exec(api, rc=1, out="", err="connection refused")
    result = api.list_skills()
    assert result["catalog"]["ok"] is False
    assert result["installed"][0]["onDisk"] is True
    assert result["installed"][0]["localHash"]


# ── hash parity: the engine's own function, no second implementation ─────────


def test_local_hash_equals_engine_content_hash(api):
    home = api._TEST_HOME
    target = _seed_skill(home, "cat/x", "hello-world")
    api.write_ledger(home, [{
        "reference": "u/x", "slug": "x", "name": "x", "category": "cat",
        "version": "1", "contentHash": api.engine_content_hash(target), "installPath": "cat/x",
    }])
    _fake_exec(api, rc=0, out=_list_page([]), err="")
    result = api.list_skills()
    local = result["installed"][0]["localHash"]

    # Independent oracle: the engine function, called directly.
    from tools.skills_guard import content_hash

    assert local == content_hash(target)
    assert local.startswith("sha256:") and len(local) == len("sha256:") + 16


def test_engine_content_hash_returns_none_when_unreadable(api, tmp_path):
    assert api.engine_content_hash(tmp_path / "does-not-exist") is None


# ── disable maps to the ENGINE's own enable state ───────────────────────────


def test_disable_writes_the_engine_skills_disabled_key(api):
    home = api._TEST_HOME
    result = api._set_skill_enabled("some-skill", False)
    assert result["ok"] is True, result

    from hermes_cli.config import load_config
    from hermes_cli.skills_config import get_disabled_skills

    assert "some-skill" in get_disabled_skills(load_config())
    # …and the engine can read it back through its own reader.
    assert (home / "config.yaml").exists()

    # Re-enabling removes it from the engine's set.
    assert api._set_skill_enabled("some-skill", True)["ok"] is True
    assert "some-skill" not in get_disabled_skills(load_config())


def test_disable_requires_a_name(api):
    assert api._set_skill_enabled("", False)["kind"] == "bad-input"


# ── uninstall / overwrite require human confirmation ────────────────────────


def test_uninstall_requires_confirm_then_removes(api):
    home = api._TEST_HOME
    target = _seed_skill(home, "cat/x")
    api.write_ledger(home, [{
        "reference": "u/x", "slug": "x", "name": "x", "category": "cat",
        "version": "1", "contentHash": api.engine_content_hash(target), "installPath": "cat/x",
    }])

    denied = api.uninstall_skill(api.UninstallRequest(reference="u/x"))
    assert denied["ok"] is False
    assert denied["kind"] == "needs-confirm"
    assert target.is_dir(), "no confirm → nothing deleted"

    ok = api.uninstall_skill(api.UninstallRequest(reference="u/x", confirm=True))
    assert ok["ok"] is True and ok["removed"] is True
    assert not target.exists()
    # The ledger record is KEPT (traceability).
    records, _ = api.read_ledger(home)
    assert records[0]["uninstalledAt"]


def test_uninstall_refuses_a_skill_with_no_record(api):
    home = api._TEST_HOME
    _seed_skill(home, "someone/else")
    result = api.uninstall_skill(api.UninstallRequest(reference="u/nope", confirm=True))
    assert result["kind"] == "no-record"


def test_install_into_occupied_slot_needs_confirm(api):
    home = api._TEST_HOME
    _seed_skill(home, "cat/x", "pre-existing")  # on disk, not in our ledger
    result = api._install_skill(api.InstallRequest(slug="x", name="x", category="cat"))
    assert result["ok"] is False
    assert result["kind"] == "needs-confirm"
    assert result["detail"]["onDiskWithoutLedger"] is True


# ── install path / unzip helpers ────────────────────────────────────────────


def test_plan_install_path_matches_engine_rules(api):
    assert api.plan_install_path("x", "") == "x"
    assert api.plan_install_path("x", "cat") == "cat/x"
    assert api.plan_install_path("x", "a/b") == "a/b/x"
    assert api.plan_install_path("../evil", "") is None
    assert api.plan_install_path("a/b", "") is None  # skill name must be one segment
    assert api.plan_install_path("x", "/abs") is None


def test_strip_top_dir_keeps_a_lone_root_file(api):
    entries = [("SKILL.md", b"x")]
    assert api.strip_top_dir(entries) == entries
    assert api.strip_top_dir([("top/SKILL.md", b"x"), ("top/a.txt", b"y")]) == [("SKILL.md", b"x"), ("a.txt", b"y")]


def test_unzip_recovers_utf8_names_without_the_flag(api):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        # Force no UTF-8 flag, UTF-8 bytes in the name (what skillhub ships).
        info = zipfile.ZipInfo("技能/SKILL.md")
        info.flag_bits &= ~0x800
        zf.writestr(info, "body")
    entries = api._zip_entries(buf.getvalue())
    assert entries[0][0].endswith("SKILL.md")
    assert entries[0][0].split("/")[0] == "技能"


# ── install success path (injected CLI + fetch) ─────────────────────────────


def _skill_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("x/SKILL.md", "skill-body")
    return buf.getvalue()


def test_install_success_writes_files_and_records_engine_hash(api):
    home = api._TEST_HOME
    bundle = _skill_zip()

    def exec_cli(cli_path, args, timeout_s):
        assert args[:2] == ["skillhub", "+download"]
        return 0, json.dumps({"ok": True, "data": {"url": "https://example.invalid/x.zip"}}), ""

    api._exec_cli = exec_cli  # type: ignore[assignment]
    api._http_get = lambda url, timeout_s=60: bundle  # type: ignore[assignment]

    result = api._install_skill(api.InstallRequest(slug="x", reference="u/x", name="x", category=""))
    assert result["ok"] is True, result
    assert (home / "skills" / "x" / "SKILL.md").read_text() == "skill-body"
    from tools.skills_guard import content_hash

    assert result["record"]["contentHash"] == content_hash(home / "skills" / "x")
    records, _ = api.read_ledger(home)
    assert records[0]["reference"] == "u/x"


def test_install_no_bundle_is_reported(api):
    api._exec_cli = lambda cli_path, args, timeout_s: (1, "", '{"error":{"code":404,"detail":"该 Skill 无 zip 包"}}')  # type: ignore[assignment]
    result = api._install_skill(api.InstallRequest(slug="x", name="x"))
    assert result["kind"] == "no-bundle"


def test_install_without_name_is_bad_input(api):
    result = api._install_skill(api.InstallRequest(slug="x", name=""))
    assert result["kind"] == "bad-input"


# ── isolation: never a personal tree ────────────────────────────────────────


def test_assert_outside_personal_trees_rejects_hermes(tmp_path):
    api = load_plugin_api()
    personal = tmp_path / "personalhome"
    (personal / ".hermes").mkdir(parents=True)
    with pytest.raises(ValueError):
        api.assert_outside_personal_trees(personal / ".hermes" / "skills", personal_home=personal)
    with pytest.raises(ValueError):
        api.assert_outside_personal_trees(personal / ".hermes" / "profiles" / "x" / "skills", personal_home=personal)
    # A non-personal tree is fine.
    api.assert_outside_personal_trees(personal / "engine" / "home" / "skills", personal_home=personal)


def test_ledger_lives_under_the_enterprise_home(api):
    home = api._TEST_HOME
    assert api._ledger_path(home) == home / "plankton" / "skill-ledger.json"
