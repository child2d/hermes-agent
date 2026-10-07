"""plankton-enterprise 测试的**隔离护栏**。

红线：测试**绝不**写个人 `~/.hermes`（PLK-REQ-0006 边界；W6 的落点自检正是为拦这条而存在）。
本机开发时 `HERMES_HOME` 常等于真实 `~/.hermes`，任何「忘了注入企业 home」的用例都会把
缓冲/台账写进个人目录——本夹具把这件事在**测试层**兜底：默认给每个用例一个**临时** home，
用例自己的 `home` 夹具（或 monkeypatch）会在此之后覆盖（autouse 先于显式夹具求值）。

另：本文件同时是**防回归**——若有人删掉它，`test_isolation_guard_is_active` 会红。
"""

from __future__ import annotations

import os

import pytest


@pytest.fixture(autouse=True)
def _isolate_hermes_home(tmp_path, monkeypatch):
    """把 HERMES_HOME / plankton 落点覆盖钉到本用例的临时目录（红线：不写真实 home）。"""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "isolated-hermes-home"))
    monkeypatch.delenv("PLANKTON_AUDIT_BUFFER_DIR", raising=False)
    monkeypatch.delenv("PLANKTON_PROFILE_IDS_FILE", raising=False)
    # 凭据解析会读 **CLI token 存储**（`~/.shaoke/tokens.json`，不是 ~/.hermes）；测试**绝不**
    # 依赖真实机器上的凭据 ⇒ 一律钉到本用例的临时（不存在）路径。
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(tmp_path / "no-such-tokens.json"))
    monkeypatch.delenv("PLANKTON_AUDIT_EGRESS_CREDENTIAL", raising=False)
    monkeypatch.delenv("PLANKTON_AUDIT_EGRESS_CLI", raising=False)
    yield


def test_isolation_guard_is_active(tmp_path):
    """本护栏自身有效：HERMES_HOME 已被钉到临时目录，且**不在**真实 `~/.hermes` 内。"""
    from pathlib import Path

    hermes_home = Path(os.environ["HERMES_HOME"]).resolve()
    personal = (Path(os.path.expanduser("~")) / ".hermes").resolve()
    assert hermes_home != personal
    assert str(personal) + os.sep not in str(hermes_home) + os.sep
