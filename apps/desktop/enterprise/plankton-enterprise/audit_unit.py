"""plankton-enterprise — **会话级审计单元生产者**（批 4 · W1）。

设计为准（逐字）：`docs/plankton/N7-technical-design/N7-20261007-plankton-audit-egress.md`
**§8 W1**「会话级审计单元组装」＋ **§2**「审计单元与素材 / 上传字段 schema（客户端上送段）」＋ **§9.0** 不变量；
需求：`docs/plankton/N2-requirements/N2-20261007-plankton-audit-egress.md` PLK-REQ-0041~0049。

本模块只做三件事（**W1 的全部交付**）：

  ① **会话级单元组装**（§8 W1 / PLK-REQ-0041/0042/0049）：把某会话的**全部聊天记录**（用户/助手往复，
     按时间序、非摘要、非抽样）＋ **元数据**（时间/项目/版本/client）＋ **唯一 id** 组成为**一个**审计单元；
     粒度 = **会话级**（一会话一单元），**不**退化为动作级/消息级事件。
  ② **两方字段**（§2 schema 的**客户端上送段**）：
     * **人这一方（authoritative）**：`human.auth_user_id` 在上送里**恒为 `None`** ——
       **客户端只能上送空值、服务端盖章**（§2：「`human` 段＝服务端盖章、客户端送值一律忽略」；
       PLK-REQ-0042：「客户端 SHALL NOT 通过任何参数/字段/自报来提供或覆盖该值」）。本模块**没有任何入口**
       能从输入里取人方身份；`human` 段由本模块**最后写死**，即使调用方塞了同名字段也无法覆盖。
     * **agent 这一方（non-authoritative）**：`agent.{profileName, profileId, variant, engineVersion}`
       ＋ 每个 agent 单元**显式** `authoritative:false` / `note:"self-reported"`（PLK-REQ-0049）。
       **profile 内容（`AGENT.md` 等）不上传、不管控**——本模块没有承载 profile 内容的字段，
       且对 inputs/单元做**内容位点扫描**：出现 `profileContent`/`agentMd`/`systemPrompt` 一类键即**拒**。
  ③ **应用发稳定 `profileId`**（PLK-REQ-0049 / §8 W1）：企业 home **首次纳管**为该 profile 生成并在
     **企业 home 内持久化**；同一 profile 后续**复用同一 ID**。键是 profile 的**稳定身份**（其 home 目录），
     **SHALL NOT 依赖 profile 名字**（名字会变、会重名）——`profileName` 只作为一个可变的**自报标签**寄存。

约束（本包**不做**的，红线）：
  * **不上传、不发网络请求**：本模块**零网络、零 subprocess**，只产**单元（dict）**，**不发送**（上传＝W2）。
  * **不落令牌/密钥**：写入前复用引擎原生脱敏口径（`agent.redact.redact_sensitive_text`，即
    `hermes_logging.RedactingFormatter` 背后的同一实现，§2 脱敏）＋ 预签名 URL / JWT / Bearer /
    不透明令牌 / AWS access key 的**独立**兜底清洗；组装后对整单元做**字段名与值**的密钥扫描，
    **命中即拒**（宁可拒不产）。P2-2 补的**定向云密钥**（Azure `AccountKey=`/SAS、裸 AWS
    secret key 形态、GCP/通用 PEM 私钥、带密码的连接串 `scheme://user:pw@host`）走**检测即拒**
    而非静默改写——刻意**不**用通用高熵启发式（那会误伤正常文本）。
  * **不另存工具载荷原文**（文件内容/命令全文/审批 diff）：单元里没有这种字段；工具输出**片段**若本就在
    助手消息正文中，则**随会话完整保留（不剔除）**（§9.0 #15，本期已裁）。

素材来源（只读）：引擎会话事实库 `state.db` 的 `messages` 表（`hermes_state_common.py:448`）——
`read_session_chat()` 以 **`mode=ro` 只读**打开，按 `timestamp, id` 序取该会话的 user/assistant 记录。

这是本模块**唯一**会触盘的两处：读 `state.db`（只读）与读写企业 home 里的 profile-id 台账；别处皆纯逻辑。
"""

from __future__ import annotations

import logging
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

try:  # POSIX 文件锁（同机跨进程串行 profile-id 台账的读改写）；非 POSIX 仅有线程锁。
    import fcntl  # type: ignore
except ImportError:  # pragma: no cover - 非 POSIX 平台
    fcntl = None  # type: ignore

logger = logging.getLogger(__name__)

# ── 口径常量（drift-locked 到 N7 §2 / §9.0） ──────────────────────────────────

#: 幂等键前缀（§3：`session_audit_id` 由应用基于会话稳定标识确定性派生，本设计取 `plankton:<引擎会话 id>`）。
AUDIT_KEY_PREFIX = "plankton"

#: 聊天记录的角色集合：**人**（user）与**助手**（assistant）的往复（N7 §0「用户与助手往复对话」）。
CHAT_ROLES = ("user", "assistant")

#: agent 侧每个字段的显式标注（PLK-REQ-0049：全部标 self-reported / non-authoritative）。
AGENT_NOTE = "self-reported"

#: client 口径（D-5：审计记录带 client 口径）——本产品即 desktop 客户端。
AUDIT_CLIENT_ID = "plankton-desktop"

#: profile-id 台账文件版本。
PROFILE_ID_STORE_VERSION = 1

#: profile-id 的形状前缀 —— 便于一眼看出「这是应用发的稳定 ID」而非任何身份。
PROFILE_ID_PREFIX = "pid_"


class AuditUnitRefused(Exception):
    """组装被拒（typed）。调用方把它落成 `{"kind": "rejected", "note": …}`。

    拒而不是产：审计单元要么干净、要么不产——一条带密钥/带自报身份/带 profile 内容的单元
    一旦上传就不可撤回（§4「可信上限」以企业服务器为权威）。
    """

    def __init__(self, note: str):
        super().__init__(note)
        self.note = note


# ── 密钥清洗：引擎原生脱敏 + 预签名 URL / 云密钥兜底 ─────────────────────────
#
# §2 脱敏口径＝复用原生 `RedactingFormatter` 背后的 `agent.redact.redact_sensitive_text`
# （`hermes_logging.py:365` 就是 `from agent.redact import RedactingFormatter`）。引擎不可导入时
# （单元测试/裸进程）退回本模块的保守清洗——绝不因为「引擎不在」就放原文过去。

#: 预签名 URL / 查询串里的签名与凭据参数（S3 / GCS / 通用 sig）。
_PRESIGNED_QUERY_RE = re.compile(
    r"([?&])("
    r"X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Amz-Algorithm|X-Amz-Date|"
    r"X-Goog-Signature|X-Goog-Credential|X-Goog-Security-Token|"
    r"Signature|sig|access_token|id_token|refresh_token|api_?key|apikey|client_secret|token"
    r")=([^&\s\"'<>]+)",
    re.IGNORECASE,
)
#: 不透明凭据前缀（OpenAI/Stripe 风格 `sk-…` / `pk-…` / `rk-…`）。
_OPAQUE_TOKEN_RE = re.compile(r"\b(?:sk|rk|pk)-[A-Za-z0-9_\-]{16,}\b")
#: JWT（header.payload.signature，base64url）。
_JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{4,}\b")
#: Authorization 头。
_BEARER_RE = re.compile(r"\b(?:Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{12,}", re.IGNORECASE)
#: AWS access key id / GitHub token。
_AWS_KEY_RE = re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")
_GH_TOKEN_RE = re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")

# ── 定向云密钥模式（补 P2-2；**刻意不用通用高熵启发式**，以免误伤正常文本） ──────
# 这些是**检测**模式（进 `_SECRET_VALUE_RES`，命中即拒），不是「悄悄改写」模式：
# §2「宁可拒不产」——一条带云密钥的会话单元一旦上传不可撤回，故 fail-closed 拒整单元。

#: Azure 存储连接串 / SAS 的密钥参数（`AccountKey=` / `SharedAccessKey=` / `SharedAccessSignature=`）。
_AZURE_KEY_RE = re.compile(
    r"\b(?:AccountKey|SharedAccessKey|SharedAccessSignature)\s*=\s*[A-Za-z0-9+/=%]{16,}",
    re.IGNORECASE,
)
#: 裸 AWS secret access key：40 位 base64，且**含大写或 `/`,`+`**（排除全小写 hex，如 git sha；
#: 真 AWS secret 是 30 随机字节的 base64，几乎必含大写/符号，故该约束既不漏真也不误伤常见文本）。
_AWS_SECRET_RE = re.compile(
    r"(?<![A-Za-z0-9/+=])"
    r"(?=[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=]))"
    r"(?=[A-Za-z0-9/+=]{0,39}[A-Z/+])"
    r"[A-Za-z0-9/+=]{40}"
)
#: GCP 服务账号 / 通用 PEM 私钥块（`-----BEGIN … PRIVATE KEY-----`）。
_PEM_RE = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")
#: 带密码的连接串（`scheme://user:password@host`）——postgres/mysql/mongo/redis/amqp/https 等。
_DB_URI_RE = re.compile(r"\b[a-z][a-z0-9+.\-]{1,}://[^\s:@/]+:[^\s@/]{2,}@[^\s]+", re.IGNORECASE)

#: **字段名**层面的密钥词（比对单元结构的键，不是正文）。
#: 刻意不含裸 `auth`（不然 schema 自己的 `human.auth_user_id` 会被误判）。
_SECRET_NAME_RE = re.compile(
    r"(token|secret|passwd|password|api[_-]?key|apikey|credential|authorization|bearer|"
    r"private[_-]?key|access[_-]?key|session[_-]?key|cookie|presign)",
    re.IGNORECASE,
)

#: **不得进入单元**的 profile-内容类键（PLK-REQ-0049：profile 内容不上传）。
_FORBIDDEN_CONTENT_KEYS = frozenset(
    {
        "profilecontent",
        "profile_content",
        "agentmd",
        "agent_md",
        "agentsmd",
        "systemprompt",
        "system_prompt",
        "soulmd",
        "soul_md",
    }
)

#: 命中即拒的密钥**值**正则（字段名另有 `_SECRET_NAME_RE`）。
_SECRET_VALUE_RES = (
    _PRESIGNED_QUERY_RE,
    _OPAQUE_TOKEN_RE,
    _JWT_RE,
    _BEARER_RE,
    _AWS_KEY_RE,
    _GH_TOKEN_RE,
    # 定向云密钥（P2-2）：Azure 连接串 / 裸 AWS secret / PEM 私钥 / 带密码连接串。
    _AZURE_KEY_RE,
    _AWS_SECRET_RE,
    _PEM_RE,
    _DB_URI_RE,
)


def redact_text(text: Any) -> str:
    """按原生口径清洗一段文本；引擎不可用时退回本模块兜底。永远返回 str。"""
    if text is None:
        return ""
    raw = text if isinstance(text, str) else str(text)
    if not raw:
        return ""
    out = raw
    try:  # 引擎原生脱敏（RedactingFormatter 的同一实现）；force 掉「会话已关脱敏」的开关。
        from agent.redact import redact_sensitive_text  # type: ignore

        out = redact_sensitive_text(out, force=True)
    except Exception:  # pragma: no cover - 引擎不可导入（裸进程）时走兜底
        pass
    out = _PRESIGNED_QUERY_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}=[REDACTED]", out)
    out = _JWT_RE.sub("[REDACTED]", out)
    out = _BEARER_RE.sub(lambda m: f"{m.group(0).split()[0]} [REDACTED]", out)
    out = _OPAQUE_TOKEN_RE.sub("[REDACTED]", out)
    out = _AWS_KEY_RE.sub("[REDACTED]", out)
    out = _GH_TOKEN_RE.sub("[REDACTED]", out)
    return out


def _secret_value_note(value: str, path: str) -> Optional[str]:
    for pattern in _SECRET_VALUE_RES:
        matched = pattern.search(value)
        if matched and "[REDACTED]" not in matched.group(0):
            return f"secret-in-unit:{path}"
    return None


def audit_hygiene_problem(unit: Any, _path: str = "") -> Optional[str]:
    """递归扫描**字段名与值**：命中密钥词/密钥值/profile 内容键 ⇒ 返回 note，否则 None。

    这是产单元前的**最后一道闸**（宁可拒不产）：脱敏若漏了一个形状，这里必须红。
    """
    if isinstance(unit, dict):
        for key, value in unit.items():
            name = str(key)
            lowered = name.strip().lower()
            here = f"{_path}.{name}" if _path else name
            if lowered in _FORBIDDEN_CONTENT_KEYS:
                return f"profile-content-not-allowed:{here}"
            if _SECRET_NAME_RE.search(name):
                return f"secret-field-name:{here}"
            problem = audit_hygiene_problem(value, here)
            if problem:
                return problem
        return None
    if isinstance(unit, list):
        for index, item in enumerate(unit):
            problem = audit_hygiene_problem(item, f"{_path}[{index}]")
            if problem:
                return problem
        return None
    if isinstance(unit, str):
        return _secret_value_note(unit, _path or "<value>")
    return None


# ── ① 幂等键：确定性派生（§3 / PLK-REQ-0043） ────────────────────────────────


def derive_session_audit_id(engine_session_id: Any) -> str:
    """**确定性**派生幂等键：`plankton:<引擎会话 id>`（§3）。

    「同一会话的任意次重试/断网补齐都派生同一值，无需额外状态；粒度＝会话级 ⇒ 一会话一单元一键。
     **SHALL NOT** 每次上传重新生成随机 id（否则重试变成新记录、幂等失效）」。

    本函数**只**做字符串拼接：不读时间、不用随机、不用 uuid、不查库——同一输入恒等值。
    """
    sid = str(engine_session_id or "").strip()
    if not sid:
        raise AuditUnitRefused("engine-session-id-required")
    return f"{AUDIT_KEY_PREFIX}:{sid}"


# ── 单元组装（纯逻辑：无网络、无上传、无 subprocess） ─────────────────────────


def _iso8601(now: Optional[float] = None) -> str:
    stamp = time.time() if now is None else float(now)
    return datetime.fromtimestamp(stamp, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_transcript(messages: Iterable[Any]) -> list:
    """把该会话**全部**聊天记录按输入序组为 transcript（**不抽样、不摘要、不截断**）。

    只取 `user`/`assistant` 两类角色（聊天记录＝人与助手的往复；N7 §0）。每条内容走脱敏；
    非聊天角色（tool/system）不是一条聊天记录，不另立审计事件（会话级、非动作级）；
    工具输出**片段**若本就在助手正文里，随正文**完整保留（不剔除）**。
    """
    transcript = []
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").strip().lower()
        if role not in CHAT_ROLES:
            continue
        transcript.append({"role": role, "content": redact_text(message.get("content"))})
    return transcript


def assemble_audit_unit(
    *,
    engine_session_id: Any,
    messages: Iterable[Any],
    profile_name: Any = "",
    profile_id: Any = "",
    variant: Any = "",
    engine_version: Any = "",
    project: Any = "",
    client: Any = AUDIT_CLIENT_ID,
    app_version: Any = "",
    created_at: Optional[str] = None,
    now: Optional[float] = None,
) -> dict:
    """组出**一个**会话级审计单元（N7 §2(a) 的**客户端上送段**）。

    纯逻辑：入参即全部输入，产出即一个 dict；**不发任何网络请求、不写任何文件**（上传＝W2）。

    硬约束（承重，见 pytest 中的反证）：
      * `session_audit_id` = `derive_session_audit_id(engine_session_id)`（确定性）；
      * `human.auth_user_id` **恒 `None`** —— 本函数**没有**人方身份入参；`human` 段在**最后**写死，
        调用方无法以任何键覆盖（客户端只能送空值，服务端盖章）；
      * `agent` 段**全部**标 `authoritative:false` / `note:"self-reported"`；
      * `transcript` = 全部聊天记录（按序、非摘要、非抽样）；
      * 组完做**单元卫生扫描**（字段名与值），命中密钥/预签名 URL/profile 内容键 ⇒ `AuditUnitRefused`。
    """
    key = derive_session_audit_id(engine_session_id)
    unit = {
        "session_audit_id": key,
        "created_at": created_at or _iso8601(now),
        # 人这一方：**服务端盖章**（authoritative）。上送段恒为空——客户端能做的只有「送空」。
        "human": {"auth_user_id": None},
        # agent 这一方：**客户端自报的上下文标签**，全 non-authoritative（绝非身份）。
        "agent": {
            "profileName": redact_text(profile_name),
            "profileId": redact_text(profile_id),
            "variant": redact_text(variant),
            "engineVersion": redact_text(engine_version),
            "authoritative": False,
            "note": AGENT_NOTE,
        },
        "project": redact_text(project),
        "client": redact_text(client),
        "appVersion": redact_text(app_version),
        "transcript": build_transcript(messages),
    }
    # 写死不变量（防未来重构把 human 从入参带进来）：人方永不来自客户端。
    unit["human"] = {"auth_user_id": None}

    problem = audit_hygiene_problem(unit)
    if problem:
        raise AuditUnitRefused(problem)
    return unit


# ── ③ 应用发稳定 profileId：企业 home 首次纳管生成并持久化（PLK-REQ-0049） ────


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


def profile_id_store_path(home: Optional[Path] = None) -> Path:
    """profile-id 台账落点：**企业 home** 内 `<home>/plankton-enterprise/profile-ids.json`。

    覆盖：`PLANKTON_PROFILE_IDS_FILE`。**绝不**写个人 `~/.hermes`（PLK-REQ-0006 边界；
    企业 home 由桌面端 `HERMES_HOME` 钉定）。

    P3-1（登记，本包不改）：本模块只把落点解析到企业 home，**尚无从代码层面**断言
    「落点不得落在个人 `~/.hermes`」的护栏（plugin_api 的 W1 只读路由用 home 边界挡库，
    但不挡本台账落点）——该护栏计划在 **W6** 补（`assert_outside_personal_trees` 同款判据）。
    """
    override = (os.environ.get("PLANKTON_PROFILE_IDS_FILE") or "").strip()
    if override:
        return Path(override).expanduser()
    base = _enterprise_home(home)
    if base is None:
        raise AuditUnitRefused("enterprise-home-unavailable")
    return base / "plankton-enterprise" / "profile-ids.json"


def _canon_profile_key(key: Any) -> str:
    text = str(key or "").strip()
    if not text:
        raise AuditUnitRefused("profile-key-required")
    # 归一化末尾分隔符，避免同一目录两种写法落成两条。
    if len(text) > 1:
        text = text.rstrip("/") or text
    return text


def _load_profile_ids(path: Path) -> dict:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    try:
        import json

        data = json.loads(text)
    except Exception:
        return {}
    profiles = data.get("profiles") if isinstance(data, dict) else None
    return dict(profiles) if isinstance(profiles, dict) else {}


def _save_profile_ids(path: Path, profiles: dict) -> bool:
    import json

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        tmp.write_text(
            json.dumps({"version": PROFILE_ID_STORE_VERSION, "profiles": profiles}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(tmp, path)
        return True
    except OSError as exc:  # pragma: no cover - 环境相关
        logger.warning("plankton-enterprise: could not persist profile ids (%s): %s", path, exc)
        return False


#: profile-id 台账的**进程内**串行锁（同进程多线程）；
#: 跨进程另加 `.lock` 侧车文件的 `fcntl.flock`（见 `_profile_id_ledger_lock`）。
_PROFILE_ID_THREAD_LOCK = threading.Lock()


@contextmanager
def _profile_id_ledger_lock(path: Path) -> Iterator[None]:
    """串行化 profile-id 台账的「读→改→写」（P2-1：同键恒同 id、并发不丢更新）。

    台账本体是 `os.replace` 原子替换 ⇒ **不能**锁本体：替换后旧 fd 指向已删除的 inode，
    后来者在**新** inode 上各自加锁，形同没锁。故锁一个**从不被替换**的 `.lock` 侧车文件：
      * 同机多进程：`fcntl.flock(LOCK_EX)`（POSIX）；
      * 同进程多线程：`flock` 的语义按 open file description，不愿依赖 VFS 把两个独立 fd
        判为同一把锁，故叠加一把模块级 `_PROFILE_ID_THREAD_LOCK` 兜底。

    fail-closed：拿不到锁（父目录不可建/不可写）⇒ `AuditUnitRefused`，绝不无锁继续读写。
    """
    lock_path = path.with_name(f".{path.name}.lock")
    with _PROFILE_ID_THREAD_LOCK:
        try:
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            handle = open(lock_path, "a+")
        except OSError as exc:
            raise AuditUnitRefused("profile-id-store-unwritable") from exc
        try:
            if fcntl is not None:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                except OSError as exc:  # pragma: no cover - 环境相关
                    raise AuditUnitRefused("profile-id-store-unwritable") from exc
            yield
        finally:
            if fcntl is not None:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                except OSError:  # pragma: no cover - 解锁失败不掩盖主体结果
                    pass
            handle.close()


def resolve_profile_id(
    profile_key: Any,
    *,
    profile_name: Any = "",
    aliases: Iterable[Any] = (),
    home: Optional[Path] = None,
    path: Optional[Path] = None,
    now: Optional[float] = None,
) -> dict:
    """解析/发放该 profile 的稳定 `profileId`（PLK-REQ-0049）。

    **键 = profile 的稳定身份**（调用方给的 `profile_key`，即该 profile 的 home 目录）——
    **不是** `profile_name`：名字会变、会重名，`profileName` 只作为一个可变的**自报标签**寄存。
    首次见到该键 ⇒ 生成 `pid_<uuid4>` 并**持久化**；以后同键（或其 `aliases` 里的旧键）复用同值。

    `aliases` 用于真正的目录改名：把旧键当别名交给本函数即可**沿用**同一 ID（对应引擎
    `hermes profile rename` 的 identity 迁移，`hermes_cli/profile_identity.py`）。

    **并发（P2-1）**：整个「读台账 → 改 → 写回」在 `_profile_id_ledger_lock` 内原子完成，
    保证「同一键恒同一 id」「并发不丢更新」，且**并发结果与串行一致**（每次都在锁内重读最新台账）。
    空键 ⇒ `_canon_profile_key` **fail-closed 拒**（P3-3），不归一到任何共享值。

    返回 `{"kind":"ok","profileId":…,"profileName":…,"firstTime":bool}`，或抛 `AuditUnitRefused`
    （落点不可用/键为空/写失败 ⇒ 绝不假装发过号）。
    """
    canon = _canon_profile_key(profile_key)
    label = redact_text(profile_name)
    target = path or profile_id_store_path(home)
    with _profile_id_ledger_lock(target):
        return _resolve_profile_id_locked(canon, label, aliases, target, now)


def _resolve_profile_id_locked(
    canon: str,
    label: str,
    aliases: Iterable[Any],
    target: Path,
    now: Optional[float],
) -> dict:
    """`resolve_profile_id` 的**临界区**：调用方必须已持有 `_profile_id_ledger_lock(target)`。

    在锁内**重读**最新台账再合并写回——这是「不丢更新」的关键（锁外读到的是快照，
    并发的另一写者可能已改过；锁内重读 + 合并 + 原子替换才与串行等价）。
    """
    profiles = _load_profile_ids(target)

    entry = profiles.get(canon)
    adopted = False
    if entry is None:
        # 别名采用（目录改名后沿用同一 ID）：调用方给出该 profile **曾用过的键**，
        # 命中台账里的旧键即把条目迁移到新键下（对应引擎 `hermes profile rename` 的 identity 迁移）。
        for previous in [_canon_profile_key(a) for a in (aliases or []) if str(a or "").strip()]:
            if previous in profiles:
                entry = profiles.pop(previous)
                known = {str(a) for a in (entry.get("aliases") or [])}
                known.add(previous)
                known.add(canon)
                entry["aliases"] = sorted(known)
                profiles[canon] = entry
                adopted = True
                break
        if entry is None:
            # 幂等再调：某条目的 aliases 里已登记过 canon。
            for stored in profiles.values():
                if canon in {str(a) for a in (stored.get("aliases") or [])}:
                    entry = stored
                    break

    if entry is None:
        entry = {
            "profileId": f"{PROFILE_ID_PREFIX}{uuid.uuid4().hex}",
            "createdAt": _iso8601(now),
            "profileName": label,
            "aliases": [],
        }
        profiles[canon] = entry
        if not _save_profile_ids(target, profiles):
            raise AuditUnitRefused("profile-id-store-unwritable")
        return {
            "kind": "ok",
            "profileId": entry["profileId"],
            "profileName": label,
            "firstTime": True,
        }

    dirty = adopted
    if label and entry.get("profileName") != label:
        entry["profileName"] = label  # 名字只是标签：更新它**不**改 ID。
        dirty = True
    extra = {_canon_profile_key(a) for a in (aliases or []) if str(a or "").strip()}
    existing = {str(a) for a in (entry.get("aliases") or [])}
    merged = sorted(existing | extra)
    if merged != sorted(existing):
        entry["aliases"] = merged
        dirty = True
    if dirty and not _save_profile_ids(target, profiles):
        raise AuditUnitRefused("profile-id-store-unwritable")
    return {
        "kind": "ok",
        "profileId": entry["profileId"],
        "profileName": entry.get("profileName") or label,
        "firstTime": False,
    }


# ── 会话素材只读读取点（引擎会话事实库 state.db.messages） ────────────────────


def read_session_chat(db_path: Any, engine_session_id: Any) -> list:
    """**只读**读引擎会话事实库，取该会话的全部聊天记录（按 `timestamp, id` 序）。

    `state.db` 以 URI `mode=ro` 打开（N7 §2：会话取材自 `state.db` messages 表；
    桌面端只读读取——`apps/desktop/electron/connection-config.ts:742-746`）。
    会话不存在（零条聊天记录）⇒ `AuditUnitRefused("no-session")`，绝不产一条空单元冒充会话。
    """
    sid = str(engine_session_id or "").strip()
    if not sid:
        raise AuditUnitRefused("engine-session-id-required")
    path = Path(db_path)
    if not path.is_file():
        raise AuditUnitRefused("state-db-missing")
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error as exc:  # pragma: no cover - 环境相关
        raise AuditUnitRefused(f"state-db-unreadable:{type(exc).__name__}") from exc
    try:
        rows = conn.execute(
            "SELECT role, content FROM messages "
            "WHERE session_id = ? AND role IN ('user', 'assistant') AND COALESCE(active, 1) = 1 "
            "ORDER BY timestamp ASC, id ASC",
            (sid,),
        ).fetchall()
    except sqlite3.Error as exc:  # pragma: no cover - schema drift
        raise AuditUnitRefused(f"state-db-unreadable:{type(exc).__name__}") from exc
    finally:
        conn.close()
    if not rows:
        raise AuditUnitRefused("no-session")
    return [{"role": str(role), "content": content} for role, content in rows]


def produce_session_audit_unit(
    *,
    engine_session_id: Any,
    messages: Iterable[Any],
    profile_key: Any,
    profile_name: Any = "",
    variant: Any = "",
    engine_version: Any = "",
    project: Any = "",
    client: Any = AUDIT_CLIENT_ID,
    app_version: Any = "",
    home: Optional[Path] = None,
    now: Optional[float] = None,
) -> dict:
    """端到端生产者（**纯逻辑**）：解析稳定 profileId → 组单元。**不上传**。

    返回 `{"kind":"ok","unit":{…}}`；被拒 ⇒ `{"kind":"rejected","note":…}`（typed，不抛给调用方）。
    """
    try:
        resolved = resolve_profile_id(profile_key, profile_name=profile_name, home=home, now=now)
        unit = assemble_audit_unit(
            engine_session_id=engine_session_id,
            messages=messages,
            profile_name=profile_name,
            profile_id=resolved["profileId"],
            variant=variant,
            engine_version=engine_version,
            project=project,
            client=client,
            app_version=app_version,
            now=now,
        )
    except AuditUnitRefused as exc:
        return {"kind": "rejected", "note": exc.note}
    return {"kind": "ok", "unit": unit}
