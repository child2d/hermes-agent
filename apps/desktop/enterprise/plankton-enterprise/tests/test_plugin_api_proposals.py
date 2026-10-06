"""批 3 · 新建草稿卡的**提案入口** —— agent 出件箱 + 那一个提案工具（人类字段硬约束承重）。

设计：docs/plankton/N7-technical-design/N7-20261006-plankton-session-packs.md
§0 / §8（批 3 · 新建草稿卡的提案入口，Perry 2026-10-07 裁定「要」）。

本文件钉住：
  * 提案存成**具名提案**并返回**引用键**（`<packId>:<token>`）；取回按引用键；
  * **命名空间**：别的包的键取不到；键形不对取不到（多提案不串）；
  * **清理**：过期条目不返回、并在读时被清掉；`clear_proposals` 清空；坏文件当作空（不炸）；
  * **人类字段硬约束（承重 A）**：只收 `agent-drafted` 的字段键；拿掉该闸 ⇒ 代理字段被接受（变红）；
  * **不开第二写口 / 不 spawn**：本模块与后端路由都不跑 shaoke-cli；
  * **工具注册**：恰好一个 agent 工具，handler 返回引用键与指令；
  * **漂移锁**：`AGENT_DRAFTABLE_FIELDS` ≡ 声明里 `agent-drafted` 的键集。

夹具一律**合成**：临时出件箱文件、假 ctx、假 CLI；不碰真实台账、不写个人 home。
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PROPOSALS_PATH = PLUGIN_ROOT / "proposals.py"
PLUGIN_JS = PLUGIN_ROOT / "desktop" / "plugin.js"
PLUGIN_API = PLUGIN_ROOT / "dashboard" / "plugin_api.py"

PROPOSALS_SRC = PROPOSALS_PATH.read_text(encoding="utf-8")


def _load_module(name: str, path: Path, source: str | None = None):
    if source is None:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module
    # A mutated copy lives in a temp file (never the repo).
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as handle:
        handle.write(source)
        tmp = Path(handle.name)
    try:
        spec = importlib.util.spec_from_file_location(name, tmp)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        return module
    finally:
        tmp.unlink(missing_ok=True)


@pytest.fixture()
def proposals():
    return _load_module("plankton_enterprise_proposals_test", PROPOSALS_PATH)


@pytest.fixture()
def store(monkeypatch, tmp_path):
    """A private outbox file for each test (never the real engine home)."""
    path = tmp_path / "proposals.json"
    monkeypatch.setenv("PLANKTON_PROPOSALS_FILE", str(path))
    return path


class RecordingContext:
    """The smallest shape of ``PluginContext`` the tool registration may use."""

    def __init__(self, *, with_hook: bool = True) -> None:
        self.tools: list[dict] = []
        if with_hook:
            self.register_tool = self._register_tool  # type: ignore[attr-defined]
        self._register_tool_kwargs: dict = {}

    def _register_tool(self, **kwargs):
        self.tools.append(kwargs)
        return None


# ── 1 · 具名提案 + 引用键 + 命名空间 ─────────────────────────────────────────


def test_create_proposal_returns_a_namespaced_reference_key(proposals, store):
    result = proposals.create_proposal(record={"title": "修复登录", "description": "背景"}, actions=["confirm-create", "discard"], now=1000)
    assert result["kind"] == "ok"
    ref = result["ref"]
    assert ref.startswith("baymax:"), "the reference key is namespaced by pack"
    assert re.match(r"^baymax:[0-9a-f]{12}$", ref), ref
    entry = proposals.get_proposal(ref, pack_id="baymax", now=1001)
    assert entry is not None
    assert entry["record"] == {"title": "修复登录", "description": "背景"}
    assert entry["block"] == "plankton-baymax-new"
    assert entry["actions"] == ["confirm-create", "discard"]
    assert entry["expiresAt"] > entry["createdAt"], "an expiry is stamped (清理规则)"

    # two proposals never collide
    other = proposals.create_proposal(record={"title": "另一条"}, now=1000)
    assert other["ref"] != ref


def test_reference_keys_do_not_cross_packs(proposals, store):
    ref = proposals.create_proposal(record={"title": "x"}, now=1000)["ref"]
    assert proposals.get_proposal(ref, pack_id="other", now=1001) is None, "another pack's namespace must not resolve"
    assert proposals.get_proposal("other:0123456789ab", pack_id="baymax", now=1001) is None
    assert proposals.get_proposal("baymax", now=1001) is None, "not a namespaced key"
    assert proposals.get_proposal("baymax:0123456789ab", pack_id="baymax", now=1001) is None, "unknown token"


def test_unknown_pack_or_block_is_refused(proposals, store):
    assert proposals.create_proposal(pack_id="other", record={"title": "x"})["note"] == "pack-not-declared"
    assert proposals.create_proposal(block="plankton-baymax-plan", record={"title": "x"})["note"] == "block-not-declared"
    assert proposals.create_proposal(record={})["note"] == "record-empty"
    assert proposals.create_proposal(record={"title": "x"}, actions=["nope"])["note"].startswith("action-not-declared")


# ── 2 · 清理：过期 / 清空 / 坏文件 ───────────────────────────────────────────


def test_expired_proposals_are_dropped_and_pruned(proposals, store):
    ref = proposals.create_proposal(record={"title": "x"}, ttl_seconds=10, now=1000)["ref"]
    assert proposals.get_proposal(ref, pack_id="baymax", now=1005) is not None
    assert proposals.get_proposal(ref, pack_id="baymax", now=2000) is None, "an expired ref must NOT resolve"
    # …and it was pruned from the file on that read (no stale resurrection later)
    on_disk = json.loads(store.read_text(encoding="utf-8"))
    assert ref not in on_disk["proposals"]


def test_clear_and_corrupt_store_are_safe(proposals, store):
    proposals.create_proposal(record={"title": "a"}, now=1000)
    proposals.create_proposal(record={"title": "b"}, now=1000)
    assert proposals.clear_proposals() == 2
    assert proposals.get_proposal("baymax:0123456789ab", pack_id="baymax") is None

    store.write_text("{ this is not json", encoding="utf-8")
    # a corrupt outbox degrades to EMPTY — it never raises into the door
    assert proposals.get_proposal("baymax:0123456789ab", pack_id="baymax") is None
    assert proposals.create_proposal(record={"title": "x"}, now=1000)["kind"] == "ok"


# ── 3 · 人类字段硬约束（承重 A）───────────────────────────────────────────────


@pytest.mark.parametrize("key", ["assignee-id", "estimate-end", "type-id", "priority-id", "project-id", "id", "label-ids", "parent-id"])
def test_a_human_tier_field_is_refused_by_the_proposal_entry(proposals, store, key):
    result = proposals.create_proposal(record={"title": "x", key: "9"}, now=1000)
    assert result["kind"] == "rejected"
    assert result["note"] == f"field-tier-not-agent-draftable:{key}", "只有 agent 可起草的字段才允许进提案"
    assert proposals.get_proposal("baymax:000000000000", pack_id="baymax") is None


def test_a_malformed_value_is_refused(proposals, store):
    assert proposals.create_proposal(record={"title": ["a", "b"]})["note"] == "field-value-malformed:title"
    assert proposals.create_proposal(record={"title": 1.5})["note"] == "field-value-malformed:title"
    assert proposals.create_proposal(record={"title": True})["kind"] == "ok"  # booleans are lossless


def test_loadbearing_A_removing_the_human_field_gate_lets_agent_fill_it(proposals, store):
    """The tier gate is load-bearing: short-circuit it and the SAME call now stores a human field."""
    from_ = (
        "    for key in record:\n"
        "        if str(key) not in AGENT_DRAFTABLE_FIELDS:\n"
        '            return {"kind": "rejected", "note": f"field-tier-not-agent-draftable:{key}"}\n'
    )
    assert PROPOSALS_SRC.count(from_) == 1, "mutation anchor must be unique"
    mutant = _load_module("plankton_enterprise_proposals_mutant", PROPOSALS_PATH, PROPOSALS_SRC.replace(from_, "    pass\n"))
    # 对照：原版拒
    assert proposals.create_proposal(record={"title": "x", "assignee-id": "9"}, now=1000)["kind"] == "rejected"
    # 突变：拿掉闸门后，`assignee-id`（user-fact，只能本人给）被代填进提案
    result = mutant.create_proposal(record={"title": "x", "assignee-id": "9"}, now=1000)
    assert result["kind"] == "ok", "拿掉人类字段闸后 agent 就能代填 —— 该闸是承重的"
    entry = mutant.get_proposal(result["ref"], pack_id="baymax", now=1001)
    assert entry["record"]["assignee-id"] == "9"


# ── 4 · 不开第二写口 / 不 spawn ──────────────────────────────────────────────


def test_the_outbox_never_spawns_or_touches_a_cli(proposals, store):
    """Source-level + behavioural: this module runs no process."""
    for forbidden in ("subprocess", "Popen", "os.system", "os.spawn", "import pty"):
        assert forbidden not in PROPOSALS_SRC, f"the proposal outbox must not shell out ({forbidden})"
    ref = proposals.create_proposal(record={"title": "x"}, now=1000)["ref"]
    proposal_path = proposals.store_path()
    before = proposal_path.read_bytes()
    assert proposals.get_proposal(ref, pack_id="baymax", now=1001) is not None
    assert proposal_path.read_bytes() == before, "a read of a live proposal writes nothing"


def test_the_agent_half_registers_exactly_one_tool(proposals):
    ctx = RecordingContext()
    assert proposals.register_tools(ctx) is None
    assert len(ctx.tools) == 1, "this plugin exposes exactly ONE proposal tool"
    tool = ctx.tools[0]
    assert tool["name"] == proposals.TOOL_NAME == "plankton_propose_draft"
    assert tool["toolset"] == proposals.TOOLSET
    assert callable(tool["handler"])
    assert tool["schema"]["parameters"]["properties"]["fields"]["type"] == "object"


def test_a_host_without_the_tool_hook_is_reported_loudly(proposals, caplog):
    import logging

    ctx = RecordingContext(with_hook=False)
    with caplog.at_level(logging.WARNING, logger=proposals.__name__):
        assert proposals.register_tools(ctx) is None
    assert not hasattr(ctx, "tools") or ctx.tools == []
    assert any("register_tool" in record.message for record in caplog.records), "a missing hook must be visible"


def test_the_handler_returns_the_reference_key_and_refuses_human_fields(proposals, store):
    ok = json.loads(proposals.handle_propose_draft({"fields": {"title": "修复登录"}}))
    assert ok["ok"] is True
    assert ok["ref"].startswith("baymax:")
    assert ok["instruction"] == f'::plankton-baymax-new{{key="{ok["ref"]}"}}', "the handler hands back the exact instruction"
    # …and the stored proposal resolves
    assert proposals.get_proposal(ok["ref"], pack_id="baymax") is not None

    bad = json.loads(proposals.handle_propose_draft({"fields": {"title": "x", "assignee-id": "9"}}))
    assert bad["ok"] is False
    assert bad["error"] == "field-tier-not-agent-draftable:assignee-id"

    empty = json.loads(proposals.handle_propose_draft({}))
    assert empty["ok"] is False and empty["error"] == "record-empty"


# ── 5 · 漂移锁：声明里的 agent-drafted 键集 ≡ 硬约束白名单 ────────────────────


def test_the_agent_draftable_whitelist_mirrors_the_declaration(proposals):
    source = PLUGIN_JS.read_text(encoding="utf-8")
    declared = set(re.findall(r"['\"]?([A-Za-z0-9-]+)['\"]?:\s*'agent-drafted'", source))
    assert declared, "the pack must tier some fields as agent-drafted (regexp found none — check plugin.js shape)"
    assert declared == set(proposals.AGENT_DRAFTABLE_FIELDS), (
        f"the proposal whitelist drifted from the declaration: only-in-decl={sorted(declared - set(proposals.AGENT_DRAFTABLE_FIELDS))} "
        f"only-in-whitelist={sorted(set(proposals.AGENT_DRAFTABLE_FIELDS) - declared)}"
    )
    # The proposal block itself must be declaration-sourced as a PROPOSAL block (not a ledger read).
    assert re.search(r"tag:\s*'plankton-baymax-new',[^}]*?source:\s*\{\s*proposals:\s*true\s*\}", source, re.S), (
        "the new-draft block must declare `source:{proposals:true}`"
    )


# ── 6 · 后端路由：只读解析（不 spawn）────────────────────────────────────────


@pytest.fixture()
def api():
    return _load_module("plankton_enterprise_plugin_api_proposals", PLUGIN_API)


def test_pack_proposal_route_resolves_and_never_spawns(api, proposals, store, monkeypatch):
    monkeypatch.setattr(api.subprocess, "run", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("the proposal route must not spawn")))
    # Real clock: the route reads with the current time, so seed with the current time too.
    ref = proposals.create_proposal(record={"title": "修复登录"})["ref"]
    result = api.pack_proposal(api.PackProposalRequest(packId="baymax", ref=ref))
    assert result["kind"] == "ok"
    assert result["proposal"]["record"] == {"title": "修复登录"}

    assert api.pack_proposal(api.PackProposalRequest(packId="baymax", ref="baymax:ffffffffffff"))["note"] == "proposal-unresolved"
    assert api.pack_proposal(api.PackProposalRequest(packId="other", ref=ref))["note"] == "pack-not-declared"
    assert api.pack_proposal(api.PackProposalRequest(packId="baymax", ref="nonsense"))["note"] == "proposal-unresolved"
    assert api.pack_proposal(api.PackProposalRequest(packId="baymax", ref="other:0123456789ab"))["note"] == "proposal-unresolved"


def test_the_backend_route_is_read_only(api):
    source = PLUGIN_API.read_text(encoding="utf-8")
    assert '@router.post("/packs/proposal")' in source
    # The read door has no confirm latch and no write template (it cannot reach a write).
    assert "read-path-cannot-use-write-template" in source
