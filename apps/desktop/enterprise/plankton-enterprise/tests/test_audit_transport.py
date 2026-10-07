"""批 4 · 客户端接线 线 ④ —— **真实传输：可注入 + 默认关闭 + 配置位** 的承重 + 反证。

设计为准：N7 §4（客户端上传 / 断网缓冲）＋ §3（接收端点/鉴权形态）＋ §6（边界护栏）；
需求 PLK-REQ-0044（复用既有管道**形态**）。

钉住：
  * **默认无传输**：无配置 / 未启用 / 无端点 ⇒ `build_transport()` 返回 `None` ⇒ flush fail-closed
    拒 `no-transport`（**一个字节都不外发**）；
  * **端点只来自企业 home 配置**：源码**不得**出现真实 URL 字面量；配置坏了**回落关闭**
    （绝不能变成偷偷启用）；
  * **凭据在发送时解析、来源可多处**：环境变量 → 配置 `credential` → **运行时读 CLI token 存储**
    （`~/.shaoke/tokens.json`；**不是** `~/.hermes`）。**不缓存过期值**；过期走 **CLI 自带刷新**
    后**至多重试一次**；读不到 ⇒ **fail-closed（绝不发匿名请求）+ 可重试**（**不是** permanent）；
  * **凭据/端点不外泄**：`describe_transport` 只回 `*Configured: bool`/`credentialSource`（类别），
    **不回原值**；日志/返回文案不回显凭据；
  * **HTTP 状态 → 传输语义**的映射逐条核对（2xx ok / **401**·408·425·429·5xx retryable / 其余 4xx permanent）；
  * **不写个人 `~/.hermes`**：配置只在企业 home 内读；CLI token 存储的读取**仅限** `~/.shaoke`。
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
TRANSPORT_SRC = (PLUGIN_ROOT / "audit_transport.py").read_text(encoding="utf-8")
TRANSPORT_PATH = PLUGIN_ROOT / "audit_transport.py"


def _load():
    spec = importlib.util.spec_from_file_location("plankton_enterprise_audit_transport_t", TRANSPORT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def transport():
    return _load()


@pytest.fixture()
def home(tmp_path: Path, monkeypatch) -> Path:
    target = tmp_path / "ent-home"
    target.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(target))
    monkeypatch.delenv("PLANKTON_AUDIT_EGRESS_CREDENTIAL", raising=False)
    monkeypatch.delenv("PLANKTON_AUDIT_EGRESS_ENDPOINT", raising=False)
    return target


def _write_config(home: Path, payload: dict) -> None:
    config_dir = home / "plankton-enterprise"
    config_dir.mkdir(parents=True, exist_ok=True)
    (config_dir / "audit-egress.json").write_text(json.dumps(payload), encoding="utf-8")


# ── 默认关闭（安全态） ────────────────────────────────────────────────────────


def test_default_transport_is_absent(transport, home):
    """默认：无配置 ⇒ 无传输（`None`）⇒ 宿主 flush 时 fail-closed 拒 `no-transport`。"""
    assert transport.build_transport(home) is None
    assert transport.describe_transport(home)["mode"] == "no-transport"


def test_enabled_without_endpoint_is_still_off(transport, home):
    """启用但没端点 ⇒ 仍**关闭**（**不猜**默认端点）。"""
    _write_config(home, {"enabled": True})
    assert transport.build_transport(home) is None
    assert transport.describe_transport(home)["mode"] == "no-transport"


def test_corrupt_config_falls_back_to_off(transport, home):
    """配置读坏 ⇒ 回落**关闭**（坏配置绝不能变成偷偷启用）。"""
    config_dir = home / "plankton-enterprise"
    config_dir.mkdir(parents=True, exist_ok=True)
    (config_dir / "audit-egress.json").write_text("{ not json", encoding="utf-8")
    assert transport.load_transport_config(home)["enabled"] is False
    assert transport.build_transport(home) is None


def test_no_config_file_touches_only_enterprise_home(transport, home, tmp_path):
    """不写个人 home：读配置只在**企业 home** 内（缺省路径指向企业 home，不指向 `~/.hermes`）。"""
    path = transport.config_path(home)
    assert str(home) in str(path)
    assert ".hermes" not in str(path), "配置落点不得在任何 ~/.hermes 内"


# ── 结构护栏：源码无真实 URL、不落 CLi 表 ─────────────────────────────────────


def test_source_has_no_hardcoded_endpoint():
    """源码**不得**写死端点（端点只来自配置）。"""
    code = "\n".join(
        line for line in TRANSPORT_SRC.splitlines() if not line.strip().startswith("#")
    )
    # 去掉 docstring 后仍不得出现真实 scheme 字面量。
    for scheme in ('"http://', '"https://', "'http://", "'https://"):
        assert scheme not in code, f"传输源码不得写死端点（{scheme}）"
    assert "cli_usage_log" not in code and "common_auth" not in code, "不复用 CLI 用量表"


# ── 启用后：HTTP 语义映射 ─────────────────────────────────────────────────────


class _FakeResponse:
    def __init__(self, status: int):
        self.status = status

    def read(self):
        return b""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _enable(transport, home, **extra) -> dict:
    payload = {
        "enabled": True,
        "endpoint": "https://central.example.invalid/plankton/audit",
        # 默认带静态凭据：状态映射/网络语义用例**不**依赖运行时凭据解析（运行时解析另有用例覆盖）。
        "credential": "test-credential",
    }
    payload.update(extra)
    _write_config(home, payload)
    return payload


def test_transport_maps_success_and_statuses(transport, home, monkeypatch):
    """2xx ⇒ ok；**401**/408/425/429/5xx ⇒ retryable；其余 4xx ⇒ permanent（逐条核对映射口径）。

    401 归 **retryable**（不是 permanent）：凭据可能只是过期、经 CLI 刷新即可恢复——归 permanent
    会让出口**静默停摆**（本批修的正是这条）。
    """
    _enable(transport, home)
    built = transport.build_transport(home)
    assert callable(built)

    captured = {}

    def fake_urlopen(url, data, headers, timeout):
        captured["url"] = url
        captured["headers"] = headers
        return _FakeResponse(captured.pop("status"))

    monkeypatch.setattr(transport, "_urlopen", fake_urlopen)
    unit = {"session_audit_id": "plankton:s", "human": {"auth_user_id": None}}

    for status in (200, 201, 204):
        captured["status"] = status
        assert built(unit) == {"ok": True}, f"HTTP {status} 应判 ok"

    for status in (401, 408, 425, 429, 500, 503):
        captured["status"] = status
        result = built(unit)
        assert result["ok"] is False and result["retryable"] is True, f"HTTP {status} 应判 retryable"

    for status in (400, 403, 404, 422):
        captured["status"] = status
        result = built(unit)
        assert result["ok"] is False and result["retryable"] is False, f"HTTP {status} 应判 permanent"
        assert str(status) in result["note"] and "sk-" not in result["note"], "note 只带状态码，不带凭据"



def test_transport_carries_bearer_but_never_leaks_it(transport, home, monkeypatch):
    """凭据进 `Authorization` 头；**不出现在**任何返回/诊断里。"""
    _enable(transport, home, credential="secret-token-value")
    built = transport.build_transport(home)
    seen = {}

    def fake_urlopen(url, data, headers, timeout):
        seen["headers"] = headers
        return _FakeResponse(200)

    monkeypatch.setattr(transport, "_urlopen", fake_urlopen)
    built({"session_audit_id": "plankton:s", "human": {"auth_user_id": None}})
    assert seen["headers"]["Authorization"] == "Bearer secret-token-value"

    described = transport.describe_transport(home)
    assert described["credentialConfigured"] is True
    assert "secret-token-value" not in json.dumps(described), "诊断不得回显凭据"
    assert "central.example.invalid" not in json.dumps(described), "诊断不得回显端点原值"


def test_network_error_is_retryable_and_note_has_no_secret(transport, home, monkeypatch):
    """网络异常 ⇒ retryable；`note` 只带**异常类型名**（不回显 message，可能含端点/凭据片段）。"""
    _enable(transport, home, credential="tok")

    def boom(url, data, headers, timeout):
        raise OSError("connect failed to https://central.example.invalid with Bearer tok")

    monkeypatch.setattr(transport, "_urlopen", boom)
    result = transport.build_transport(home)({"session_audit_id": "plankton:s"})
    assert result == {"ok": False, "retryable": True, "note": "transport-error:OSError"}
    assert "tok" not in result["note"] and "central" not in result["note"]


def test_endpoint_env_override_is_supported_but_still_opt_in(transport, home, monkeypatch):
    """端点也可经环境覆盖（一次性本地验证用）；仍**必须显式 enabled:true** 才启用。"""
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_ENDPOINT", "https://override.example.invalid/x")
    # 未写配置文件 / 未启用 ⇒ 仍关闭。
    assert transport.build_transport(home) is None
    _write_config(home, {"enabled": True})
    assert transport.build_transport(home) is not None


# ── 运行时凭据解析：CLI token 存储 / 过期刷新 / fail-closed（本批修正的静默停摆） ──────
#
# 反证基线（改前行为）：配置没有 credential ⇒ 无 Authorization ⇒ 服务端 401 ⇒ `_classify_status`
# 归 **permanent** ⇒ 不重试、上传恒失败。以下用例把「发送时解析 + 过期刷新 + 无凭据 fail-closed
# 且归**可重试**」逐条钉住。

_ENDPOINT = "https://central.example.invalid/plankton/audit"
_UNIT = {"session_audit_id": "plankton:s", "human": {"auth_user_id": None}}


def _write_token_store(path: Path, *, access_token, expires_at=None, refresh_token="rt") -> None:
    """造一份 CLI token 存储（形状同 `~/.shaoke/tokens.json` 的 `auth` 段）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    auth = {"access_token": access_token, "refresh_token": refresh_token}
    if expires_at is not None:
        auth["expires_at"] = expires_at
    path.write_text(json.dumps({"auth": auth}), encoding="utf-8")


def test_token_store_default_path_is_shaoke_not_hermes(transport, monkeypatch):
    """CLI token 存储的**缺省**落点是 `~/.shaoke/tokens.json`（**不是**任何个人 `~/.hermes`）。"""
    monkeypatch.delenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", raising=False)
    path = str(transport.token_store_path())
    assert path.endswith(".shaoke/tokens.json")
    assert ".hermes" not in path


def test_credential_resolved_from_cli_token_store_at_send_time(transport, home, monkeypatch, tmp_path):
    """配置**不含** credential ⇒ 发送时从 CLI token 存储解析凭据并带上；诊断只回类别不回值。"""
    store = tmp_path / "tokens.json"
    _write_token_store(store, access_token="store-token-value", expires_at="2999-01-01T00:00:00+08:00")
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(store))
    _write_config(home, {"enabled": True, "endpoint": _ENDPOINT})
    built = transport.build_transport(home)

    seen = {}

    def fake_urlopen(url, data, headers, timeout):
        seen["headers"] = headers
        return _FakeResponse(200)

    monkeypatch.setattr(transport, "_urlopen", fake_urlopen)
    assert built(_UNIT) == {"ok": True}
    assert seen["headers"]["Authorization"] == "Bearer store-token-value"

    described = transport.describe_transport(home)
    assert described["credentialConfigured"] is True
    assert described["credentialSource"] == "cli-token-store"
    assert "store-token-value" not in json.dumps(described)
    assert _ENDPOINT not in json.dumps(described)


def test_source_order_env_beats_config_beats_store(transport, home, monkeypatch, tmp_path):
    """来源顺序：环境变量 → 配置 `credential` → CLI token 存储（逐级回落）。"""
    store = tmp_path / "tokens.json"
    _write_token_store(store, access_token="store-token", expires_at="2999-01-01T00:00:00+08:00")
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(store))
    _write_config(home, {"enabled": True, "endpoint": _ENDPOINT})
    assert transport.resolve_credential(home)["source"] == "cli-token-store"

    _write_config(home, {"enabled": True, "endpoint": _ENDPOINT, "credential": "config-token"})
    assert transport.resolve_credential(home)["credential"] == "config-token"
    assert transport.resolve_credential(home)["source"] == "config"

    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_CREDENTIAL", "env-token")
    assert transport.resolve_credential(home)["credential"] == "env-token"
    assert transport.resolve_credential(home)["source"] == "env"


def test_expired_store_token_is_refreshed_via_cli_then_sent(transport, home, monkeypatch, tmp_path):
    """token 存储里已是**过期** token ⇒ 走 CLI 自带刷新（不自实现），刷新后重读并成功发送。"""
    store = tmp_path / "tokens.json"
    _write_token_store(store, access_token="expired-token", expires_at="2000-01-01T00:00:00+08:00")
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(store))
    calls = {"refresh": 0}

    def fake_refresh():
        calls["refresh"] += 1
        # 模拟 CLI 刷新后**回写** token 存储（这正是 `shaoke-cli` 的 TryRefreshToken 行为）。
        _write_token_store(store, access_token="fresh-token", expires_at="2999-01-01T00:00:00+08:00")
        return True

    monkeypatch.setattr(transport, "refresh_cli_token", fake_refresh)
    _write_config(home, {"enabled": True, "endpoint": _ENDPOINT})
    seen = {}

    def fake_urlopen(url, data, headers, timeout):
        seen["headers"] = headers
        return _FakeResponse(200)

    monkeypatch.setattr(transport, "_urlopen", fake_urlopen)
    assert transport.build_transport(home)(_UNIT) == {"ok": True}
    assert calls["refresh"] == 1
    assert seen["headers"]["Authorization"] == "Bearer fresh-token"


def test_no_token_fails_closed_never_sends_anonymous_and_is_retryable(transport, home, monkeypatch, tmp_path):
    """token 存储不可用/无 token ⇒ **不发匿名请求**、且归**可重试**（**不是** permanent）。"""
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(tmp_path / "missing.json"))
    poisoned = {"called": False}

    def boom(url, data, headers, timeout):
        poisoned["called"] = True
        raise AssertionError("无凭据时不得发匿名请求")

    monkeypatch.setattr(transport, "_urlopen", boom)
    _write_config(home, {"enabled": True, "endpoint": _ENDPOINT})
    result = transport.build_transport(home)(_UNIT)
    assert poisoned["called"] is False, "无凭据必须 fail-closed，绝不外发"
    assert result["ok"] is False
    assert result["retryable"] is True, "无凭据必须归可重试（改前 401 会归 permanent）"
    assert "no-credential" in result["note"]


def test_refresh_failure_is_retryable_not_permanent_and_sends_nothing(transport, home, monkeypatch, tmp_path):
    """刷新不可用/失败 ⇒ 归**可重试**（**不再** permanent），且**不丢单元**（不发送、保留）。"""
    store = tmp_path / "tokens.json"
    _write_token_store(store, access_token="expired-token", expires_at="2000-01-01T00:00:00+08:00")
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(store))
    monkeypatch.setattr(transport, "refresh_cli_token", lambda: True)  # 触发但没写回 ⇒ 刷新失败

    def boom(url, data, headers, timeout):
        raise AssertionError("刷新失败后仍无凭据，不得外发")

    monkeypatch.setattr(transport, "_urlopen", boom)
    _write_config(home, {"enabled": True, "endpoint": _ENDPOINT})
    result = transport.build_transport(home)(_UNIT)
    assert result["ok"] is False and result["retryable"] is True
    assert "cli-token-refresh-failed" in result["note"]


def test_401_triggers_refresh_and_retries_once_then_ok(transport, home, monkeypatch, tmp_path):
    """发送遇 401（凭据被拒）⇒ 刷新后**重试一次**并成功（服务端第二次收下）。"""
    store = tmp_path / "tokens.json"
    _write_token_store(store, access_token="stale-token", expires_at="2999-01-01T00:00:00+08:00")
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(store))

    def fake_refresh():
        _write_token_store(store, access_token="fresh-token", expires_at="2999-01-01T00:00:00+08:00")
        return True

    monkeypatch.setattr(transport, "refresh_cli_token", fake_refresh)
    _write_config(home, {"enabled": True, "endpoint": _ENDPOINT})
    seen = []

    def fake_urlopen(url, data, headers, timeout):
        seen.append(headers.get("Authorization"))
        return _FakeResponse(401 if len(seen) == 1 else 200)

    monkeypatch.setattr(transport, "_urlopen", fake_urlopen)
    assert transport.build_transport(home)(_UNIT) == {"ok": True}
    assert seen == ["Bearer stale-token", "Bearer fresh-token"], "至多重试一次、且用新凭据"


def test_401_refresh_at_most_one_retry(transport, home, monkeypatch, tmp_path):
    """持续 401 ⇒ **至多重试一次**（两次请求封顶），且最终归**可重试**（不循环、不 permanent）。"""
    store = tmp_path / "tokens.json"
    _write_token_store(store, access_token="t1", expires_at="2999-01-01T00:00:00+08:00")
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(store))
    calls = {"refresh": 0}

    def fake_refresh():
        calls["refresh"] += 1
        _write_token_store(store, access_token=f"t{calls['refresh'] + 1}", expires_at="2999-01-01T00:00:00+08:00")
        return True

    monkeypatch.setattr(transport, "refresh_cli_token", fake_refresh)
    _write_config(home, {"enabled": True, "endpoint": _ENDPOINT})
    seen = []

    def fake_urlopen(url, data, headers, timeout):
        seen.append(headers.get("Authorization"))
        return _FakeResponse(401)

    monkeypatch.setattr(transport, "_urlopen", fake_urlopen)
    result = transport.build_transport(home)(_UNIT)
    assert len(seen) == 2, "最多两次请求（原始 + 重试一次）"
    assert result["ok"] is False and result["retryable"] is True


def test_describe_transport_never_refreshes(transport, home, monkeypatch, tmp_path):
    """只读诊断面**绝不**触发刷新（读路径无副作用）；过期 token 时只报不可用类别。"""
    store = tmp_path / "tokens.json"
    _write_token_store(store, access_token="expired-token", expires_at="2000-01-01T00:00:00+08:00")
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(store))
    monkeypatch.setattr(
        transport, "refresh_cli_token",
        lambda: (_ for _ in ()).throw(AssertionError("describe 不得触发刷新")),
    )
    _write_config(home, {"enabled": True, "endpoint": _ENDPOINT})
    described = transport.describe_transport(home)
    assert described["credentialConfigured"] is False
    assert "expired-token" not in json.dumps(described)


# ── 真实客户端的非 2xx：`HTTPError` 必须解出状态码，否则口径表是死码 ──────────────────
#
# 反证基线：`urllib` 对 4xx/5xx 抛 `HTTPError`；改前 `_post`/transport 把它笼统当
# `transport-error:*`（retryable），`_classify_status` 与「401→刷新重试」在真实客户端下**不可达**。
# 以下用例把「状态码真的流到分类/刷新分支」钉住。


def _http_error(status: int):
    import urllib.error

    return urllib.error.HTTPError(_ENDPOINT, status, "err", {}, None)  # type: ignore[arg-type]


def test_real_http_error_status_reaches_classification(transport, home, monkeypatch):
    """4xx/5xx 以 `HTTPError` 抛出时，状态码被解出并走 `_classify_status`（403 permanent / 503 retryable）。"""
    _enable(transport, home)
    built = transport.build_transport(home)

    monkeypatch.setattr(
        transport, "_urlopen", lambda *a, **k: (_ for _ in ()).throw(_http_error(403)))
    result = built(_UNIT)
    assert result == {"ok": False, "retryable": False, "note": "http-403"}

    monkeypatch.setattr(
        transport, "_urlopen", lambda *a, **k: (_ for _ in ()).throw(_http_error(503)))
    result = built(_UNIT)
    assert result == {"ok": False, "retryable": True, "note": "http-503"}


def test_real_http_error_401_refreshes_and_retries_once(transport, home, monkeypatch, tmp_path):
    """生产路径（`HTTPError` 401）同样触发刷新 + 至多重试一次 ⇒ 服务端第二次 200 即成功。"""
    store = tmp_path / "tokens.json"
    _write_token_store(store, access_token="stale-token", expires_at="2999-01-01T00:00:00+08:00")
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(store))
    calls = {"n": 0}

    def fake_refresh():
        _write_token_store(store, access_token="fresh-token", expires_at="2999-01-01T00:00:00+08:00")
        return True

    monkeypatch.setattr(transport, "refresh_cli_token", fake_refresh)
    _write_config(home, {"enabled": True, "endpoint": _ENDPOINT})

    def fake_urlopen(url, data, headers, timeout):
        calls["n"] += 1
        if calls["n"] == 1:
            raise _http_error(401)
        return _FakeResponse(200)

    monkeypatch.setattr(transport, "_urlopen", fake_urlopen)
    assert transport.build_transport(home)(_UNIT) == {"ok": True}
    assert calls["n"] == 2, "401（真实 HTTPError）应触发刷新后重试一次"


