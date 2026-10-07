"""批 4 · W1 —— **会话级审计单元组装** 的单元与承重测试。

设计为准（逐字）：`docs/plankton/N7-technical-design/N7-20261007-plankton-audit-egress.md`
**§8 W1**（会话级审计单元组装 + profile 稳定 ID 发号）＋ **§2**（上传字段 schema：客户端上送段 vs
服务端盖章段）＋ **§9.0** 不变量；需求 PLK-REQ-0041/0042/0043/0049。

本文件钉住（每条带一个**反证**，证明该约束是承重的，不是装饰）：
  * **幂等键确定性**（§3 / PLK-REQ-0043）：同会话任意次派生同值；**反证**＝随机 id 每次不同 ⇒
    重试变新记录（幂等失效）；
  * **人这一方＝服务端盖章**（§2 / PLK-REQ-0042）：上送段 `human.auth_user_id` **恒为空**，
    客户端不能自报/覆盖；**反证**＝「照抄输入 human」的实现 ⇒ 客户端能自报人；
  * **agent 这一方全 non-authoritative**（PLK-REQ-0049）：字段齐全且逐字段标注；
  * **不上传 profile 内容**（PLK-REQ-0049）：出现 `AGENT.md`/`systemPrompt` 一类键 ⇒ 拒；
  * **不落令牌/密钥/预签名 URL**（§2 脱敏）：扫字段名与值；**反证**＝原文确实含密钥（未清洗则命中）；
  * **profileId 稳定**（PLK-REQ-0049）：企业 home 首次纳管生成并持久化；同 profile（键＝稳定身份）
    改名仍同 ID；**反证**＝「按名字派生」的实现 ⇒ 改名后变新 id；
  * **纯逻辑 / 不上传**（§8 W1 / 红线）：本模块零网络、零 subprocess（源码级结构断言）。

夹具一律**合成**：临时企业 home、临时 sqlite、合成消息；不碰真实 home、不发网络。
"""

from __future__ import annotations

import importlib.util
import json
import re
import sqlite3
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
AUDIT_PATH = PLUGIN_ROOT / "audit_unit.py"
PLUGIN_API = PLUGIN_ROOT / "dashboard" / "plugin_api.py"
PLUGIN_JS = PLUGIN_ROOT / "desktop" / "plugin.js"

AUDIT_SRC = AUDIT_PATH.read_text(encoding="utf-8")


def _load_audit():
    spec = importlib.util.spec_from_file_location("plankton_enterprise_audit_unit", AUDIT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def audit():
    return _load_audit()


@pytest.fixture()
def home(tmp_path: Path) -> Path:
    target = tmp_path / "ent-home"
    target.mkdir()
    return target


def _sqlite_session(path: Path, session_id: str, rows) -> Path:
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, "
        "content TEXT, timestamp REAL NOT NULL, active INTEGER DEFAULT 1)"
    )
    for index, (role, content) in enumerate(rows):
        conn.execute(
            "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
            (session_id, role, content, 1000.0 + index),
        )
    conn.commit()
    conn.close()
    return path


# ─────────────────────────────────────────────────────────────────────────────
# ① 幂等键：确定性派生（§3 / PLK-REQ-0043）
# ─────────────────────────────────────────────────────────────────────────────


def test_session_audit_id_is_deterministic(audit):
    """同一会话的任意次重试/补齐派生出**同一**键（一会话一单元一键）。"""
    first = audit.derive_session_audit_id("sess-abc")
    assert first == "plankton:sess-abc"
    assert {audit.derive_session_audit_id("sess-abc") for _ in range(200)} == {first}


def test_session_audit_id_has_no_entropy_in_source(audit):
    """结构断言：派生函数体不含 uuid / random / time —— 幂等键不可能被随机化。"""
    body = AUDIT_SRC.split("def derive_session_audit_id", 1)[1].split("\ndef ", 1)[0]
    # 去掉 docstring 与注释行，只看会执行的代码。
    code = re.sub(r'""".*?"""', "", body, flags=re.S)
    code = "\n".join(line for line in code.splitlines() if not line.strip().startswith("#"))
    for forbidden in ("uuid", "random", "time.", "time()", "urandom"):
        assert forbidden not in code, f"幂等键派生不得含 {forbidden}"


def test_loadbearing_idempotency_random_key_is_a_new_record_every_time(audit):
    """承重反证：把确定性派生换成「每次随机」⇒ 同一会话的重试变成**不同**记录。

    这就是服务端 `UNIQUE(session_audit_id) + ON CONFLICT DO NOTHING` 会被绕过的方式：
    重试不再命中同一键。本测试把那条错误路径显式跑出来，证明「确定性」不是可有可无。
    """

    def naive_random_id(_session):  # 反例实现（只在本测试里）
        import uuid

        return f"plankton:{uuid.uuid4().hex}"

    retries = {naive_random_id("sess-abc") for _ in range(50)}
    assert len(retries) == 50, "随机键：50 次重试 = 50 条新记录（幂等失效）"
    # 而真实现：50 次重试 = 1 个键。
    assert len({audit.derive_session_audit_id("sess-abc") for _ in range(50)}) == 1


def test_session_audit_id_refuses_empty(audit):
    for bad in ("", "   ", None):
        with pytest.raises(audit.AuditUnitRefused):
            audit.derive_session_audit_id(bad)


# ─────────────────────────────────────────────────────────────────────────────
# ② 单元 = 会话级、全部聊天记录（按序、非摘要、非抽样）
# ─────────────────────────────────────────────────────────────────────────────


def test_unit_contains_all_chat_records_in_order(audit):
    messages = [
        {"role": "user", "content": "第一条"},
        {"role": "assistant", "content": "回答一"},
        {"role": "tool", "content": "内部工具载荷（不是一条聊天记录）"},
        {"role": "user", "content": "第二条"},
        {"role": "assistant", "content": "回答二"},
    ]
    unit = audit.assemble_audit_unit(engine_session_id="sess-1", messages=messages)
    assert unit["session_audit_id"] == "plankton:sess-1"
    assert [entry["role"] for entry in unit["transcript"]] == ["user", "assistant", "user", "assistant"]
    assert [entry["content"] for entry in unit["transcript"]] == ["第一条", "回答一", "第二条", "回答二"]


def test_transcript_is_not_summarized_or_sampled_even_when_long(audit):
    """非摘要、非抽样：条数与内容都原样保留（长正文不截断）。"""
    long_body = "X" * 200_000
    messages = [{"role": "user", "content": long_body}] + [
        {"role": "assistant", "content": f"r{i}"} for i in range(120)
    ]
    unit = audit.assemble_audit_unit(engine_session_id="s", messages=messages)
    assert len(unit["transcript"]) == len(messages)
    assert unit["transcript"][0]["content"] == long_body


def test_granularity_is_one_unit_per_session(audit):
    """粒度＝会话级：一会话一单元（不是每条消息/每次工具调用各产一条）。"""
    one = audit.assemble_audit_unit(engine_session_id="s", messages=[{"role": "user", "content": "a"}])
    two = audit.assemble_audit_unit(engine_session_id="s", messages=[{"role": "user", "content": "a"}])
    assert one["session_audit_id"] == two["session_audit_id"]
    assert set(one.keys()) == {"session_audit_id", "created_at", "human", "agent", "project", "client",
                               "appVersion", "transcript"}


# ─────────────────────────────────────────────────────────────────────────────
# ③ 两方字段：人（服务端盖章，上送恒空）／ agent（self-reported）
# ─────────────────────────────────────────────────────────────────────────────


def test_human_is_always_null_in_the_client_request_body(audit):
    unit = audit.assemble_audit_unit(engine_session_id="s", messages=[{"role": "user", "content": "hi"}])
    assert unit["human"] == {"auth_user_id": None}


def test_loadbearing_human_gate_a_naive_assembler_would_accept_a_self_report(audit):
    """承重反证：若组装「照抄输入里的人的字段」，客户端就能自报人（伪造归因）。

    本测试把那条错误路径跑出来：喂一个自报身份，naive 实现把它带进 `human`（非空），
    证明「上送段写死空值」这条闸是承重的。
    """

    def naive_assemble(client_body):  # 反例实现：把客户端来的 human 原样采纳
        return {"human": dict(client_body.get("human") or {})}

    forged = {"human": {"auth_user_id": "evil:attacker"}}
    assert naive_assemble(forged)["human"]["auth_user_id"] == "evil:attacker"  # 反证：攻击得逞
    # 真实现：无论怎样喂，人的字段都写死为空。
    unit = audit.assemble_audit_unit(engine_session_id="s", messages=[{"role": "user", "content": "hi"}])
    assert unit["human"]["auth_user_id"] is None


def test_human_cannot_be_injected_through_messages_or_labels(audit):
    """客户端把身份塞进消息的额外字段/标签 ⇒ 一律忽略（参数永不填充归因）。"""
    messages = [
        {"role": "user", "content": "hi", "human": {"auth_user_id": "evil:attacker"}},
        {"role": "assistant", "content": "ok", "auth_user_id": "evil:attacker"},
    ]
    unit = audit.assemble_audit_unit(
        engine_session_id="s", messages=messages, profile_name="Alpha", profile_id="pid_x"
    )
    assert unit["human"] == {"auth_user_id": None}
    assert "evil:attacker" not in json.dumps(unit, ensure_ascii=False)


def test_agent_side_is_fully_labelled_non_authoritative(audit):
    unit = audit.assemble_audit_unit(
        engine_session_id="s", messages=[{"role": "user", "content": "hi"}],
        profile_name="Alpha", profile_id="pid_123", variant="plankton", engine_version="1.2.3",
    )
    agent = unit["agent"]
    assert set(agent) == {"profileName", "profileId", "variant", "engineVersion", "authoritative", "note"}
    assert agent["authoritative"] is False
    assert agent["note"] == "self-reported"
    assert agent["profileName"] == "Alpha" and agent["profileId"] == "pid_123"


def test_profile_content_keys_are_refused(audit):
    """profile 内容不上传：单元里出现 profile 内容类键即拒（防御性；schema 本就无此字段）。"""
    for forbidden in ("agentMd", "systemPrompt", "profileContent"):
        problem = audit.audit_hygiene_problem({"session_audit_id": "x", "agent": {forbidden: "# AGENT.md ..."}})
        assert problem, f"键 {forbidden} 必须被卫生扫描拦下"


# ─────────────────────────────────────────────────────────────────────────────
# ④ 不落令牌/密钥/预签名 URL（扫字段名与值）
# ─────────────────────────────────────────────────────────────────────────────

_RAW_SK = "sk-abcdefghijklmnopqrstuvwx"
_RAW_AWS = "AKIAIOSFODNN7EXAMPLE"
_RAW_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dozjgNryP4J3jVmNHl0w5N"
_RAW_GH = "ghp_" + "a" * 36
_RAW_PRESIGNED = "https://bucket.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeefcafe1234"


def test_no_token_secret_or_presigned_url_survives_in_the_unit(audit):
    messages = [
        {"role": "user", "content": f"用这个 token {_RAW_SK} 和 {_RAW_AWS}"},
        {"role": "assistant", "content": f"下载 {_RAW_PRESIGNED} 再看 Authorization: Bearer {_RAW_JWT}"},
        {"role": "user", "content": f"github {_RAW_GH}"},
    ]
    unit = audit.assemble_audit_unit(engine_session_id="s", messages=messages)
    blob = json.dumps(unit, ensure_ascii=False)

    # 值层面：任何原始凭据都不得出现。
    for raw in (_RAW_SK, _RAW_AWS, _RAW_JWT, _RAW_GH, "deadbeefcafe1234"):
        assert raw not in blob, f"原始凭据泄漏进单元：{raw}"
    # 结构层面：整单元的字段名与值再过一遍密钥正则，必须零命中。
    assert audit.audit_hygiene_problem(unit) is None


def test_loadbearing_redaction_the_raw_message_really_carried_the_secret(audit):
    """承重反证：源消息**确实**含原始凭据（未清洗就会命中）——证明清洗不是空转。"""
    raw_messages = [{"role": "user", "content": f"token {_RAW_SK} sig X-Amz-Signature=deadbeefcafe1234"}]
    assert _RAW_SK in raw_messages[0]["content"]
    assert audit._secret_value_note(raw_messages[0]["content"], "content")  # 原始正文命中密钥正则
    unit = audit.assemble_audit_unit(engine_session_id="s", messages=raw_messages)
    assert audit.audit_hygiene_problem(unit) is None
    assert _RAW_SK not in json.dumps(unit)


def test_secret_named_fields_are_refused_by_the_hygiene_scan(audit):
    for key in ("accessToken", "api_key", "clientSecret", "presignedUrl", "authorization"):
        assert audit.audit_hygiene_problem({"agent": {key: "x"}}), f"{key} 必须被字段名扫描拦下"


# ─────────────────────────────────────────────────────────────────────────────
# ⑤ 应用发稳定 profileId（企业 home 首次纳管生成并持久化；跨改名稳定）
# ─────────────────────────────────────────────────────────────────────────────


def test_profile_id_is_generated_and_persisted_in_the_enterprise_home(audit, home):
    result = audit.resolve_profile_id("/profiles/alpha", profile_name="Alpha", home=home)
    assert result["kind"] == "ok" and result["firstTime"] is True
    assert result["profileId"].startswith("pid_")
    store = audit.profile_id_store_path(home)
    assert store.is_file()
    assert store == home / "plankton-enterprise" / "profile-ids.json"
    assert result["profileId"] in store.read_text(encoding="utf-8")


def test_profile_id_survives_a_profile_rename(audit, home):
    """同一 profile（键＝稳定身份）改名 —— 名字变、**ID 不变**。"""
    before = audit.resolve_profile_id("/profiles/alpha", profile_name="Alpha", home=home)
    after = audit.resolve_profile_id("/profiles/alpha", profile_name="Alpha (renamed)", home=home)
    assert after["profileId"] == before["profileId"]
    assert after["firstTime"] is False

    # 目录改名：把旧键当别名交给它 ⇒ 沿用同一 ID（对应引擎的 identity 迁移）。
    moved = audit.resolve_profile_id("/profiles/beta", profile_name="Beta", aliases=["/profiles/alpha"], home=home)
    assert moved["profileId"] == before["profileId"]


def test_profile_id_is_stable_across_processes(audit, home):
    first = audit.resolve_profile_id("/profiles/alpha", profile_name="Alpha", home=home)["profileId"]
    again = audit.resolve_profile_id("/profiles/alpha", profile_name="Alpha", home=home)["profileId"]
    assert first == again


def test_loadbearing_profile_id_name_derived_impl_would_change_on_rename(audit, home):
    """承重反证：若 `profileId` 由**名字**派生（无持久化），改名即变新 id。"""

    def naive_name_derived_id(profile_name):  # 反例实现
        import hashlib

        return "pid_" + hashlib.sha256(profile_name.encode("utf-8")).hexdigest()[:32]

    assert naive_name_derived_id("Alpha") != naive_name_derived_id("Alpha (renamed)")  # 反证：改名→新 id
    # 真实现：键是稳定身份，改名不改 id。
    assert (
        audit.resolve_profile_id("/profiles/alpha", profile_name="Alpha", home=home)["profileId"]
        == audit.resolve_profile_id("/profiles/alpha", profile_name="Renamed", home=home)["profileId"]
    )


def test_distinct_profiles_get_distinct_ids(audit, home):
    a = audit.resolve_profile_id("/profiles/a", profile_name="A", home=home)["profileId"]
    b = audit.resolve_profile_id("/profiles/b", profile_name="A", home=home)["profileId"]
    assert a != b, "重名的不同 profile 不得共用同一 ID"


def test_profile_id_store_never_leaves_the_enterprise_home(audit, home):
    audit.resolve_profile_id("/profiles/a", profile_name="A", home=home)
    written = {p for p in home.rglob("*") if p.is_file()}
    assert written, "台账必须落在企业 home 内"
    assert all(str(p).startswith(str(home)) for p in written)


# ─────────────────────────────────────────────────────────────────────────────
# ⑥ 会话素材读取点（state.db 只读）＋ 端到端生产者
# ─────────────────────────────────────────────────────────────────────────────


def test_read_session_chat_is_ordered_and_read_only(audit, tmp_path):
    db = _sqlite_session(tmp_path / "state.db", "sess-1", [
        ("user", "q1"), ("assistant", "a1"), ("tool", "payload"), ("user", "q2"), ("assistant", "a2"),
    ])
    before = db.stat().st_mtime_ns
    rows = audit.read_session_chat(db, "sess-1")
    assert [(r["role"], r["content"]) for r in rows] == [("user", "q1"), ("assistant", "a1"), ("user", "q2"), ("assistant", "a2")]
    assert db.stat().st_mtime_ns == before, "读取点必须只读（不写 state.db）"


def test_read_session_chat_refuses_unknown_session_and_missing_db(audit, tmp_path):
    db = _sqlite_session(tmp_path / "state.db", "sess-1", [("user", "q1")])
    with pytest.raises(audit.AuditUnitRefused) as exc:
        audit.read_session_chat(db, "does-not-exist")
    assert exc.value.note == "no-session"
    with pytest.raises(audit.AuditUnitRefused) as exc2:
        audit.read_session_chat(tmp_path / "missing.db", "sess-1")
    assert exc2.value.note == "state-db-missing"


def test_produce_session_audit_unit_end_to_end(audit, home, tmp_path):
    db = _sqlite_session(tmp_path / "state.db", "sess-9", [("user", "你好"), ("assistant", "在的")])
    messages = audit.read_session_chat(db, "sess-9")
    out = audit.produce_session_audit_unit(
        engine_session_id="sess-9", messages=messages, profile_key="/profiles/alpha",
        profile_name="Alpha", variant="plankton", engine_version="1.0.0", project="proj", home=home,
    )
    assert out["kind"] == "ok"
    unit = out["unit"]
    assert unit["session_audit_id"] == "plankton:sess-9"
    assert unit["human"] == {"auth_user_id": None}
    assert unit["agent"]["authoritative"] is False
    assert [e["content"] for e in unit["transcript"]] == ["你好", "在的"]
    assert audit.audit_hygiene_problem(unit) is None


def test_produce_session_audit_unit_rejects_with_a_typed_reason(audit, home):
    out = audit.produce_session_audit_unit(
        engine_session_id="", messages=[], profile_key="/profiles/a", home=home
    )
    assert out == {"kind": "rejected", "note": "engine-session-id-required"}


# ─────────────────────────────────────────────────────────────────────────────
# ⑦ 纯逻辑 / 不上传（红线：本包不发送任何数据）
# ─────────────────────────────────────────────────────────────────────────────


def test_audit_module_makes_no_network_and_no_subprocess_calls():
    """结构断言：本包不发送——模块不引网络/子进程库，也没有上传调用点。"""
    for forbidden in ("import socket", "import requests", "import urllib", "import httpx",
                      "import http.client", "import subprocess", "urlopen(", "requests.post"):
        assert forbidden not in AUDIT_SRC, f"W1 不得出现 {forbidden}"
    # 无上传调用点（模块里不存在 http 客户端动词；`egress` 只是设计文件名里的词，不作判据）。
    for verb in ("upload(", ".post(", "send_to", '@router.post("/audit'):
        assert verb not in AUDIT_SRC, f"W1 不实现上传（发现 {verb}）"


def test_plugin_backend_w1_routes_are_read_only():
    """后端 W1 路由只做「发号 / 组装预览」，不发送、不写 state.db。"""
    api = PLUGIN_API.read_text(encoding="utf-8")
    assert '@router.get("/audit/profile-id")' in api
    assert '@router.get("/audit/unit")' in api
    # W1 段（两条 audit 路由之间的实现）不得出现网络/上传动词。
    block = api.split('@router.get("/audit/profile-id")', 1)[1].split("def assert_outside_personal_trees", 1)[0]
    for forbidden in ("requests.post", "httpx", "urlopen(", "subprocess", "socket"):
        assert forbidden not in block, f"W1 只读路由不得出现 {forbidden}"


# ─────────────────────────────────────────────────────────────────────────────
# ⑧ 后端 W1 路由的真实行为（需要 fastapi；裸 python3 下跳过，.venv 下必跑）
# ─────────────────────────────────────────────────────────────────────────────


def _load_plugin_api():
    pytest.importorskip("fastapi")
    spec = importlib.util.spec_from_file_location("plankton_enterprise_plugin_api_audit", PLUGIN_API)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_backend_w1_routes_real_behaviour(monkeypatch, tmp_path):
    api = _load_plugin_api()
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("PLANKTON_PROFILE_IDS_FILE", raising=False)

    # 发号：同 profile（键＝稳定身份）改名 → 同 ID；且台账落在企业 home。
    first = api.audit_profile_id(profile="/profiles/alpha", name="Alpha")
    assert first["kind"] == "ok" and first["profileId"].startswith("pid_")
    renamed = api.audit_profile_id(profile="/profiles/alpha", name="Alpha Renamed")
    assert renamed["profileId"] == first["profileId"]
    assert (home / "plankton-enterprise" / "profile-ids.json").is_file()

    # 组装：从企业 home 内的只读夹具库读全部聊天记录，人方恒空，agent 非权威。
    db = _sqlite_session(home / "fixture.db", "s1", [("user", "q"), ("assistant", "a")])
    out = api.audit_unit(session="s1", profile="/profiles/alpha", name="Alpha", db=str(db))
    assert out["kind"] == "ok"
    assert out["unit"]["human"] == {"auth_user_id": None}
    assert out["unit"]["agent"]["authoritative"] is False
    assert [e["content"] for e in out["unit"]["transcript"]] == ["q", "a"]
    assert out["unit"]["session_audit_id"] == "plankton:s1"

    # 未知会话、企业 home 外的库：都 fail-closed，且都不产单元。
    assert api.audit_unit(session="nope", db=str(db))["note"] == "no-session"
    outside = _sqlite_session(tmp_path / "outside.db", "s1", [("user", "q")])
    assert api.audit_unit(session="s1", db=str(outside)) == {
        "kind": "rejected",
        "note": "session-db-outside-enterprise-home",
    }
