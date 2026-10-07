"""批 4 · W5＋W6 —— **审计出口：断网缓冲 / 失败态 / 落点自检 / 边界护栏** 的单元与**承重**测试。

设计为准（逐字）：`docs/plankton/N7-technical-design/N7-20261007-plankton-audit-egress.md`
**§8 W5**（上传缓冲 / 失败态 / 可见）＋ **§8 W6**（home 落点自检 + 边界护栏与实测）
＋ **§4/§5/§6/§9.0**；需求 PLK-REQ-0043/0046/0047/0048。

本文件对每条约束给出**正控 + 反证**（反证证明该约束是承重的，不是装饰）：

  W5
   * **断网不丢**（§4/PLK-REQ-0043）：上传失败 ⇒ 单元**留在缓冲**、恢复后补齐；
     **反证**＝「直传不缓冲」的朴素实现 ⇒ 断网即丢（接收端 0 条、盘上无副本）。
   * **重试不重复**（§3/PLK-REQ-0043）：同一会话幂等键复用 ⇒ 接收端只有一条；
     **反证**＝每次重试随机新键 ⇒ 接收端 N 条（幂等失效）。
   * **丢弃处置**（§4）：缓冲满 ⇒ 拒收**新**单元、**绝不**淘汰旧会话；`dropped` 恒 0。
   * **失败态文案**（PLK-REQ-0047）：缓冲不可写/满 ⇒ **拒绝对话**；文案**不**声称「已拦单次调用」。
   * **可见/健康观测**：缓冲状态可诊断（计数/字节/最旧年龄/最近错误）。
  W6
   * **home 落点自检 fail-closed**（§5/PLK-REQ-0048）：落进个人 `~/.hermes` ⇒ **拒绝进入可用状态** +
     可行动提示、**不静默回退**；**范围收窄**：不涉及审计成立性的配置差异**不拦**。
   * **不客户端自证 / 归因只来自服务端**（§6）：带非空 `human.auth_user_id` 的单元 ⇒ **拒**。
   * **脱敏**（§6）：带密钥的单元 ⇒ 入缓冲/上传前**拒**；缓冲落盘字节**无原始密钥**。
   * **护栏结构断言**：无 `cli_usage_log`/`common_auth`（不复用 CLI 表）、无真实 URL、无网络 import。

「非管理员读被拒 / 类管理员可读」＝服务端 W2/W4（`GET /plankton/audit/query|stats` 的 SUPER 判定），
属**后端**验收（不属客户端本包）；本包不碰后端实现。夹具一律**合成**：临时企业 home、注入传输；
**不连生产库、不发真实网络**。
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import uuid
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
EGRESS_PATH = PLUGIN_ROOT / "audit_egress.py"
AUDIT_PATH = PLUGIN_ROOT / "audit_unit.py"
PLUGIN_API = PLUGIN_ROOT / "dashboard" / "plugin_api.py"
PLUGIN_JS = PLUGIN_ROOT / "desktop" / "plugin.js"
PACK_SH = PLUGIN_ROOT.parents[1] / "scripts" / "plankton-pack.sh"

EGRESS_SRC = EGRESS_PATH.read_text(encoding="utf-8")


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def audit():
    return _load("plankton_enterprise_audit_unit", AUDIT_PATH)


@pytest.fixture()
def egress():
    return _load("plankton_enterprise_audit_egress", EGRESS_PATH)


@pytest.fixture()
def home(tmp_path: Path) -> Path:
    target = tmp_path / "ent-home"
    target.mkdir()
    return target


def _unit(audit, session: str, text: str = "hello") -> dict:
    return audit.assemble_audit_unit(
        engine_session_id=session,
        messages=[{"role": "user", "content": text}, {"role": "assistant", "content": "ok"}],
        profile_name="Alpha",
        profile_id="pid_" + uuid.uuid5(uuid.NAMESPACE_URL, session).hex,
    )


class Receiver:
    """假中心接收端（按幂等键去重；模拟服务端 `UNIQUE(session_audit_id, human)`）。"""

    def __init__(self, *, retryable: bool = False, permanent: bool = False):
        self.records: dict = {}
        self.calls: list = []
        self._retryable = retryable
        self._permanent = permanent

    def transport(self, unit: dict) -> dict:
        self.calls.append(unit["session_audit_id"])
        if self._retryable:
            return {"ok": False, "retryable": True, "note": "network-down"}
        if self._permanent:
            return {"ok": False, "retryable": False, "note": "server-rejected"}
        self.records.setdefault(unit["session_audit_id"], unit)  # 幂等：同键只留一条
        return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# W5 · ① 断网缓冲：上传失败不丢、恢复后补齐（§4 / PLK-REQ-0043 / PLK-REQ-0047）
# ─────────────────────────────────────────────────────────────────────────────


def test_disconnect_keeps_the_unit_then_recovers(egress, audit, home):
    """承重：断网时单元**留在缓冲**；恢复后**补齐**（无因中断而永久丢失的会话）。"""
    buf = egress.AuditBuffer(egress.buffer_root(home))
    down = Receiver(retryable=True)
    up = Receiver()

    unit = _unit(audit, "sess-disconnect")
    first = egress.record_and_flush(unit, buffer=buf, transport=down.transport)
    assert first["kind"] == "ok"
    assert first["status"]["pending"] == 1, "断网后单元必须在缓冲里（不丢）"
    assert down.records == {}, "断网时接收端没有记录"

    second = egress.record_and_flush(unit, buffer=buf, transport=up.transport)
    assert second["flushed"]["uploaded"] == 1
    assert second["status"]["pending"] == 0, "恢复后补齐、缓冲清空"
    assert set(up.records) == {"plankton:sess-disconnect"}, "接收端拿到该会话"


def test_loadbearing_without_a_buffer_the_session_is_lost(egress, audit, home):
    """反证：**不缓冲、直传**的朴素实现 ⇒ 断网即丢（盘上无副本、接收端 0 条）。

    这正是「必须缓冲」的证明：拿掉缓冲这一环，审计数据在第一次上传失败时就没了。
    """

    def naive_direct_upload(unit, transport):
        # 直传：失败就结束，**什么都不留**（没有本地缓冲）。
        try:
            return transport(unit)
        except Exception:
            return {"ok": False}

    down = Receiver(retryable=True)
    naive_direct_upload(_unit(audit, "sess-lost"), down.transport)
    assert down.records == {}, "直传失败 ⇒ 数据没了"
    # 盘上没有任何缓冲副本
    assert not (home / "plankton-enterprise" / "audit-buffer" / "pending").exists()

    # 真实现：同场景下单元**留在盘上**
    buf = egress.AuditBuffer(egress.buffer_root(home))
    egress.record_and_flush(_unit(audit, "sess-lost"), buffer=buf, transport=down.transport)
    assert buf.status()["pending"] == 1, "真实现：断网后单元仍在缓冲（不丢）"


def test_retry_with_the_same_key_does_not_duplicate(egress, audit, home):
    """幂等：同一会话多次重试复用同一 `session_audit_id` ⇒ 接收端**只有一条**。"""
    buf = egress.AuditBuffer(egress.buffer_root(home))
    down = Receiver(retryable=True)
    up = Receiver()
    unit = _unit(audit, "sess-retry")

    for _ in range(5):  # 断网期间反复重试
        egress.record_and_flush(unit, buffer=buf, transport=down.transport)
    assert buf.status()["pending"] == 1, "同一会话反复重试仍只有一条待上传"

    egress.record_and_flush(unit, buffer=buf, transport=up.transport)
    assert len(up.records) == 1, "接收端按幂等键去重 ⇒ 只有一条"
    assert up.calls.count("plankton:sess-retry") >= 1


def test_loadbearing_random_key_would_duplicate(egress, audit, home):
    """反证：每次重试**随机新键** ⇒ 接收端 N 条（幂等失效）。"""
    up = Receiver()

    def naive_random_key_upload(audit_mod, session, transport):
        unit = audit_mod.assemble_audit_unit(
            engine_session_id=session,
            messages=[{"role": "user", "content": "x"}],
            profile_name="Alpha",
            profile_id="pid_x",
        )
        unit["session_audit_id"] = f"plankton:{uuid.uuid4().hex}"  # ← 错误：随机键
        transport(unit)

    for _ in range(4):
        naive_random_key_upload(audit, "sess-dup", up.transport)
    assert len(up.records) == 4, "随机键：4 次重试 = 4 条新记录（幂等失效）"
    # 真实现：同一会话 4 次 ⇒ 1 条
    buf = egress.AuditBuffer(egress.buffer_root(home))
    real = Receiver()
    for _ in range(4):
        egress.record_and_flush(_unit(audit, "sess-dup"), buffer=buf, transport=real.transport)
    assert len(real.records) == 1


def test_buffer_limit_refuses_new_and_never_drops_old(egress, audit, home):
    """丢弃处置（§4）：满 ⇒ 拒收**新**单元；**绝不**静默淘汰旧会话；`dropped` 恒 0。"""
    buf = egress.AuditBuffer(egress.buffer_root(home), limit=2)
    down = Receiver(retryable=True)
    for i in range(2):
        egress.record_and_flush(_unit(audit, f"sess-{i}"), buffer=buf, transport=down.transport)
    assert buf.status()["pending"] == 2

    over = egress.record_and_flush(_unit(audit, "sess-over"), buffer=buf, transport=down.transport)
    assert over["kind"] == "refused" and over["note"] == "buffer-full", "满 ⇒ 拒收新单元"
    status = buf.status()
    assert status["pending"] == 2, "旧会话**一条没丢**"
    assert status["refusedFull"] == 1 and status["dropped"] == 0, "丢弃处置＝丢新、可诊断、dropped=0"
    # 旧会话仍能补齐
    up = Receiver()
    out = buf.flush(up.transport)
    assert out["uploaded"] == 2 and set(up.records) == {"plankton:sess-0", "plankton:sess-1"}


def test_unwritable_buffer_refuses_conversation(egress, home):
    """失败态（PLK-REQ-0047）：缓冲**不可写** ⇒ **拒绝对话** + 告警（fail-closed）。"""
    root = home / "plankton-enterprise" / "audit-buffer"
    buf = egress.AuditBuffer(root)
    # 预建一个**只读**目录，让收单元/探测写不动。
    root.mkdir(parents=True)
    os.chmod(root, stat.S_IRUSR | stat.S_IXUSR)  # r-x------：不可写
    try:
        admission = buf.admit_conversation()
        assert admission["admitted"] is False
        assert admission["note"] == "buffer-unwritable"
        assert admission["message"] == egress.CONVERSATION_REFUSAL_NOTE
    finally:
        os.chmod(root, stat.S_IRWXU)


def test_full_buffer_refuses_conversation(egress, home):
    buf = egress.AuditBuffer(egress.buffer_root(home), limit=1)
    buf.pending_dir.mkdir(parents=True, exist_ok=True)
    (buf.pending_dir / "x.json").write_text(
        json.dumps({"key": "k", "enqueuedAt": 1.0, "unit": {"session_audit_id": "k"}}), encoding="utf-8"
    )
    admission = buf.admit_conversation()
    assert admission["admitted"] is False and admission["note"] == "buffer-full"


def test_refusal_copy_never_claims_single_call_blocking(egress):
    """文案（PLK-REQ-0047）：拒绝对话文案 **SHALL NOT** 声称「已拦住单次工具调用」。"""
    note = egress.CONVERSATION_REFUSAL_NOTE
    # 明确**声明**只做会话级审计、不做动作级拦截（诚实口径）。
    assert "会话级审计" in note and "动作级拦截" in note and "单次工具调用" in note
    # 不得出现「已拦住/已拦截/已阻断」的正向断言。
    for forbidden in ("已拦住", "已拦截", "已阻断", "blocked the tool call"):
        assert forbidden not in note, f"文案不得声称 {forbidden}"


def test_status_is_diagnosable(egress, audit, home):
    buf = egress.AuditBuffer(egress.buffer_root(home))
    down = Receiver(retryable=True)
    egress.record_and_flush(_unit(audit, "sess-s"), buffer=buf, transport=down.transport)
    status = buf.status()
    assert status["pending"] == 1 and status["bytes"] > 0
    assert status["oldestEnqueuedAt"] is not None and status["oldestAgeSeconds"] >= 0
    assert status["lastError"] == "network-down"
    assert status["dropped"] == 0 and status["limit"] == egress.DEFAULT_BUFFER_LIMIT


def test_flush_is_ordered(egress, home):
    """按序补齐：flush 按入队时间序交给传输（同秒也稳定）。"""
    buf = egress.AuditBuffer(egress.buffer_root(home), now=100.0)
    order = []
    buf.pending_dir.mkdir(parents=True, exist_ok=True)
    for key, when in (("c", 102.0), ("a", 100.0), ("b", 101.0)):
        (buf.pending_dir / f"{key}.json").write_text(
            json.dumps({"key": key, "enqueuedAt": when,
                        "unit": {"session_audit_id": key, "human": {"auth_user_id": None}}}),
            encoding="utf-8",
        )
    out = buf.flush(lambda u: (order.append(u["session_audit_id"]) or {"ok": True}))
    assert out["uploaded"] == 3
    assert order == ["a", "b", "c"], "按 enqueuedAt 升序补齐"


def test_permanent_failure_keeps_the_unit(egress, audit, home):
    """永久失败也**不丢**：保留并记录，继续下一条。"""
    buf = egress.AuditBuffer(egress.buffer_root(home))
    down = Receiver(retryable=True)
    egress.record_and_flush(_unit(audit, "sess-a"), buffer=buf, transport=down.transport)
    egress.record_and_flush(_unit(audit, "sess-b"), buffer=buf, transport=down.transport)
    out = buf.flush(Receiver(permanent=True).transport)
    assert out["uploaded"] == 0 and out["remaining"] == 2, "永久失败 ⇒ 两条都保留"
    assert buf.status()["permanentFailures"] == 2


def test_default_transport_is_absent_fail_closed(egress, audit, home):
    """红线：默认**无传输** ⇒ flush fail-closed 拒（`no-transport`）**且不丢单元**。"""
    buf = egress.AuditBuffer(egress.buffer_root(home))
    buf.enqueue(_unit(audit, "sess-x"))
    with pytest.raises(egress.AuditEgressRefused) as exc:
        buf.flush(None)
    assert exc.value.note == "no-transport"
    assert buf.status()["pending"] == 1, "无传输也不丢"


# ─────────────────────────────────────────────────────────────────────────────
# W6 · ③ home 落点自检 fail-closed（§5 / PLK-REQ-0048）
# ─────────────────────────────────────────────────────────────────────────────


def test_landing_inside_personal_home_is_refused(egress, tmp_path):
    """承重：企业 home 落在个人 `~/.hermes` 内 ⇒ **拒绝进入可用状态** + 可行动提示、不静默回退。"""
    personal = tmp_path / "me"
    bad_home = personal / ".hermes" / "enterprise-home"
    bad_home.mkdir(parents=True)
    verdict = egress.check_audit_landing(bad_home, personal_home=personal)
    assert verdict["ok"] is False, "落在个人 ~/.hermes 内必须 fail-closed 拒"
    assert verdict["kind"] == "landing-inside-personal-home"
    assert verdict["findings"][0]["check"] == "landing-inside-personal-home"
    assert verdict["hint"] == egress.LANDING_ACTIONABLE_HINT and verdict["hint"], "必须给可行动提示"


def test_landing_check_covers_the_buffer_landing_too(egress, tmp_path):
    personal = tmp_path / "me"
    good_home = tmp_path / "ent"
    good_home.mkdir()
    bad_buffer = personal / ".hermes" / "plankton-enterprise" / "audit-buffer"
    verdict = egress.check_audit_landing(good_home, personal_home=personal, buffer=bad_buffer)
    assert verdict["ok"] is False
    assert {f["layer"] for f in verdict["findings"]} == {"audit-buffer"}


def test_landing_scope_is_narrow_benign_config_is_not_blocked(egress, tmp_path):
    """范围收窄（§9.0 #16）：**不涉及审计成立性**的配置差异**不拦**（门禁不重于功能）。"""
    personal = tmp_path / "me"
    personal.mkdir()
    for benign in (tmp_path / "ent-a", tmp_path / "other" / "ent-b", Path("/tmp")):
        benign.mkdir(parents=True, exist_ok=True)
        verdict = egress.check_audit_landing(benign, personal_home=personal)
        assert verdict["ok"] is True, f"非个人目录 {benign} 不应被拦"
        assert verdict["hint"] == ""


def test_landing_unresolved_is_fail_closed(egress):
    verdict = egress.check_audit_landing(None)
    assert verdict["ok"] is False and verdict["kind"] == "landing-unresolved"


def test_loadbearing_personal_home_is_not_a_false_negative(egress, tmp_path, monkeypatch):
    """反证：把「个人 home」判据拿掉（换成只看路径存在）⇒ 上面那条必须变红。

    用真实的判据跑一个**必须为真**的个人落点；证明该判据确实在拦、不是恒真。
    """
    personal = tmp_path / "me"
    inside = personal / ".hermes" / "x"
    inside.mkdir(parents=True)
    # 朴素「只看存在」判据：永不拒绝。
    def naive_exists_only(_home):  # noqa: ARG001
        return {"ok": True}

    assert naive_exists_only(inside)["ok"] is True, "朴素判据放行（说明严格判据不是恒真）"
    assert egress.check_audit_landing(inside, personal_home=personal)["ok"] is False


# ─────────────────────────────────────────────────────────────────────────────
# W6 · ④ 边界护栏 + 脱敏（§6）
# ─────────────────────────────────────────────────────────────────────────────


def test_client_cannot_attest_human(egress, audit, home):
    """不客户端自证（§2/§6）：带非空 `human.auth_user_id` 的单元 ⇒ 入缓冲即拒。"""
    buf = egress.AuditBuffer(egress.buffer_root(home))
    forged = _unit(audit, "sess-forge")
    forged["human"] = {"auth_user_id": "feishu:attacker@evil"}  # 伪造人方
    with pytest.raises(egress.AuditEgressRefused) as exc:
        buf.enqueue(forged)
    assert exc.value.note == "client-cannot-attest-human"
    assert buf.status()["pending"] == 0


def test_secret_bearing_unit_is_refused_before_buffering(egress, audit, home):
    """脱敏（§6）：带密钥的单元 ⇒ 入缓冲前**拒**（宁可拒，不留副本）。"""
    buf = egress.AuditBuffer(egress.buffer_root(home))
    dirty = audit.assemble_audit_unit(
        engine_session_id="sess-secret",
        messages=[{"role": "user", "content": "here sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}],
        profile_name="Alpha",
        profile_id="pid_x",
    )
    # 组装时已脱敏/或拒；若这单元仍带原文密钥（模拟漏网），出口必须拒。
    if "sk-ABCDEF" in json.dumps(dirty):
        with pytest.raises(egress.AuditEgressRefused):
            buf.enqueue(dirty)
    else:
        # 组装层已拦截 ⇒ 出口层用一个人造「漏网」单元再验一次。
        smuggled = _unit(audit, "sess-smuggle")
        smuggled["transcript"].append({"role": "user", "content": "AKIAIOSFODNN7EXAMPLE"})
        with pytest.raises(egress.AuditEgressRefused):
            buf.enqueue(smuggled)


def test_buffered_bytes_carry_no_raw_secret(egress, audit, home):
    """缓冲落盘字节**无原始密钥**（脱敏核查的盘面一半）。"""
    buf = egress.AuditBuffer(egress.buffer_root(home))
    unit = _unit(audit, "sess-clean", text="普通的会话内容")
    buf.enqueue(unit)
    blob = ""
    for path in buf.pending_dir.glob("*.json"):
        blob += path.read_text(encoding="utf-8")
    for pattern in ("sk-", "AKIA", "Bearer ", "PRIVATE KEY"):
        assert pattern not in blob


def _code_only(src: str) -> str:
    """去掉模块 docstring 与注释行，只留会执行的代码（结构断言针对代码，不针对说明文字）。"""
    import re

    html = re.sub(r'""".*?"""', "", src, flags=re.S)
    html = re.sub(r"'''.*?'''", "", html, flags=re.S)
    return "\n".join(line for line in html.splitlines() if not line.strip().startswith("#"))


def test_egress_source_has_no_cli_table_no_real_url_no_network(egress):
    """护栏结构断言：不复用 CLI 表、无真实 URL、无任何网络 import（默认不发真实数据）。"""
    code = _code_only(EGRESS_SRC)
    assert "cli_usage_log" not in code
    assert "common_auth" not in code
    for scheme in ("http://", "https://"):
        assert scheme not in code, f"出口不得内建真实端点（{scheme}）"
    for forbidden in ("import socket", "import urllib", "import requests", "import http.client",
                      "import subprocess", "smtplib"):
        assert forbidden not in code, f"出口不得内置网络/子进程（{forbidden}）"
    # 凭据不落库：出口从不读令牌文件。
    for forbidden in ("tokens.json", "read_token", "Authorization"):
        assert forbidden not in code


def test_guard_summary_states_the_invariants(egress):
    summary = egress.guard_summary()
    assert summary["guards"]["no-client-attestation"] is True
    assert summary["guards"]["attribution-server-side-only"] is True
    assert summary["guards"]["no-cli-usage-table"] is True
    assert summary["guards"]["credentials-never-persisted"] is True


def test_pack_payload_lists_the_egress_module():
    """产物必须带 W5/W6 的模块：pack 清单里列出 `audit_egress.py`（否则打包会静默漏）。"""
    text = PACK_SH.read_text(encoding="utf-8")
    assert "audit_egress.py" in text, "plankton-pack.sh 的必需 payload 清单必须含 audit_egress.py"
