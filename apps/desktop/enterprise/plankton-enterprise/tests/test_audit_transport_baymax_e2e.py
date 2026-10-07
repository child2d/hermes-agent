"""线 ④ · **本地 mock 端点** 承重：真实 HTTP 往返证明（**不依赖任何已部署的服务**）。

本文件用一个**本机 127.0.0.1** 的 mock 接收端点（**本地 HS256 验签**，形态同中心接收端），
经**真实** `urllib` 往返（不 monkeypatch `_urlopen`）钉住改后的凭据源：

  ① **有效捎客自签 JWT**（`modules.baymax.token`）⇒ 发送成功；且请求体与**旧行为逐字一致**
     （`json.dumps(unit, ensure_ascii=False).encode("utf-8")`，序列化未随本批改动）；
     Bearer 就是那个模块 JWT（**不是**飞书 token、**不是** skillhub token）。
  ② **JWT 过期** ⇒ 走 **CLI 自带刷新**（这里用**桩 CLI** 走真实 `refresh_cli_token()` 子进程路径，
     证明「触发的 argv 正确 + 刷新后重读回写值」）⇒ 重试成功。
  ③ **无 token / 存储不可用** ⇒ `no-credential:*`、**零出网**（毒化 `socket.socket.connect`；
     且 mock 端点收到 **0** 个请求）。

本文件**不**触发真 CLI、不连网、不写个人 `~/.hermes`。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.util
import json
import os
import socket
import stat
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
TRANSPORT_PATH = PLUGIN_ROOT / "audit_transport.py"

_ENDPOINT_PATH = "/plankton/audit"
_UNIT = {"session_audit_id": "plankton:s", "human": {"auth_user_id": None}}
_EXP_PAST = 1_000_000_000
_EXP_FUTURE = 4_000_000_000


def _load():
    spec = importlib.util.spec_from_file_location("plankton_enterprise_audit_transport_e2e", TRANSPORT_PATH)
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
    monkeypatch.delenv("PLANKTON_AUDIT_EGRESS_CLI", raising=False)
    return target


# ── 真 HS256（本机密钥；只证明「自签 JWT + 验签」的线上形态） ──────────────────────


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _sign_hs256(secret: bytes, exp: int, **claims) -> str:
    header = _b64u(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = _b64u(json.dumps(
        {"account": "u@shaoke.com", "id": "1", "name": "n", "roles": ["user"], "status": 1,
         "iat": exp - 86400, "exp": exp, **claims},
        separators=(",", ":"), ensure_ascii=False,
    ).encode())
    signing_input = f"{header}.{payload}".encode()
    sig = hmac.new(secret, signing_input, hashlib.sha256).digest()
    return f"{header}.{payload}.{_b64u(sig)}"


def _verify_hs256(secret: bytes, token: str) -> bool:
    parts = token.split(".")
    if len(parts) != 3:
        return False
    signing_input = f"{parts[0]}.{parts[1]}".encode()
    expected = hmac.new(secret, signing_input, hashlib.sha256).digest()
    try:
        given = base64.urlsafe_b64decode(parts[2] + "=" * (-len(parts[2]) % 4))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(expected, given)


# ── 本地 mock 接收端点（HS256 验签；记录每个请求） ───────────────────────────────


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # 静音
        return

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        auth = self.headers.get("Authorization") or ""
        token = auth[len("Bearer "):] if auth.startswith("Bearer ") else ""
        self.server.requests.append({  # type: ignore[attr-defined]
            "path": self.path,
            "content_type": self.headers.get("Content-Type"),
            "authorization": auth,
            "token": token,
            "body": body,
        })
        if _verify_hs256(self.server.secret, token):  # type: ignore[attr-defined]
            self.send_response(200)
        else:
            self.send_response(401)
        self.send_header("Content-Length", "0")
        self.end_headers()


class _MockServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, secret: bytes):
        super().__init__(("127.0.0.1", 0), _Handler)
        self.secret = secret
        self.requests: list = []


@pytest.fixture()
def mock_endpoint():
    secret = os.urandom(32)
    server = _MockServer(secret)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_address[1]}{_ENDPOINT_PATH}"
    try:
        yield url, server, secret
    finally:
        server.shutdown()
        server.server_close()


def _write_config(home: Path, endpoint: str) -> None:
    config_dir = home / "plankton-enterprise"
    config_dir.mkdir(parents=True, exist_ok=True)
    # 只给端点：凭据**不写**配置 ⇒ 强制走**发送时运行时解析**（本批改的路径）。
    (config_dir / "audit-egress.json").write_text(
        json.dumps({"enabled": True, "endpoint": endpoint}), encoding="utf-8"
    )


def _write_store(path: Path, token: Optional[str], *, extra_modules: Optional[dict] = None,
                 extra_top: Optional[dict] = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    modules = {"baymax": {"token": token or "", "role": "", "email": "u@shaoke.com"}}
    if extra_modules:
        modules.update(extra_modules)
    data = {"modules": modules}
    if extra_top:
        data.update(extra_top)
    path.write_text(json.dumps(data), encoding="utf-8")


# ── ① 有效自签 JWT ⇒ 发送成功，内容逐字一致，Bearer 就是模块 JWT ──────────────────


def test_valid_module_jwt_sends_via_real_http_and_body_is_verbatim(transport, home, mock_endpoint, monkeypatch, tmp_path):
    url, server, secret = mock_endpoint
    token = _sign_hs256(secret, _EXP_FUTURE)
    store = tmp_path / "tokens.json"
    _write_store(store, token)
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(store))
    _write_config(home, url)

    built = transport.build_transport(home)
    assert callable(built)
    assert built(_UNIT) == {"ok": True}

    assert len(server.requests) == 1
    req = server.requests[0]
    assert req["path"] == _ENDPOINT_PATH
    assert req["content_type"] == "application/json"
    assert req["authorization"] == f"Bearer {token}"
    # 逐字一致：请求体就是模块既有的序列化（本批**未**改序列化）。
    assert req["body"] == json.dumps(_UNIT, ensure_ascii=False).encode("utf-8")
    # 端点侧独立 HS256 验签通过 ⇒ 送出的确是**自签 JWT**本体。
    assert _verify_hs256(secret, req["token"]) is True


def test_sent_bearer_is_module_jwt_not_feishu_nor_skillhub(transport, home, mock_endpoint, monkeypatch, tmp_path):
    """即使存储里同时有飞书 `auth.access_token` 与 `modules.skillhub.token`，送出的仍是
    `modules.baymax.token`（**不回退**）。"""
    url, server, secret = mock_endpoint
    module_tok = _sign_hs256(secret, _EXP_FUTURE, who="baymax")
    feishu_tok = "feishu-access-token-should-never-send"
    skillhub_tok = _sign_hs256(secret, _EXP_FUTURE, who="skillhub")
    store = tmp_path / "tokens.json"
    _write_store(
        store, module_tok,
        extra_modules={"skillhub": {"token": skillhub_tok, "role": "", "email": ""}},
        extra_top={"auth": {"access_token": feishu_tok, "expires_at": "2999-01-01T00:00:00+08:00"}},
    )
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(store))
    _write_config(home, url)

    assert transport.build_transport(home)(_UNIT) == {"ok": True}
    req = server.requests[0]
    assert req["token"] == module_tok
    assert req["token"] not in (feishu_tok, skillhub_tok)


# ── ② 过期 JWT ⇒ 经 CLI 自带刷新（桩 CLI 走真子进程路径）后成功 ────────────────────


def _make_stub_cli(script_path: Path, store_path: Path, secret: bytes, *, tag: str, argv_dump: Path) -> Path:
    """造一个**桩 CLI**：记录 argv 后把 `modules.baymax.token` 回写成新的自签 JWT。

    这走的是**真实** `refresh_cli_token()` 子进程路径（argv=配置的 CLI + `baymax +whoami`）。
    """
    fresh = _sign_hs256(secret, _EXP_FUTURE, who=tag)
    script = (
        "#!/usr/bin/env python3\n"
        "import json, sys, pathlib\n"
        f"pathlib.Path({str(argv_dump)!r}).write_text(json.dumps(sys.argv[1:]))\n"
        f"store_to = pathlib.Path({str(store_path)!r})\n"
        "data = json.loads(store_to.read_text())\n"
        f"data['modules']['baymax']['token'] = {fresh!r}\n"
        "store_to.write_text(json.dumps(data))\n"
    )
    script_path.write_text(script, encoding="utf-8")
    script_path.chmod(script_path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return script_path


def test_expired_jwt_triggers_cli_refresh_then_real_send_succeeds(transport, home, mock_endpoint, monkeypatch, tmp_path):
    url, server, secret = mock_endpoint
    store = tmp_path / "tokens.json"
    _write_store(store, _sign_hs256(secret, _EXP_PAST, who="expired"))
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(store))

    argv_dump = tmp_path / "cli-argv.json"
    stub = _make_stub_cli(tmp_path / "stub-shaoke-cli", store, secret, tag="refreshed", argv_dump=argv_dump)
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_CLI", str(stub))
    _write_config(home, url)

    assert transport.build_transport(home)(_UNIT) == {"ok": True}
    # 桩 CLI 收到的 argv = 「baymax +whoami」⇒ 刷新走 CLI 自带路径、命令最小且正确。
    assert json.loads(argv_dump.read_text()) == ["baymax", "+whoami"]
    # 服务端收到的 Bearer = 刷新后回写的新 JWT。
    req = server.requests[0]
    assert _verify_hs256(secret, req["token"]) is True
    assert req["body"] == json.dumps(_UNIT, ensure_ascii=False).encode("utf-8")


def test_expired_jwt_with_failing_refresh_sends_nothing(transport, home, mock_endpoint, monkeypatch, tmp_path):
    """过期 + 刷新不可用（CLI 缺失）⇒ fail-closed：`no-credential:*`、**零出网**、可重试。"""
    url, server, secret = mock_endpoint
    store = tmp_path / "tokens.json"
    _write_store(store, _sign_hs256(secret, _EXP_PAST, who="expired"))
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(store))
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_CLI", str(tmp_path / "does-not-exist-cli"))
    _write_config(home, url)

    result = transport.build_transport(home)(_UNIT)
    assert result["ok"] is False and result["retryable"] is True
    assert result["note"].startswith("no-credential:")
    assert server.requests == [], "刷新失败仍无凭据 ⇒ 不得外发"


# ── ③ 无 token ⇒ no-credential:* + 零出网（毒化 socket） ────────────────────────


def test_no_token_zero_egress_with_poisoned_socket(transport, home, mock_endpoint, monkeypatch, tmp_path):
    url, server, secret = mock_endpoint
    monkeypatch.setenv("PLANKTON_AUDIT_EGRESS_TOKEN_STORE", str(tmp_path / "missing.json"))
    _write_config(home, url)

    def _poisoned_connect(self, *args, **kwargs):
        raise OSError("network disabled in test (poisoned socket.connect)")

    monkeypatch.setattr(socket.socket, "connect", _poisoned_connect)

    result = transport.build_transport(home)(_UNIT)
    assert result["ok"] is False and result["retryable"] is True
    assert result["note"] == "no-credential:no-cli-token"
    assert server.requests == [], "无凭据 ⇒ mock 端点收 0 个请求"
