"""批 4 · W5＋W6 —— 审计出口在**客户端插件后端**的**只读可见面**（§8 W5「可见」/§8 W6 自检）。

两条只读路由：
  * `GET /audit/buffer`        —— 断网缓冲健康（W5「可见 / 健康观测」）；
  * `GET /audit/landing-check` —— home 落点自检裁决（W6，fail-closed，附可行动提示）。

本文件钉住：
  * 缓冲状态**只读**可查（不因读而写、不因读而上传）；
  * 落点自检：正常企业 home ⇒ `ok:true`；企业 home 落进个人 `~/.hermes` ⇒ `ok:false` + 提示；
  * **不新增产品写口**：后端**没有**任何 `/audit*` 的写路由（结构断言）。
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

PLUGIN_API = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"
EGRESS_PATH = Path(__file__).resolve().parents[1] / "audit_egress.py"
PLUGIN_API_SRC = PLUGIN_API.read_text(encoding="utf-8")


def load_plugin_api():
    spec = importlib.util.spec_from_file_location("plankton_enterprise_plugin_api_egress", PLUGIN_API)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def load_egress():
    spec = importlib.util.spec_from_file_location("plankton_enterprise_audit_egress_t", EGRESS_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def api():
    return load_plugin_api()


@pytest.fixture()
def egress():
    return load_egress()


@pytest.fixture()
def home(tmp_path: Path, monkeypatch) -> Path:
    target = tmp_path / "ent-home"
    target.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(target))
    # 屏蔽任何可能从进程环境漏进来的缓冲覆盖。
    monkeypatch.delenv("PLANKTON_AUDIT_BUFFER_DIR", raising=False)
    return target


def test_buffer_route_reports_health_readonly(api, egress, home):
    """`GET /audit/buffer`：正常企业 home ⇒ 空缓冲的 kind:ok 健康。"""
    status = api.audit_buffer()
    assert status["kind"] == "ok"
    assert status["pending"] == 0 and status["dropped"] == 0
    assert status["limit"] == egress.DEFAULT_BUFFER_LIMIT


def test_buffer_route_reflects_a_pending_unit(api, egress, home):
    """入一个单元后，`GET /audit/buffer` 能**看见**它（可见性），且读操作**不**上传（无传输）。"""
    buf = egress.AuditBuffer(egress.buffer_root(home))
    unit = {
        "session_audit_id": "plankton:sess-buf",
        "human": {"auth_user_id": None},
        "agent": {"profileName": "A", "profileId": "pid_1", "variant": "plankton",
                  "engineVersion": "x", "authoritative": False, "note": "self-reported"},
        "transcript": [{"role": "user", "content": "hi"}],
    }
    buf.enqueue(unit)
    status = api.audit_buffer()
    assert status["pending"] == 1, "缓冲里的单元必须可见"
    assert status["dropped"] == 0
    # 读操作**不**上传：无传输 ⇒ 单元仍在（可见 ≠ 已上传）。
    assert status["pending"] == 1


def test_landing_check_passes_for_a_normal_enterprise_home(api, home):
    verdict = api.audit_landing_check()
    assert verdict["ok"] is True
    assert verdict["hint"] == ""


def test_landing_check_refuses_when_home_is_inside_personal_hermes(api, tmp_path, monkeypatch):
    """承重：企业 home 落进个人 `~/.hermes` ⇒ 只读裁决 `ok:false` + 可行动提示（fail-closed）。"""
    personal = tmp_path / "me"
    bad = personal / ".hermes" / "enterprise-home"
    bad.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(personal))  # 个人 home
    monkeypatch.setenv("HERMES_HOME", str(bad))  # 企业 home 落在个人 ~/.hermes 内
    verdict = api.audit_landing_check()
    assert verdict["ok"] is False
    assert verdict["kind"] == "landing-inside-personal-home"
    assert verdict["hint"], "必须给可行动提示，不静默回退"


def test_backend_adds_no_audit_write_route():
    """不新增产品写口：后端**没有**任何 `/audit*` 的 POST/PUT/PATCH/DELETE 路由（结构断言）。"""
    import re

    for verb in ("post", "put", "patch", "delete"):
        pattern = re.compile(rf'@router\.{verb}\(\s*[\'"]/audit')
        assert not pattern.search(PLUGIN_API_SRC), f"不得新增 /audit 的 {verb.upper()} 写路由"
    # 只读路由确实存在。
    assert '@router.get("/audit/buffer")' in PLUGIN_API_SRC
    assert '@router.get("/audit/landing-check")' in PLUGIN_API_SRC
