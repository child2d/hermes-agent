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
  * **端点只来自配置**（企业 home 内 `<home>/plankton-enterprise/audit-egress.json`），
    **绝不**在源码里写死 URL；**不进包**（配置不进产物）、**不入报告**。
  * **凭据在发送时解析、来源可多处**（见下）：环境变量 → 配置 `credential` → **运行时从 CLI
    token 存储读**。**绝不缓存静态度量过的过期值**；过期时走 **CLI 自带刷新**（不自实现 OAuth），
    刷新后**至多重试本次发送一次**。读不到凭据 ⇒ **fail-closed**（**绝不**发匿名请求），并如实归
    **可重试类**（**不再**归 `permanent`、**不丢单元**）。
  * **凭据不落日志**：只用于 `Authorization` 头；任何返回/日志/异常文案都**不回显**它。
  * **不写个人 `~/.hermes`**：配置只在**企业 home** 内读；读不到就当作「未启用」。
    本模块读取的 `~/.shaoke/tokens.json` 是 **shaoke-cli 自己的 token 存储**（**不是**会话/配置
    home）；此放宽**仅限**该 CLI token 存储，**不得**外推到别处。
  * **归因不出客户端**：请求体就是 `audit_unit` 产出的上送段（`human` 恒空），本模块不改它。

凭据来源与解析顺序（**发送时**求值，不缓存）：

  ① 环境变量 `PLANKTON_AUDIT_EGRESS_CREDENTIAL`（一次性本地验证/CI 的最高优先覆盖）；
  ② 配置 `credential`（企业 home 内配置；保留作**测试/逃逸口**）；
  ③ **运行时**读 CLI token 存储 `~/.shaoke/tokens.json` 的 `auth.access_token`
     （与 `/cli/audit` 同款飞书用户 token，**有 TTL**）。已过期 ⇒ 触发 CLI 自带刷新路径
     （`shaoke-cli` 的 `internal/auth.TryRefreshToken`，借一条需凭据的命令触发并回写 token 存储），
     刷新后**重读**；仍不可用 ⇒ 无凭据（fail-closed、可重试）。

配置形状（`audit-egress.json`，全部可选）：

    {
      "enabled": true,                     // 缺省 false ⇒ 关闭
      "endpoint": "…/plankton/audit",      // 中心接收端点；缺省空 ⇒ 关闭（不是猜一个默认）
      "credential": "…",                   // Bearer 值；缺省则退回运行时解析（见上）
      "timeoutSeconds": 15,                // 缺省 15
      "client": "plankton-desktop"         // 仅作审计元数据，随体上送（可缺省）
    }
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

#: 传输契约（与 `audit_egress.Transmission` **同一个**）：`transport(unit) -> {"ok": bool, …}`。
Transmission = Callable[[dict], dict]

#: 配置文件名（企业 home 内 `<home>/plankton-enterprise/` 下）。
CONFIG_DIRNAME = "plankton-enterprise"
CONFIG_FILENAME = "audit-egress.json"

#: 凭据覆盖用的环境变量（便于 CI/一次性本地验证；**最高优先**，但**不是**唯一来源）。
CREDENTIAL_ENV = "PLANKTON_AUDIT_EGRESS_CREDENTIAL"
#: 端点覆盖用的环境变量（同上）。
ENDPOINT_ENV = "PLANKTON_AUDIT_EGRESS_ENDPOINT"

#: **CLI token 存储**落点的覆盖变量 —— 缺省＝`~/.shaoke/tokens.json`。
#: 该文件是 **shaoke-cli 自己的凭据库**（**不是**会话/配置 home）；单独变量便于测试隔离，
#: 也让「凭据不缓存、发送时求值」可被机器钉住。**不得**指向任何 `~/.hermes` 内的路径。
TOKEN_STORE_ENV = "PLANKTON_AUDIT_EGRESS_TOKEN_STORE"
#: 触发 **CLI 自带刷新**的可执行文件名/路径（覆盖便于测试；缺省取 PATH 上的 `shaoke-cli`）。
CLI_BIN_ENV = "PLANKTON_AUDIT_EGRESS_CLI"
DEFAULT_CLI_BIN = "shaoke-cli"
#: 触发刷新的命令：任何**需要凭据**的 CLI 命令在令牌过期时都会走 `auth.TryRefreshToken`
#: 并回写 token 存储；`--dry-run` 保证不真正执行该命令的业务请求（只借它触发刷新）。
#: **不自实现 OAuth**（红线）：刷新口径完全归 CLI。
REFRESH_COMMAND = ("kd", "+health", "--dry-run")
#: 刷新子进程超时（秒）。超时/失败 ⇒ 如实归可重试（不丢单元）。
REFRESH_TIMEOUT_SECONDS = 20.0

DEFAULT_TIMEOUT_SECONDS = 15

#: 传输结果 kinds（闭集语义，与 `audit_egress` 一致）：`ok` / `retryable` / `permanent`。
#: HTTP 状态 → 语义映射的口径（写死在此，供测试逐条核对）：
#:   * 2xx               ⇒ ok（服务端按幂等键收纳）
#:   * 401               ⇒ retryable（**凭据可经 CLI 刷新恢复**；归 permanent 会让出口静默停摆）
#:   * 408 / 425 / 429   ⇒ retryable（暂态）
#:   * 5xx               ⇒ retryable（服务端暂不可用）
#:   * 其余 4xx          ⇒ permanent（入参问题，重试无意义）
_RETRYABLE_STATUS = frozenset({401, 408, 425, 429})


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
    配置坏了绝不能变成「偷偷启用」。凭据字段的口径＝**静态覆盖**（环境变量优先于配置，
    与 `resolve_credential` 的来源顺序一致）；缺省 ⇒ `None`（退回**发送时运行时解析**）。
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
    credential = (os.environ.get(CREDENTIAL_ENV) or "").strip() or str(raw.get("credential") or "").strip()
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


# ─────────────────────────────────────────────────────────────────────────────
# 凭据：**发送时运行时解析**（环境变量 → 配置 → CLI token 存储）＋ CLI 刷新
# ─────────────────────────────────────────────────────────────────────────────


def token_store_path() -> Path:
    """CLI token 存储落点（**shaoke-cli 自己的凭据库**，缺省 `~/.shaoke/tokens.json`）。

    **不是**会话/配置 home；可由 `PLANKTON_AUDIT_EGRESS_TOKEN_STORE` 覆盖（测试隔离/一次性验证）。
    """
    override = (os.environ.get(TOKEN_STORE_ENV) or "").strip()
    if override:
        return Path(override).expanduser()
    return Path(os.path.expanduser("~")) / ".shaoke" / "tokens.json"


def _parse_expiry(raw: Any) -> Optional[float]:
    """把 `expires_at`（ISO8601）解析成 epoch 秒；缺/坏 ⇒ `None`（**不**据此判过期）。"""
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def read_cli_token() -> dict:
    """**只读** CLI token 存储（**永不抛**）。返回 `{"token": str|None, "expiresAt": float|None}`。

    **绝不**回显 token 值；读不到/读坏/形状不对 ⇒ `{"token": None, "expiresAt": None}`。
    """
    path = token_store_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"token": None, "expiresAt": None}
    auth = data.get("auth") if isinstance(data, dict) else None
    if not isinstance(auth, dict):
        return {"token": None, "expiresAt": None}
    token = str(auth.get("access_token") or "").strip()
    return {"token": token or None, "expiresAt": _parse_expiry(auth.get("expires_at"))}


def _token_expired(expires_at: Optional[float], now: Optional[float] = None) -> bool:
    """到期判定。无到期信息 ⇒ 视为**未过期**（用起来，服务端 401 会再兜）。"""
    if expires_at is None:
        return False
    return (time.time() if now is None else float(now)) >= float(expires_at)


def refresh_cli_token() -> bool:
    """经 **CLI 自带刷新路径**刷新（**不自实现 OAuth**）。返回是否成功**触发**了刷新进程。

    触发后由调用方**重读** token 存储判定是否真的刷新成功 —— 不解析子进程输出
    （输出可能含端点片段；**绝不**回显令牌）。刷新不可用（CLI 缺失/超时）⇒ `False`。
    """
    binary = (os.environ.get(CLI_BIN_ENV) or "").strip() or DEFAULT_CLI_BIN
    try:
        subprocess.run(  # noqa: S603 - 固定 argv、固定二进制（可覆盖）、无 shell
            [binary, *REFRESH_COMMAND],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=REFRESH_TIMEOUT_SECONDS,
            check=False,
        )
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def resolve_credential(home: Optional[Path] = None, *, allow_refresh: bool = True) -> dict:
    """**发送时**解析凭据（**不缓存过期值**）。来源顺序：环境变量 → 配置 → CLI token 存储。

    返回 `{"credential": str|None, "source": str|None, "refreshed": bool, "reason": str|None}`。
    `credential is None` ⇒ **无凭据**（调用方据此 **fail-closed**：**绝不**发匿名请求）。
    `reason` 只带**类别**（如 `no-cli-token` / `cli-token-refresh-failed`），**绝不**回显凭据值。

    `allow_refresh=False` ⇒ **只读**（不触发刷新，供 `describe_transport` 等只读面使用）。
    """
    env_cred = (os.environ.get(CREDENTIAL_ENV) or "").strip()
    if env_cred:
        return {"credential": env_cred, "source": "env", "refreshed": False, "reason": None}

    config = load_transport_config(home)
    cfg_cred = config.get("credential")
    if isinstance(cfg_cred, str) and cfg_cred.strip():
        return {"credential": cfg_cred.strip(), "source": "config", "refreshed": False, "reason": None}

    current = read_cli_token()
    if current["token"] and not _token_expired(current["expiresAt"]):
        return {"credential": current["token"], "source": "cli-token-store",
                "refreshed": False, "reason": None}
    if not current["token"]:
        return {"credential": None, "source": None,
                "refreshed": False, "reason": "no-cli-token"}
    if not allow_refresh:
        return {"credential": None, "source": None,
                "refreshed": False, "reason": "cli-token-expired"}

    # 有 token 但已过期 ⇒ 走 CLI 自带刷新路径；刷新后**重读**（不缓存过期值）。
    triggered = refresh_cli_token()
    after = read_cli_token()
    if after["token"] and not _token_expired(after["expiresAt"]):
        return {"credential": after["token"], "source": "cli-token-store",
                "refreshed": True, "reason": None}
    return {
        "credential": None,
        "source": None,
        "refreshed": False,
        "reason": "cli-token-refresh-failed" if triggered else "cli-refresh-unavailable",
    }


def _resolve_for_send(credential: Optional[str], provider: Optional[Callable[[], dict]]) -> dict:
    """发送时的凭据取值：静态 `credential` 优先，否则调用 `provider()`（运行时解析）。"""
    if credential:
        return {"credential": credential, "source": "static", "refreshed": False, "reason": None}
    if provider is not None:
        try:
            resolved = provider()
        except Exception as exc:  # 解析器异常 ⇒ 当作无凭据（fail-closed），只带类型名
            return {"credential": None, "source": None, "refreshed": False,
                    "reason": f"resolver-error:{type(exc).__name__}"}
        return resolved if isinstance(resolved, dict) else {
            "credential": None, "source": None, "refreshed": False, "reason": "resolver-bad-result"}
    return {"credential": None, "source": None, "refreshed": False, "reason": "no-credential-source"}


def _post(endpoint: str, body: bytes, headers: dict, timeout: float) -> tuple[Optional[int], Optional[str]]:
    """发一次 POST，返回 `(status, note)`。

    **非 2xx 必须把状态码带出来**：`urllib` 对 4xx/5xx 抛 `HTTPError`，若不一并捕获，
    `_classify_status`（含 401 的「可刷新」判定与 401→刷新重试分支）在真实客户端下**永不可达** ⇒
    又变成「表在、逻辑不在」。故显式解出 `HTTPError.code` 当状态码。
    网络/协议异常 ⇒ `(None, note)`（只带异常类型名，**绝不**回显 message）。
    """
    import urllib.error  # 局部导入：与 `_urlopen` 同栈

    try:
        with _urlopen(endpoint, body, headers, float(timeout)) as response:
            status = int(getattr(response, "status", 0) or 0)
            # 读掉响应体，释放连接；不解析、不回显。
            try:
                response.read()
            except Exception:  # pragma: no cover - 环境相关
                pass
            return status, None
    except urllib.error.HTTPError as exc:
        # 4xx/5xx：urlopen 以异常形式抛出 —— 取出状态码交给 `_classify_status`（保持口径表有效）。
        try:
            exc.read()
        except Exception:  # pragma: no cover - 环境相关
            pass
        try:
            return int(exc.code), None
        except (TypeError, ValueError):  # pragma: no cover - 防御
            return None, "transport-error:HTTPError"
    except Exception as exc:  # URLError / timeout / whatever: 一律暂态
        # 只带**异常类型名**（不回显 message：message 可能含 URL/凭据片段）。
        return None, f"transport-error:{type(exc).__name__}"


def make_http_transport(
    endpoint: str,
    *,
    credential: Optional[str] = None,
    credential_provider: Optional[Callable[[], dict]] = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> Transmission:
    """造一个把单元 `POST` 到 `endpoint` 的传输（Bearer＝**发送时**解析出的凭据）。

    `credential`：**静态**凭据（配置/测试逃逸口），给出即用；
    `credential_provider`：**发送时**调用的解析器（`resolve_credential` 结果），凭据**不缓存**。

    返回的 callable 形如 `transport(unit) -> {"ok": bool, "retryable": bool, "note": str}`：
      * 2xx ⇒ `{"ok": True}`；
      * **无凭据** ⇒ `{"ok": False, "retryable": True, "note": "no-credential:…"}` —— **不发匿名请求**（fail-closed）；
      * **凭据被拒（401）** ⇒ 走 CLI 刷新后**至多重试一次**；仍不行 ⇒ `retryable: True`（**不再**归 `permanent`）；
      * 其余暂态（408/425/429/5xx/网络） ⇒ `{"ok": False, "retryable": True, "note": …}`（**保留**待补齐）；
      * 永久（其余 4xx） ⇒ `{"ok": False, "retryable": False, "note": …}`（**保留**、记录，**绝不丢**）。
    `note` 只带状态码/异常类型名/凭据来源类别，**绝不**回显凭据或请求体。
    """

    def transport(unit: dict) -> dict:
        if not isinstance(unit, dict):  # pragma: no cover - guard
            return {"ok": False, "retryable": False, "note": "unit-not-an-object"}
        try:
            body = json.dumps(unit, ensure_ascii=False).encode("utf-8")
        except Exception:  # pragma: no cover - 不应发生（上游已扫描可序列化）
            return {"ok": False, "retryable": False, "note": "unit-not-serializable"}

        resolution = _resolve_for_send(credential, credential_provider)
        cred = resolution.get("credential")
        if not cred:
            # fail-closed：无凭据 ⇒ **绝不**发匿名请求；如实归**可重试类**（补凭据/刷新后可再试），不丢单元。
            return {"ok": False, "retryable": True,
                    "note": "no-credential:" + str(resolution.get("reason") or "unavailable")}

        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {cred}"}
        status, error = _post(endpoint, body, headers, float(timeout))
        if status is None:
            return {"ok": False, "retryable": True, "note": error}
        if 200 <= status < 300:
            return {"ok": True}

        # 凭据被服务端拒（401）：可能刚刚过期 —— 走 CLI 刷新路径，**本次发送至多重试一次**（不循环）。
        if status == 401 and credential_provider is not None:
            if refresh_cli_token():
                retry_res = credential_provider()
                cred2 = retry_res.get("credential") if isinstance(retry_res, dict) else None
                if cred2 and cred2 != cred:
                    status2, error2 = _post(
                        endpoint, body,
                        {"Content-Type": "application/json", "Authorization": f"Bearer {cred2}"},
                        float(timeout),
                    )
                    if status2 is None:
                        return {"ok": False, "retryable": True, "note": error2}
                    if 200 <= status2 < 300:
                        return {"ok": True}
                    status = status2
            # 刷新不可用/失败/重试后仍失败 ⇒ **可重试类**（不得归 permanent、不得丢单元）。
            return {"ok": False, "retryable": True, "note": f"http-{status}"}

        ok, retryable = _classify_status(status)
        if ok:
            return {"ok": True}
        return {"ok": False, "retryable": retryable, "note": f"http-{status}"}

    return transport


def build_transport(home: Optional[Path] = None) -> Optional[Transmission]:
    """按配置造传输；**默认返回 `None`（＝无传输，安全态）**。

    `None` 的三种来源（都**不该**外发）：未启用 `enabled:false`（默认）、配置读不到/读坏、
    启用但端点为空。宿主拿到 `None` ⇒ `audit_egress.flush(None)` fail-closed 拒 `no-transport`。

    启用后，**凭据在发送时解析**：环境变量 → 配置 `credential` → 运行时读 CLI token 存储；
    过期时走 **CLI 自带刷新**（至多重试一次），读不到 ⇒ fail-closed + 可重试（见 `resolve_credential`）。
    """
    config = load_transport_config(home)
    if not config["enabled"] or not config["endpoint"]:
        return None
    static = config["credential"]

    def _provider() -> dict:
        return resolve_credential(home)

    return make_http_transport(
        config["endpoint"],
        credential=static,
        # 静态凭据（配置/环境）在时不再运行时解析；否则**每次发送**解析（含过期刷新）。
        credential_provider=None if static else _provider,
        timeout=config["timeoutSeconds"],
    )


def describe_transport(home: Optional[Path] = None) -> dict:
    """**可诊断**的传输状态（供只读可见面）——**不含凭据**、**不含完整端点**。

    端点只回 **host 是否存在**（`endpointConfigured`），不回原值：审计出口的配置本身
    也不该经 UI/报告扩散。凭据永远只回 `credentialConfigured: bool` + `credentialSource`（**类别**）。
    `allow_refresh=False`：只读面**绝不**触发刷新（不在读路径上产生副作用）。
    """
    config = load_transport_config(home)
    resolution = resolve_credential(home, allow_refresh=False)
    return {
        "enabled": bool(config["enabled"] and config["endpoint"]),
        "endpointConfigured": bool(config["endpoint"]),
        "credentialConfigured": bool(resolution.get("credential")),
        "credentialSource": resolution.get("source"),
        "timeoutSeconds": config["timeoutSeconds"],
        # 默认安全态：未配置 ⇒ 无传输（不发真实数据）。
        "mode": "http" if (config["enabled"] and config["endpoint"]) else "no-transport",
    }
