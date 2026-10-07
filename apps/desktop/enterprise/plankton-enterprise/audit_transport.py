"""plankton-enterprise — 审计出口的**真实传输**（批 4 · 客户端接线 · 线 ④）。

设计为准（逐字）：`docs/plankton/N7-technical-design/N7-20261007-plankton-audit-egress.md`
**§4**（客户端：上传、断网缓冲与失败态）＋ **§3**（接收端点／鉴权形态）＋ **§6**（边界护栏）；
需求：`docs/plankton/N2-requirements/N2-20261007-plankton-audit-egress.md` PLK-REQ-0041/0043/0044/0047。

职责边界（**只此一件事**）：把 `audit_egress.flush` 需要的那个 `transport(unit)` 交出来 —— 即
把审计单元 `POST` 到**中心端点**（形态同既有中心审计管道：`POST <path>` + Bearer 验身份）。
本模块**不组单元、不落缓冲、不决定重试策略**（那三件事分别属 `audit_unit` / `audit_egress`）。

硬约束（红线，见模块末尾的 `tests/test_audit_transport.py`）：

  * **默认关闭、默认无传输**：配置缺省/未启用/无端点 ⇒ `build_transport()` 返回 `None` ⇒
    `audit_egress.flush(None)` fail-closed 拒 `no-transport`，**一个字节都不外发**（安全态）。
  * **端点与凭据只来自配置**（企业 home 内 `<home>/plankton-enterprise/audit-egress.json`），
    **绝不**在源码里写死 URL / 凭据；**不进包**（配置不进产物）、**不入报告**。
  * **凭据不落日志**：只用于 `Authorization` 头；任何返回/日志/异常文案都**不回显**它。
  * **不写个人 `~/.hermes`**：配置只在**企业 home** 内读；读不到就当作「未启用」。
  * **归因不出客户端**：请求体就是 `audit_unit` 产出的上送段（`human` 恒空），本模块不改它。

配置形状（`audit-egress.json`，全部可选）：

    {
      "enabled": true,                     // 缺省 false ⇒ 关闭
      "endpoint": "…/plankton/audit",      // 中心接收端点；缺省空 ⇒ 关闭（不是猜一个默认）
      "credential": "…",                   // Bearer 值；缺省则不带 Authorization 头
      "timeoutSeconds": 15,                // 缺省 15
      "client": "plankton-desktop"         // 仅作审计元数据，随体上送（可缺省）
    }
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

#: 传输契约（与 `audit_egress.Transmission` **同一个**）：`transport(unit) -> {"ok": bool, …}`。
Transmission = Callable[[dict], dict]

#: 配置文件名（企业 home 内 `<home>/plankton-enterprise/` 下）。
CONFIG_DIRNAME = "plankton-enterprise"
CONFIG_FILENAME = "audit-egress.json"

#: 凭据覆盖用的环境变量（便于 CI/一次性本地验证；**不是**唯一来源，配置文件优先）。
CREDENTIAL_ENV = "PLANKTON_AUDIT_EGRESS_CREDENTIAL"
#: 端点覆盖用的环境变量（同上）。
ENDPOINT_ENV = "PLANKTON_AUDIT_EGRESS_ENDPOINT"

DEFAULT_TIMEOUT_SECONDS = 15

#: 传输结果 kinds（闭集语义，与 `audit_egress` 一致）：`ok` / `retryable` / `permanent`。
#: HTTP 状态 → 语义映射的口径（写死在此，供测试逐条核对）：
#:   * 2xx               ⇒ ok（服务端按幂等键收纳）
#:   * 408 / 425 / 429   ⇒ retryable（暂态）
#:   * 5xx               ⇒ retryable（服务端暂不可用）
#:   * 其余 4xx          ⇒ permanent（凭据/入参问题，重试无意义）
_RETRYABLE_STATUS = frozenset({408, 425, 429})


def config_path(home: Optional[Path] = None) -> Path:
    """配置落点：**企业 home** 内 `<home>/plankton-enterprise/audit-egress.json`。

    绝不指向个人 `~/.hermes`；`home` 由宿主（引擎 home）给定，缺省取 `HERMES_HOME`。
    """
    base = _enterprise_home(home)
    if base is None:
        raise OSError("enterprise-home-unavailable")
    return base / CONFIG_DIRNAME / CONFIG_FILENAME


def _enterprise_home(home: Optional[Path] = None) -> Optional[Path]:
    if home is not None:
        return Path(home).expanduser()
    env = (os.environ.get("HERMES_HOME") or "").strip()
    if env:
        return Path(env).expanduser()
    try:
        from hermes_constants import get_default_hermes_root  # type: ignore

        return Path(get_default_hermes_root())
    except Exception:
        return None


def load_transport_config(home: Optional[Path] = None) -> dict:
    """读配置（**永不抛**）。读不到/读坏/形状不对 ⇒ 一律回落**关闭**默认。

    返回规范化字典：`{"enabled": bool, "endpoint": str, "credential": str|None,
    "timeoutSeconds": number, "client": str}`。任何一步失败都返回**未启用**的默认 ——
    配置坏了绝不能变成「偷偷启用」。
    """
    default = {
        "enabled": False,
        "endpoint": "",
        "credential": None,
        "timeoutSeconds": DEFAULT_TIMEOUT_SECONDS,
        "client": "",
    }
    try:
        path = config_path(home)
    except OSError:
        return dict(default)
    raw: Any = {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    if not isinstance(raw, dict):
        raw = {}

    endpoint = str(raw.get("endpoint") or "").strip() or (os.environ.get(ENDPOINT_ENV) or "").strip()
    credential = str(raw.get("credential") or "").strip() or (os.environ.get(CREDENTIAL_ENV) or "").strip()
    enabled = raw.get("enabled") is True
    try:
        timeout = float(raw.get("timeoutSeconds") or DEFAULT_TIMEOUT_SECONDS)
    except (TypeError, ValueError):
        timeout = DEFAULT_TIMEOUT_SECONDS
    if timeout <= 0:
        timeout = DEFAULT_TIMEOUT_SECONDS

    return {
        "enabled": bool(enabled),
        # 启用但没端点 ⇒ 视为关闭（**不猜**默认端点）。
        "endpoint": endpoint,
        "credential": credential or None,
        "timeoutSeconds": timeout,
        "client": str(raw.get("client") or ""),
    }


def _urlopen(url: str, data: bytes, headers: dict, timeout: float):
    """真实 HTTP POST —— **模块级**，便于测试注入（本模块是传输本体，允许用网络库）。"""
    import urllib.request  # 局部导入：本模块是传输层，构造时才引入网络栈

    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    return urllib.request.urlopen(request, timeout=timeout)  # noqa: S310 - 端点来自受信配置


def _classify_status(status: int) -> tuple[bool, bool]:
    """`(ok, retryable)`。见 `_RETRYABLE_STATUS` 上的口径表。"""
    if 200 <= status < 300:
        return True, False
    if status in _RETRYABLE_STATUS or status >= 500:
        return False, True
    return False, False


def make_http_transport(endpoint: str, *, credential: Optional[str] = None,
                        timeout: float = DEFAULT_TIMEOUT_SECONDS) -> Transmission:
    """造一个把单元 `POST` 到 `endpoint` 的传输（Bearer＝`credential`）。

    返回的 callable 形如 `transport(unit) -> {"ok": bool, "retryable": bool, "note": str}`：
      * 2xx ⇒ `{"ok": True}`；
      * 暂态（408/425/429/5xx/网络） ⇒ `{"ok": False, "retryable": True, "note": …}`（**保留**待补齐）；
      * 永久（其余 4xx） ⇒ `{"ok": False, "retryable": False, "note": …}`（**保留**、记录，**绝不丢**）。
    `note` 只带状态码/异常类型名，**绝不**回显凭据或请求体。
    """

    def transport(unit: dict) -> dict:
        if not isinstance(unit, dict):  # pragma: no cover - guard
            return {"ok": False, "retryable": False, "note": "unit-not-an-object"}
        try:
            body = json.dumps(unit, ensure_ascii=False).encode("utf-8")
        except Exception:  # pragma: no cover - 不应发生（上游已扫描可序列化）
            return {"ok": False, "retryable": False, "note": "unit-not-serializable"}
        headers = {"Content-Type": "application/json"}
        if credential:
            headers["Authorization"] = f"Bearer {credential}"
        try:
            with _urlopen(endpoint, body, headers, float(timeout)) as response:
                status = int(getattr(response, "status", 0) or 0)
                # 读掉响应体，释放连接；不解析、不回显。
                try:
                    response.read()
                except Exception:  # pragma: no cover - 环境相关
                    pass
        except Exception as exc:  # URLError / timeout / whatever: 一律暂态
            # 只带**异常类型名**（不回显 message：message 可能含 URL/凭据片段）。
            return {"ok": False, "retryable": True, "note": f"transport-error:{type(exc).__name__}"}
        ok, retryable = _classify_status(status)
        if ok:
            return {"ok": True}
        return {"ok": False, "retryable": retryable, "note": f"http-{status}"}

    return transport


def build_transport(home: Optional[Path] = None) -> Optional[Transmission]:
    """按配置造传输；**默认返回 `None`（＝无传输，安全态）**。

    `None` 的三种来源（都**不该**外发）：未启用 `enabled:false`（默认）、配置读不到/读坏、
    启用但端点为空。宿主拿到 `None` ⇒ `audit_egress.flush(None)` fail-closed 拒 `no-transport`。
    """
    config = load_transport_config(home)
    if not config["enabled"] or not config["endpoint"]:
        return None
    return make_http_transport(
        config["endpoint"],
        credential=config["credential"],
        timeout=config["timeoutSeconds"],
    )


def describe_transport(home: Optional[Path] = None) -> dict:
    """**可诊断**的传输状态（供只读可见面）——**不含凭据**、**不含完整端点**。

    端点只回 **host 是否存在**（`endpointConfigured`），不回原值：审计出口的配置本身
    也不该经 UI/报告扩散。凭据永远只回 `credentialConfigured: bool`。
    """
    config = load_transport_config(home)
    return {
        "enabled": bool(config["enabled"] and config["endpoint"]),
        "endpointConfigured": bool(config["endpoint"]),
        "credentialConfigured": bool(config["credential"]),
        "timeoutSeconds": config["timeoutSeconds"],
        # 默认安全态：未配置 ⇒ 无传输（不发真实数据）。
        "mode": "http" if (config["enabled"] and config["endpoint"]) else "no-transport",
    }
