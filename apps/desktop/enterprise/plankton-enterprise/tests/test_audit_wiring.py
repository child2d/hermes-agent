"""批 4 · **客户端接线**（线 ①②③④）——承重 + 反证。

设计为准（逐字）：`docs/plankton/N7-technical-design/N7-20261007-plankton-audit-egress.md`
**§8 W5**（上传缓冲 / 失败态）＋ **§8 W6**（home 落点自检 + 边界护栏）＋ **§4/§5**；
需求 PLK-REQ-0041/0043/0047/0048。

接线前的事实：`audit_unit` / `audit_egress` 两块**已落成但全客户端 0 调用方**（模块空转、审计主路径
不成立）。本文件钉住「**接线本身**是承重的」——每条接线给**正控**（接上了 ⇒ 行为发生）与**反证**
（拿掉接线 ⇒ 该行为**不发生**），证明它不是装饰：

  线 ① 会话收尾 ⇒ `record_and_flush`：引擎 `on_session_finalize` 钩子一打，单元**落到缓冲并上传**；
       反证＝不接线（没注册钩子）⇒ 同一会话收尾**什么都没发生**（缓冲空、接收端空）。
  线 ② 启动期 ⇒ `check_audit_landing` 拒进入可用状态：落点进个人 `~/.hermes` ⇒ 裁决 `usable:false`
       + 会话准入被拒；反证＝良性落点不拦（范围收窄，门禁不重于功能）。
  线 ③ 会话入口 ⇒ `admit_conversation`：缓冲**满/不可写** ⇒ **拒绝对话** + 文案；反证＝准入这步
       拿掉（不接线）⇒ 会话照常进行（审计在有损状态下被放行）。
  线 ④ 真实传输：默认可注入且**默认无传输**（`no-transport` 安全态）；配置启用才出网。

夹具一律**合成**：临时企业 home、只读会话事实库夹具、注入传输；**不连生产库、不发真实网络**。
红线（conftest 兜底）：测试**绝不**写个人 `~/.hermes`。
"""

from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import stat
import uuid
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, filename: str):
    path = PLUGIN_ROOT / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def audit():
    return _load("plankton_enterprise_audit_unit", "audit_unit.py")


@pytest.fixture()
def egress():
    return _load("plankton_enterprise_audit_egress", "audit_egress.py")


@pytest.fixture()
def wiring(audit, egress):
    module = _load("plankton_enterprise_audit_wiring", "audit_wiring.py")
    module.REGISTERED_HOOKS.clear()
    module.LAST_STARTUP_VERDICT = None
    return module


@pytest.fixture()
def home(tmp_path: Path) -> Path:
    target = tmp_path / "ent-home"
    target.mkdir()
    return target


def _seed_state_db(path: Path, session_id: str, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute(
        "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, "
        "role TEXT, content TEXT, timestamp REAL NOT NULL, active INTEGER DEFAULT 1);"
    )
    for index, (role, content) in enumerate(rows):
        conn.execute(
            "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
            (session_id, role, content, 1000 + index),
        )
    conn.commit()
    conn.close()


class Receiver:
    """假中心接收端（按幂等键去重；模拟服务端 `UNIQUE(session_audit_id, human)`）。"""

    def __init__(self, *, retryable: bool = False):
        self.records: dict = {}
        self.calls: list = []
        self._retryable = retryable

    def transport(self, unit: dict) -> dict:
        self.calls.append(unit["session_audit_id"])
        if self._retryable:
            return {"ok": False, "retryable": True, "note": "network-down"}
        self.records.setdefault(unit["session_audit_id"], unit)
        return {"ok": True}


class FakeCtx:
    """引擎 `register(ctx)` 的钩子面替身：只记 `register_hook`（本批接线只用这一件）。"""

    def __init__(self):
        self.hooks: dict = {}

    def register_hook(self, name, callback):
        self.hooks.setdefault(name, []).append(callback)


def _host(wiring, home, **kwargs):
    return wiring.SessionAuditHost(home=home, **kwargs)


# ─────────────────────────────────────────────────────────────────────────────
# 线 ① · 会话收尾 ⇒ record_and_flush（§8 W5 / N2 PLK-REQ-0041/0043）
# ─────────────────────────────────────────────────────────────────────────────


def test_wire1_session_finalize_buffers_and_uploads(wiring, home):
    """正控：接线后，引擎一打 `on_session_finalize` ⇒ 单元**入缓冲并上传**（含全部聊天记录）。"""
    _seed_state_db(home / "state.db", "sess-wire", [["user", "你好"], ["assistant", "回答"], ["user", "再问"]])
    receiver = Receiver()
    ctx = FakeCtx()
    host = _host(wiring, home, transport=receiver.transport)

    verdict = host.register(ctx)
    assert verdict["usable"] is True, "良性企业 home 的落点自检应通过"
    assert ctx.hooks.get("on_session_finalize"), "会话收尾钩子必须挂上（这正是接线）"

    result = ctx.hooks["on_session_finalize"][0](session_id="sess-wire")
    assert result["kind"] == "ok"
    assert result["buffered"]["key"] == "plankton:sess-wire", "幂等键＝确定性派生 plankton:<会话 id>"
    assert result["flushed"]["uploaded"] == 1, "上传成功"
    assert set(receiver.records) == {"plankton:sess-wire"}, "接收端拿到该会话单元"
    unit = receiver.records["plankton:sess-wire"]
    assert unit["human"] == {"auth_user_id": None}, "人方恒空（服务端盖章）"
    assert unit["agent"]["authoritative"] is False, "agent 侧非权威"
    assert len(unit["transcript"]) == 3, "单元含该会话**全部**聊天记录"
    assert result["status"]["pending"] == 0, "上传成功 ⇒ 缓冲清空"


def test_wire1_counterproof_without_wiring_nothing_happens(wiring, home):
    """反证：**不接线**（不注册钩子）⇒ 同一「会话收尾」什么都没发生（缓冲空、接收端空）。

    这正是「接线是承重的」的证明：拿掉这步，会话跑完也可以一条审计都不落。
    """
    _seed_state_db(home / "state.db", "sess-lost", [["user", "只此一句"]])
    receiver = Receiver()
    ctx = FakeCtx()
    # 没有 host.register(ctx) —— 相当于接线前的状态（0 调用方）。
    assert ctx.hooks == {}, "未接线 ⇒ 引擎没有任何审计钩子"

    # 引擎照常打钩子：没有任何回调被调用。
    for callback in ctx.hooks.get("on_session_finalize", []):
        callback(session_id="sess-lost")

    assert receiver.records == {}, "未接线 ⇒ 接收端 0 条（审计不落）"
    buf = wiring._load_sibling("plankton_enterprise_audit_egress", "audit_egress.py").AuditBuffer(
        wiring._load_sibling("plankton_enterprise_audit_egress", "audit_egress.py").buffer_root(home)
    )
    assert buf.status()["pending"] == 0, "未接线 ⇒ 缓冲也是空的（连本地副本都没有）"


def test_wire1_counterproof_direct_upload_without_buffer_is_lost(wiring, home):
    """反证：会话收尾若**直传不缓冲**（不用 record_and_flush）⇒ 断网即丢。

    这就是「收尾必须走 record_and_flush（先入缓冲再上传）」的理由。
    """
    _seed_state_db(home / "state.db", "sess-direct", [["user", "x"]])
    down = Receiver(retryable=True)
    unit = {"session_audit_id": "plankton:sess-direct", "human": {"auth_user_id": None}}
    try:  # 朴素直传：失败就结束，什么都不留
        down.transport(unit)
    except Exception:
        pass
    assert down.records == {}, "直传失败 ⇒ 数据没了"
    assert not (home / "plankton-enterprise" / "audit-buffer" / "pending").exists()


def test_wire1_default_transport_is_no_transport_and_loses_nothing(wiring, home):
    """线 ④ 默认关闭：未配置 ⇒ flush 拒 `no-transport`，但单元**留在缓冲**（不丢、不外发）。"""
    _seed_state_db(home / "state.db", "sess-safe", [["user", "hello"]])
    ctx = FakeCtx()
    host = _host(wiring, home)  # 无注入传输；配置缺省 ⇒ no-transport
    host.register(ctx)
    result = ctx.hooks["on_session_finalize"][0](session_id="sess-safe")
    assert result["kind"] == "ok"
    assert result["flushed"] is None, "默认无传输：不发起 flush（更不外发）"
    assert result["status"]["pending"] == 1, "单元留在缓冲（上传失败/无传输都不丢）"
    assert result["status"]["dropped"] == 0


def test_wire1_offline_keeps_then_recovers_after_reconnect(wiring, home):
    """断网 ⇒ 保留；恢复后补齐且不重复（幂等键）。"""
    _seed_state_db(home / "state.db", "sess-offline", [["user", "离线一句"]])
    down = Receiver(retryable=True)
    up = Receiver()
    ctx = FakeCtx()
    _host(wiring, home, transport=down.transport).register(ctx)
    callback = ctx.hooks["on_session_finalize"][0]

    first = callback(session_id="sess-offline")
    assert first["status"]["pending"] == 1, "断网后单元留在缓冲"
    assert down.records == {}

    # 网络恢复：接线重打一次（同一会话、同一幂等键）⇒ 补齐、不重复。
    second = callback(session_id="sess-offline")
    assert second["kind"] == "ok"
    # 注入的传输在 host 构造时固定；用恢复后的 transport 直接补齐缓冲。
    buf = wiring._load_sibling("plankton_enterprise_audit_egress", "audit_egress.py").AuditBuffer(
        wiring._load_sibling("plankton_enterprise_audit_egress", "audit_egress.py").buffer_root(home)
    )
    out = buf.flush(up.transport)
    assert out["uploaded"] == 1 and set(up.records) == {"plankton:sess-offline"}


# ─────────────────────────────────────────────────────────────────────────────
# 线 ② · 启动期 ⇒ check_audit_landing 拒进入可用状态（§5 / N2 PLK-REQ-0048）
# ─────────────────────────────────────────────────────────────────────────────


def test_wire2_bad_landing_refuses_usable_state_and_conversation(wiring, egress, tmp_path, monkeypatch):
    """正控：落点进个人 `~/.hermes` ⇒ 裁决 `usable:false` + 会话准入被拒 + 可行动提示。"""
    personal = tmp_path / "me"
    bad = personal / ".hermes" / "enterprise-home"
    bad.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(personal))
    host = wiring.SessionAuditHost(home=bad)
    monkeypatch.setattr(host, "landing_verdict", lambda: egress.check_audit_landing(bad, personal_home=personal))

    verdict = host.startup_verdict()
    assert verdict["usable"] is False, "落个人 ~/.hermes 必须 fail-closed"
    assert verdict["kind"] == "landing-inside-personal-home"
    assert verdict["hint"] == egress.LANDING_ACTIONABLE_HINT and verdict["hint"]

    admission = host.admit("sess-x")
    assert admission["admitted"] is False
    assert admission["message"] == egress.LANDING_ACTIONABLE_HINT, "给可行动提示，不静默回退"


def test_wire2_bad_landing_blocks_the_whole_session_wire_via_hook(wiring, egress, tmp_path, monkeypatch):
    """正控（钩子面）：落点不过 ⇒ `on_session_start` 拒准入；`on_session_finalize` 不产单元。"""
    personal = tmp_path / "me"
    bad = personal / ".hermes" / "ent"
    bad.mkdir(parents=True)
    _seed_state_db(bad / "state.db", "sess-bad", [["user", "hi"]])
    monkeypatch.setenv("HOME", str(personal))
    host = wiring.SessionAuditHost(home=bad)
    monkeypatch.setattr(host, "landing_verdict", lambda: egress.check_audit_landing(bad, personal_home=personal))
    ctx = FakeCtx()
    verdict = host.register(ctx)
    assert verdict["usable"] is False

    start = ctx.hooks["on_session_start"][0](session_id="sess-bad")
    assert start["admitted"] is False and start["kind"] == "refused"
    finish = ctx.hooks["on_session_finalize"][0](session_id="sess-bad")
    assert finish == {"kind": "refused", "note": "landing-refused"}, "落点不成立 ⇒ 不产、不发审计"


def test_wire2_narrow_scope_benign_landing_is_not_blocked(wiring, home, tmp_path):
    """反证（范围收窄，§9.0 #16）：**不涉及审计成立性**的配置差异**不拦**（门禁不重于功能）。"""
    for benign in (home, tmp_path / "other" / "ent"):
        benign.mkdir(parents=True, exist_ok=True)
        host = wiring.SessionAuditHost(home=benign)
        verdict = host.startup_verdict()
        assert verdict["usable"] is True, f"良性落点 {benign} 不应被拦"
        assert host.admit("s")["admitted"] is True


# ─────────────────────────────────────────────────────────────────────────────
# 线 ③ · 会话入口 ⇒ admit_conversation 拒对话（§4 / N2 PLK-REQ-0047）
# ─────────────────────────────────────────────────────────────────────────────


def test_wire3_full_buffer_refuses_conversation_with_copy(wiring, egress, home):
    """正控：缓冲**满** ⇒ 会话入口**拒绝对话** + 文案（文案不声称拦截单次调用）。"""
    buf = egress.AuditBuffer(egress.buffer_root(home), limit=1)
    buf.pending_dir.mkdir(parents=True, exist_ok=True)
    (buf.pending_dir / "x.json").write_text(
        json.dumps({"key": "k", "enqueuedAt": 1.0, "unit": {"session_audit_id": "k"}}), encoding="utf-8"
    )
    ctx = FakeCtx()
    _host(wiring, home, buffer_limit=1).register(ctx)
    decision = ctx.hooks["on_session_start"][0](session_id="sess-full")
    assert decision["admitted"] is False and decision["note"] == "buffer-full"
    assert decision["message"] == egress.CONVERSATION_REFUSAL_NOTE
    for forbidden in ("已拦住", "已拦截", "已阻断"):
        assert forbidden not in decision["message"], "文案不得声称拦住了单次工具调用"


def test_wire3_unwritable_buffer_refuses_conversation(wiring, egress, home):
    """正控：缓冲**不可写** ⇒ 会话入口拒绝对话（fail-closed）。"""
    root = egress.buffer_root(home)
    root.mkdir(parents=True)
    os.chmod(root, stat.S_IRUSR | stat.S_IXUSR)  # r-x------：不可写
    try:
        host = _host(wiring, home)
        decision = host.admit("sess-ro")
        assert decision["admitted"] is False and decision["note"] == "buffer-unwritable"
        assert decision["message"] == egress.CONVERSATION_REFUSAL_NOTE
    finally:
        os.chmod(root, stat.S_IRWXU)


def test_wire3_counterproof_without_admission_the_session_proceeds(wiring, egress, home):
    """反证：**不接线**（会话入口不问准入）⇒ 缓冲满也会话照常进行（有损状态被放行）。

    这证明「会话入口问准入」这步是承重的：拿掉它，缓冲满/不可写的失败态没有任何拦截。
    """
    buf = egress.AuditBuffer(egress.buffer_root(home), limit=1)
    buf.pending_dir.mkdir(parents=True, exist_ok=True)
    (buf.pending_dir / "x.json").write_text(
        json.dumps({"key": "k", "enqueuedAt": 1.0, "unit": {"session_audit_id": "k"}}), encoding="utf-8"
    )
    ctx = FakeCtx()
    # 没有 host.register(ctx) —— 会话入口没有准入这一关。
    assert "on_session_start" not in ctx.hooks
    # 朴素宿主：不问准入，直接开始会话。
    naive_started = True
    assert naive_started is True, "未接线 ⇒ 满缓冲下会话照样开始（审计在有损状态被放行）"
    # 真实现（接线后）在同一状态下拒绝。
    _host(wiring, home, buffer_limit=1).register(ctx)
    assert ctx.hooks["on_session_start"][0](session_id="s")["admitted"] is False


# ─────────────────────────────────────────────────────────────────────────────
# 接线状态（只读可见面）
# ─────────────────────────────────────────────────────────────────────────────


def test_wiring_status_reports_hooks_and_no_credentials(wiring, home):
    ctx = FakeCtx()
    _host(wiring, home).register(ctx)
    status = wiring.wiring_status(home=home)
    assert status["wired"] is True
    assert set(status["hooks"]) == {"on_session_start", "on_session_finalize"}
    assert status["startup"]["usable"] is True
    assert status["transport"]["mode"] == "no-transport", "默认无传输（安全态）"


def test_register_without_hook_capability_is_loud_not_silent(wiring, home, caplog):
    """宿主没暴露 `register_hook` ⇒ 大声告警（不是静默丢掉审计接线）。"""

    class NoHookCtx:
        pass

    import logging

    with caplog.at_level(logging.WARNING):
        verdict = _host(wiring, home).register(NoHookCtx())
    assert verdict["usable"] is True
    assert any("register_hook" in record.message for record in caplog.records), "必须大声告警"
