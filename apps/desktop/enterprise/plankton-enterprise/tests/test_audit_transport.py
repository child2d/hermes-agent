"""批 4 · 客户端接线 线 ④ —— **真实传输：可注入 + 默认关闭 + 配置位** 的承重 + 反证。

设计为准：N7 §4（客户端上传 / 断网缓冲）＋ §3（接收端点/鉴权形态）＋ §6（边界护栏）；
需求 PLK-REQ-0044（复用既有管道**形态**）。

钉住：
  * **默认无传输**：无配置 / 未启用 / 无端点 ⇒ `build_transport()` 返回 `None` ⇒ flush fail-closed
    拒 `no-transport`（**一个字节都不外发**）；
  * **端点与凭据只来自企业 home 配置**：源码**不得**出现真实 URL 字面量；配置坏了**回落关闭**
    （绝不能变成偷偷启用）；
  * **凭据/端点不外泄**：`describe_transport` 只回 `*Configured: bool`，**不回原值**；日志不回显凭据；
  * **HTTP 状态 → 传输语义**的映射逐条核对（2xx ok / 408·425·429·5xx retryable / 其余 4xx permanent）；
  * **不写个人 `~/.hermes`**：配置只在企业 home 内读。
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
    payload = {"enabled": True, "endpoint": "https://central.example.invalid/plankton/audit"}
    payload.update(extra)
    _write_config(home, payload)
    return payload


def test_transport_maps_success_and_statuses(transport, home, monkeypatch):
    """2xx ⇒ ok；408/425/429/5xx ⇒ retryable；其余 4xx ⇒ permanent（逐条核对映射口径）。"""
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

    for status in (408, 425, 429, 500, 503):
        captured["status"] = status
        result = built(unit)
        assert result["ok"] is False and result["retryable"] is True, f"HTTP {status} 应判 retryable"

    for status in (400, 401, 403, 404, 422):
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
