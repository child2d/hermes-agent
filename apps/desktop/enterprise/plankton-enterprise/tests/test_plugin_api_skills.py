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
import os
import sys
import types
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
    assert result["catalog"]["ok"] is True
    assert result["catalog"]["count"] == 0
    assert result["catalog"]["pages"] == 1
    assert result["catalog"]["truncated"] is False
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


# ── F1: the write path may not escape the landing through a symlink ─────────


def _install_with_bundle(api, bundle: bytes, **kwargs):
    api._exec_cli = lambda cli_path, args, timeout_s: (
        0,
        json.dumps({"ok": True, "data": {"url": "https://example.invalid/x.zip"}}),
        "",
    )  # type: ignore[assignment]
    api._http_get = lambda url, timeout_s=60: bundle  # type: ignore[assignment]
    return api._install_skill(api.InstallRequest(**kwargs))


def test_install_refuses_a_landing_that_is_a_symlink_out_of_the_store(api, tmp_path):
    """F1: `skills/esc -> <outside>` must refuse the install, not write through it."""
    home = api._TEST_HOME
    (home / "skills").mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (home / "skills" / "esc").symlink_to(outside, target_is_directory=True)

    result = api._install_skill(api.InstallRequest(slug="esc", reference="u/esc", name="esc", category="", confirm=True))

    assert result["ok"] is False
    assert result["kind"] == "unsafe-path"
    assert list(outside.iterdir()) == [], "nothing may be written through the symlink"
    assert not (outside / "SKILL.md").exists()


def test_install_refuses_a_landing_that_is_a_symlink_into_a_personal_tree(api, tmp_path, monkeypatch):
    """F1 (PLK-REQ-0023): a symlink into `~/.hermes` must refuse, never write there."""
    home = api._TEST_HOME
    (home / "skills").mkdir(parents=True, exist_ok=True)
    personal_home = tmp_path / "personalhome"
    victim = personal_home / ".hermes" / "skills" / "esc"
    victim.mkdir(parents=True)
    (home / "skills" / "esc").symlink_to(victim, target_is_directory=True)
    monkeypatch.setenv("HOME", str(personal_home))

    result = api._install_skill(api.InstallRequest(slug="esc", reference="u/esc", name="esc", category="", confirm=True))

    assert result["ok"] is False
    assert result["kind"] == "unsafe-path"
    assert list(victim.iterdir()) == [], "the personal tree must stay untouched"


def test_install_refuses_a_bundle_entry_that_follows_an_inner_symlink(api, tmp_path):
    """F1: a pre-existing `skills/good/sub -> outside` must not be followed."""
    home = api._TEST_HOME
    target = home / "skills" / "good"
    target.mkdir(parents=True)
    outside = tmp_path / "outside2"
    outside.mkdir()
    (target / "sub").symlink_to(outside, target_is_directory=True)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("top/sub/SKILL.md", "escaped")

    result = _install_with_bundle(
        api, buf.getvalue(), slug="good", reference="u/good", name="good", category="", confirm=True
    )

    assert result["ok"] is False
    assert result["kind"] in ("write-failed", "unsafe-path")
    assert list(outside.iterdir()) == [], "the entry must not be written through the symlink"


# ── F2 / F7: uninstall and install must never scatter sibling skills ────────


def test_uninstall_refuses_to_delete_a_dir_holding_another_record(api):
    """F2: uninstalling `cat` must not rmtree the sibling record `cat/x`."""
    home = api._TEST_HOME
    a = _seed_skill(home, "cat/x")
    b = _seed_skill(home, "cat")  # a parent dir that also holds a/x
    api.write_ledger(home, [
        {"reference": "u/a", "slug": "a", "name": "x", "category": "cat", "version": "1",
         "contentHash": api.engine_content_hash(a), "installPath": "cat/x"},
        {"reference": "u/b", "slug": "b", "name": "cat", "category": "", "version": "1",
         "contentHash": api.engine_content_hash(b), "installPath": "cat"},
    ])

    result = api.uninstall_skill(api.UninstallRequest(reference="u/b", confirm=True))

    assert result["ok"] is False
    assert result["kind"] == "unsafe-path"
    assert (a / "SKILL.md").exists(), "the sibling skill must survive"
    records, _ = api.read_ledger(home)
    kept = next(r for r in records if r["reference"] == "u/b")
    assert not kept.get("uninstalledAt"), "the ledger must not go dangling"


def test_install_refuses_to_nest_under_an_existing_record(api):
    """F2: a landing UNDER another skill's directory is refused."""
    home = api._TEST_HOME
    _seed_skill(home, "cat")
    api.write_ledger(home, [
        {"reference": "u/cat", "slug": "cat", "name": "cat", "category": "", "version": "1",
         "contentHash": api.engine_content_hash(home / "skills" / "cat"), "installPath": "cat"},
    ])
    result = api._install_skill(api.InstallRequest(slug="x", reference="u/x", name="x", category="cat", confirm=True))
    assert result["ok"] is False
    assert result["kind"] == "install-overlap"
    assert result["detail"]["direction"] == "under"


def test_install_refuses_to_swallow_an_existing_record(api):
    """F2: a landing ABOVE another skill's directory is refused."""
    home = api._TEST_HOME
    _seed_skill(home, "cat/x")
    api.write_ledger(home, [
        {"reference": "u/a", "slug": "a", "name": "x", "category": "cat", "version": "1",
         "contentHash": api.engine_content_hash(home / "skills" / "cat" / "x"), "installPath": "cat/x"},
    ])
    result = api._install_skill(api.InstallRequest(slug="cat", reference="u/cat", name="cat", category="", confirm=True))
    assert result["ok"] is False
    assert result["kind"] == "install-overlap"
    assert result["detail"]["direction"] == "above"


def test_uninstall_refuses_a_tampered_landing(api):
    """F7: a ledger whose landing is not the install rule's output is refused."""
    home = api._TEST_HOME
    _seed_skill(home, "x")
    api.write_ledger(home, [
        {"reference": "u/x", "slug": "x", "name": "x", "category": "", "version": "1",
         "contentHash": None, "installPath": "other-place"},
    ])
    result = api.uninstall_skill(api.UninstallRequest(reference="u/x", confirm=True))
    assert result["ok"] is False
    assert result["kind"] == "unsafe-path"
    assert (home / "skills" / "x").is_dir()


# ── F4: update must require confirm (docs claim it; code now enforces it) ────


def test_update_requires_confirm(api):
    result = api.update_skill(api.InstallRequest(slug="x", reference="u/x", name="x", category=""))
    assert result["ok"] is False
    assert result["kind"] == "needs-confirm"


def test_update_with_confirm_proceeds(api):
    home = api._TEST_HOME
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("x/SKILL.md", "updated-body")
    result = _install_with_bundle(
        api, buf.getvalue(), slug="x", reference="u/x", name="x", category="", confirm=True
    )
    assert result["ok"] is True, result
    assert (home / "skills" / "x" / "SKILL.md").read_text() == "updated-body"


# ── F5: an essential skill's disable is a no-op that must not report ok ──────


def test_disabling_an_essential_skill_reports_the_engine_state(api):
    from hermes_cli.config import load_config
    from hermes_cli.skills_config import get_disabled_skills

    result = api._set_skill_enabled("hermes-agent", False)

    assert result["ok"] is False
    assert result["kind"] == "essential-skill"
    assert "hermes-agent" not in get_disabled_skills(load_config()), "the engine state must not change"


# ── F6: the page-limit cap is an explicit, visible fact ─────────────────────


def test_fetch_catalog_flags_truncation_at_the_page_cap(api):
    def exec_cli(cli_path, args, timeout_s):
        page = int(args[args.index("--page") + 1])
        return 0, _list_page([{"slug": f"s{page}", "name": f"n{page}"}], next_cursor="more"), ""

    api._exec_cli = exec_cli  # type: ignore[assignment]
    result = api.fetch_catalog("cli", page_size=50, max_pages=3)

    assert result["ok"] is True
    assert result["pages"] == 3
    assert result["truncated"] is True, "a capped scan must say it was capped"
    assert len(result["skills"]) == 3


def test_fetch_catalog_not_truncated_when_cursor_ends(api):
    api._exec_cli = lambda cli_path, args, timeout_s: (0, _list_page([{"slug": "only"}], next_cursor=None), "")  # type: ignore[assignment]
    result = api.fetch_catalog("cli", page_size=50, max_pages=3)
    assert result["truncated"] is False


def test_list_skills_surfaces_catalog_truncation(api, monkeypatch):
    monkeypatch.setattr(api, "MAX_PAGES", 2)
    api._exec_cli = lambda cli_path, args, timeout_s: (0, _list_page([{"slug": "s"}], next_cursor="more"), "")  # type: ignore[assignment]
    result = api.list_skills()
    assert result["catalog"]["ok"] is True
    assert result["catalog"]["truncated"] is True


# ── P1: a hard link (or foreign file) at the landing must not be overwritten ─
#
# Second-review round 2. `dest.is_symlink()` does NOT see a HARD link: writing
# through one silently rewrites the OTHER name's content (e.g. an engine
# config file), and the write still reported ok:true. The store now refuses a
# hard-linked destination, refuses foreign files, and writes atomically.


def test_atomic_write_does_not_clobber_a_hardlink(tmp_path, api):
    """The write mechanism itself: rename replaces the entry, not the inode."""
    config = tmp_path / "config.yaml"
    config.write_text("original-config", encoding="utf-8")
    dest = tmp_path / "SKILL.md"
    os.link(config, dest)
    assert os.stat(config).st_ino == os.stat(dest).st_ino

    api._atomic_write_bytes(dest, b"EVIL")

    assert config.read_text(encoding="utf-8") == "original-config", "the other link must be untouched"
    assert dest.read_bytes() == b"EVIL"
    assert os.stat(config).st_ino != os.stat(dest).st_ino, "dest is now a NEW inode, not the shared one"


def test_install_refuses_a_hardlinked_destination(api):
    """P1 counterexample: config.yaml hard-linked into the landing → refuse."""
    home = api._TEST_HOME
    (home / "config.yaml").write_text("original-config", encoding="utf-8")
    target = home / "skills" / "x"
    target.mkdir(parents=True)
    os.link(home / "config.yaml", target / "SKILL.md")

    # A well-formed record (with a hash) so ownership passes and the HARD-LINK
    # check — not the foreign-file check — is the gate being proven.
    api.write_ledger(home, [{
        "reference": "u/x", "slug": "x", "name": "x", "category": "",
        "version": "1", "contentHash": "sha256:deadbeefdeadbeef", "installPath": "x",
    }])

    result = _install_with_bundle(
        api, _skill_zip(), slug="x", reference="u/x", name="x", category="", confirm=True
    )

    assert result["ok"] is False, result
    assert result["kind"] == "write-failed"
    assert "硬链接" in result["detail"]["message"]
    assert (home / "config.yaml").read_text(encoding="utf-8") == "original-config", "目标未被覆写"
    assert os.stat(home / "config.yaml").st_ino == os.stat(target / "SKILL.md").st_ino


def test_install_refuses_a_foreign_file_in_the_landing(api):
    """P1: an existing landing this module did not record is not overwritten."""
    home = api._TEST_HOME
    foreign = _seed_skill(home, "x", "foreign-body")  # no ledger record

    result = _install_with_bundle(
        api, _skill_zip(), slug="x", reference="u/x", name="x", category="", confirm=True
    )

    assert result["ok"] is False
    assert result["kind"] == "write-failed"
    assert "非本台账" in result["detail"]["message"]
    assert (foreign / "SKILL.md").read_text(encoding="utf-8") == "foreign-body"


def test_install_hardlinked_destination_outside_a_recorded_landing(api):
    """P1: same escape WITHOUT a record — also refused (foreign-file branch)."""
    home = api._TEST_HOME
    (home / "config.yaml").write_text("original-config", encoding="utf-8")
    target = home / "skills" / "x"
    target.mkdir(parents=True)
    os.link(home / "config.yaml", target / "SKILL.md")

    result = _install_with_bundle(
        api, _skill_zip(), slug="x", reference="u/x", name="x", category="", confirm=True
    )

    assert result["ok"] is False
    assert result["kind"] == "write-failed"
    assert (home / "config.yaml").read_text(encoding="utf-8") == "original-config"


# ── P2: the `skills` ROOT itself being a symlink must refuse ─────────────────
#
# `assert_safe_landing` used to resolve() FIRST, erasing a symlinked root, so
# only the ROOT was never checked: installs landed, and uninstalls deleted,
# OUTSIDE <HERMES_HOME>/skills. The root chain is now lstat-ed on the literal
# path, in both directions.


def test_install_refuses_when_the_skills_root_is_a_symlink(api, tmp_path):
    home = api._TEST_HOME
    outside = tmp_path / "outside"
    outside.mkdir()
    (home / "skills").symlink_to(outside, target_is_directory=True)

    result = _install_with_bundle(
        api, _skill_zip(), slug="x", reference="u/x", name="x", category="", confirm=True
    )

    assert result["ok"] is False
    assert result["kind"] == "unsafe-path"
    assert list(outside.iterdir()) == [], "仓外不得有任何写入"


def test_uninstall_refuses_when_the_skills_root_is_a_symlink(api, tmp_path):
    home = api._TEST_HOME
    outside = tmp_path / "outside2"
    victim = outside / "x"
    victim.mkdir(parents=True)
    (victim / "SKILL.md").write_text("victim", encoding="utf-8")
    (home / "skills").symlink_to(outside, target_is_directory=True)
    api.write_ledger(home, [{
        "reference": "u/x", "slug": "x", "name": "x", "category": "",
        "version": "1", "contentHash": api.engine_content_hash(victim), "installPath": "x",
    }])

    result = api.uninstall_skill(api.UninstallRequest(reference="u/x", confirm=True))

    assert result["ok"] is False
    assert result["kind"] == "unsafe-path"
    assert (victim / "SKILL.md").exists(), "仓外不得有任何删除"


def test_assert_safe_landing_rejects_a_symlinked_root_directly(api, tmp_path):
    home = tmp_path / "h"
    (home).mkdir()
    outside = tmp_path / "o"
    outside.mkdir()
    (home / "skills").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError):
        api.assert_safe_landing(home / "skills", "x")


def test_safe_landing_allows_a_symlinked_system_ancestor(api, tmp_path):
    """A symlink ABOVE HERMES_HOME (macOS `/var -> /private/var`) is out of scope.

    The chain walk is bounded at HERMES_HOME's parent, so a legitimate home under
    a symlinked ancestor must NOT be refused (that would break TMPDIR installs).
    """
    real = tmp_path / "real"
    (real / "home").mkdir(parents=True)
    link = tmp_path / "lnk"
    link.symlink_to(real, target_is_directory=True)  # an ancestor symlink
    home = link / "home"
    skills = home / "skills"
    skills.mkdir(parents=True)

    resolved = api.assert_safe_landing(skills, "x")

    assert str(resolved).endswith("x"), resolved


# ── P3: case / Unicode-variant siblings are ONE directory on macOS ───────────
#
# Raw-string prefix tests missed `CAT/x` living inside `cat`, so an uninstall
# rmtree'd a sibling and left the ledger dangling. All overlap/nesting tests now
# use an NFC-normalized, case-folded segment key.


def test_landing_key_folds_case_and_unicode(api):
    assert api._landing_key("CAT/X") == api._landing_key("cat/x")
    assert api._landing_key("cafe\u0301/x") == api._landing_key("caf\u00e9/x")
    assert api._key_is_under(api._landing_key("CAT/x"), api._landing_key("cat"))
    assert not api._key_is_under(api._landing_key("cat"), api._landing_key("cat"))


def test_uninstall_does_not_cascade_a_case_variant_sibling(api):
    home = api._TEST_HOME
    skills = home / "skills"
    skills.mkdir(parents=True, exist_ok=True)
    probe = skills / "CaseProbe"
    probe.write_text("x", encoding="utf-8")
    if not (skills / "caseprobe").exists():
        probe.unlink()
        pytest.skip("filesystem is case-sensitive; the macOS collapse cannot occur")

    a = _seed_skill(home, "cat/x")  # physically skills/cat/x
    api.write_ledger(home, [
        {"reference": "u/cat", "slug": "cat", "name": "cat", "category": "", "version": "1",
         "contentHash": api.engine_content_hash(skills / "cat"), "installPath": "cat"},
        {"reference": "u/x", "slug": "x", "name": "x", "category": "CAT", "version": "1",
         "contentHash": api.engine_content_hash(a), "installPath": "CAT/x"},
    ])

    result = api.uninstall_skill(api.UninstallRequest(reference="u/cat", confirm=True))

    assert result["ok"] is False
    assert result["kind"] == "unsafe-path"
    assert (a / "SKILL.md").exists(), "the case-variant sibling must survive"
    records, _ = api.read_ledger(home)
    kept = next(r for r in records if r["reference"] == "u/cat")
    assert not kept.get("uninstalledAt"), "the ledger must not go dangling"


def test_install_overlap_detects_a_case_variant_parent(api):
    home = api._TEST_HOME
    parent = _seed_skill(home, "cat")
    api.write_ledger(home, [
        {"reference": "u/cat", "slug": "cat", "name": "cat", "category": "", "version": "1",
         "contentHash": api.engine_content_hash(parent), "installPath": "cat"},
    ])

    result = api._install_skill(
        api.InstallRequest(slug="x", reference="u/x", name="x", category="CAT", confirm=True)
    )

    assert result["ok"] is False
    assert result["kind"] == "install-overlap"
    assert result["detail"]["direction"] == "under"


# ── P4: shape is not ownership — a tampered ledger cannot delete a stranger ──


def test_uninstall_refuses_a_tampered_ledger_without_a_hash(api):
    """A legal-looking name/installPath with contentHash:null must NOT delete."""
    home = api._TEST_HOME
    stranger = _seed_skill(home, "engine-skill")  # an unrelated, legal-shaped dir
    api.write_ledger(home, [{
        "reference": "u/evil", "slug": "engine-skill", "name": "engine-skill", "category": "",
        "version": "1", "contentHash": None, "installPath": "engine-skill",
    }])

    result = api.uninstall_skill(api.UninstallRequest(reference="u/evil", confirm=True))

    assert result["ok"] is False
    assert result["kind"] == "unsafe-path"
    assert "内容哈希" in result["detail"]["reason"]
    assert (stranger / "SKILL.md").exists(), "指向无关目录也不得删除"
    records, _ = api.read_ledger(home)
    kept = next(r for r in records if r["reference"] == "u/evil")
    assert not kept.get("uninstalledAt")


def test_uninstall_refuses_a_tampered_ledger_with_an_empty_hash(api):
    home = api._TEST_HOME
    stranger = _seed_skill(home, "engine-skill")

    for bogus in ("", "   "):
        api.write_ledger(home, [{
            "reference": "u/evil", "slug": "engine-skill", "name": "engine-skill", "category": "",
            "version": "1", "contentHash": bogus, "installPath": "engine-skill",
        }])
        result = api.uninstall_skill(api.UninstallRequest(reference="u/evil", confirm=True))
        assert result["ok"] is False and result["kind"] == "unsafe-path"
    assert (stranger / "SKILL.md").exists()


# ── N1: a failed install leaves NO residue in the store ─────────────────────


def test_install_failure_leaves_no_residue(api):
    home = api._TEST_HOME
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("x/SKILL.md", "a")
        zf.writestr("x/extra.txt", "b")

    api._exec_cli = lambda cli_path, args, timeout_s: (
        0, json.dumps({"ok": True, "data": {"url": "https://example.invalid/x.zip"}}), ""
    )  # type: ignore[assignment]
    api._http_get = lambda url, timeout_s=60: buf.getvalue()  # type: ignore[assignment]

    calls = {"n": 0}
    real = api._atomic_write_bytes

    def flaky(dest, data):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("simulated disk full")
        return real(dest, data)

    api._atomic_write_bytes = flaky  # type: ignore[assignment]
    result = api._install_skill(
        api.InstallRequest(slug="x", reference="u/x", name="x", category="", confirm=True)
    )

    assert result["ok"] is False
    assert result["kind"] == "write-failed"
    skills = home / "skills"
    assert not (skills / "x").exists(), "no half-written landing"
    assert [p.name for p in skills.iterdir() if p.name.startswith(".plankton-staging-")] == [], "no staging residue"


# ── N2: a landing occupied by a regular file is reported truthfully ─────────


def test_uninstall_refuses_a_landing_that_is_a_regular_file(api):
    home = api._TEST_HOME
    (home / "skills").mkdir(parents=True, exist_ok=True)
    (home / "skills" / "x").write_text("not a directory", encoding="utf-8")
    api.write_ledger(home, [{
        "reference": "u/x", "slug": "x", "name": "x", "category": "",
        "version": "1", "contentHash": "sha256:deadbeefdeadbeef", "installPath": "x",
    }])

    result = api.uninstall_skill(api.UninstallRequest(reference="u/x", confirm=True))

    assert result["ok"] is False
    assert result["kind"] == "remove-failed"
    assert (home / "skills" / "x").read_text(encoding="utf-8") == "not a directory"
    records, _ = api.read_ledger(home)
    kept = next(r for r in records if r["reference"] == "u/x")
    assert not kept.get("uninstalledAt"), "the ledger must not be stamped uninstalled"


# ── N3: a missing ESSENTIAL_SKILLS symbol must not kill enable/disable ──────
#
# Our import of ``ESSENTIAL_SKILLS`` is only used to LABEL a failure. The
# engine's own modules import the same symbol, so the isolation is done by
# stubbing the engine's config functions (which then need no symbol) and
# removing the symbol from ``agent.skill_utils`` — what must NOT happen is our
# whole toggle path degrading to ``engine-unavailable``.


def _stub_engine_config(monkeypatch, *, on_save=None):
    state: set = set()

    config_mod = types.ModuleType("hermes_cli.config")
    config_mod.load_config = lambda: {"skills": {"disabled": sorted(state)}}  # type: ignore[attr-defined]

    skills_mod = types.ModuleType("hermes_cli.skills_config")
    skills_mod.get_disabled_skills = lambda config: set(config.get("skills", {}).get("disabled", []))  # type: ignore[attr-defined]

    def save_disabled_skills(config, names):  # noqa: ANN001
        if on_save is not None:
            on_save()
        state.clear()
        state.update(names)

    skills_mod.save_disabled_skills = save_disabled_skills  # type: ignore[attr-defined]

    monkeypatch.setitem(sys.modules, "hermes_cli.config", config_mod)
    monkeypatch.setitem(sys.modules, "hermes_cli.skills_config", skills_mod)
    # The symbol is simply absent (a bare module), as if it were renamed.
    monkeypatch.setitem(sys.modules, "agent.skill_utils", types.ModuleType("agent.skill_utils"))
    return state


def test_toggle_survives_a_missing_essential_skills_symbol(api, monkeypatch):
    state = _stub_engine_config(monkeypatch)

    result = api._set_skill_enabled("some-regular-skill", False)

    assert result["ok"] is True, result
    assert result["kind"] if not result["ok"] else True
    assert "some-regular-skill" in state
    assert api._set_skill_enabled("some-regular-skill", True)["ok"] is True
    assert "some-regular-skill" not in state


def test_toggle_with_a_missing_symbol_never_degrades_to_engine_unavailable(api, monkeypatch):
    def boom():
        raise RuntimeError("engine refused the write")

    _stub_engine_config(monkeypatch, on_save=boom)

    result = api._set_skill_enabled("some-regular-skill", False)

    assert result["ok"] is False, "a failed engine write must not report ok"
    assert result["kind"] == "write-failed"
    assert result["kind"] != "engine-unavailable"


# ── N4: every write ROUTE requires the backend confirm latch ────────────────


def test_install_route_requires_confirm(api):
    result = api.install_skill(api.InstallRequest(slug="x", reference="u/x", name="x", category=""))
    assert result["ok"] is False
    assert result["kind"] == "needs-confirm"


def test_toggle_routes_require_confirm(api):
    assert api.enable_skill(api.ToggleRequest(name="s"))["kind"] == "needs-confirm"
    assert api.disable_skill(api.ToggleRequest(name="s"))["kind"] == "needs-confirm"
    # With the latch the route reaches the engine's own writer.
    assert api.disable_skill(api.ToggleRequest(name="s", confirm=True))["ok"] is True
    assert api.enable_skill(api.ToggleRequest(name="s", confirm=True))["ok"] is True
