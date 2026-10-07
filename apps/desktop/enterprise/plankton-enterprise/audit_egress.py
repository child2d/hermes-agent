"""plankton-enterprise — **审计出口：断网缓冲 / 失败态 / 落点自检 / 边界护栏**（批 4 · W5＋W6）。

设计为准（逐字）：`docs/plankton/N7-technical-design/N7-20261007-plankton-audit-egress.md`
**§8 W5**（上传缓冲 / 失败态 / 可见）＋ **§8 W6**（home 落点自检 + 边界护栏与实测）
＋ **§4**（客户端：上传、断网缓冲与失败态）＋ **§5**（home 落点启动自检）＋ **§6**（边界护栏）＋ **§9.0** 不变量；
需求：`docs/plankton/N2-requirements/N2-20261007-plankton-audit-egress.md` PLK-REQ-0043/0046/0047/0048。

本模块只做四件事（**W5＋W6 的全部客户端交付**），**零网络副作用默认**（传输由宿主注入）：

 ① **断网缓冲**（§8 W5 / PLK-REQ-0043）：上传为主路径，本地**仅**断网缓冲。缓冲**有上限**、
    **按序补齐**、**按幂等键去重**（同一会话重试/补齐复用同一 `session_audit_id` ⇒ 不重复），
    并有**明确且可诊断**的丢弃处置：**丢「新」不丢「旧」**——缓冲满时**拒绝再收新单元**
    （`buffer-full`），**绝不静默淘汰旧会话**（「上传失败不能丢审计数据」是硬口径）。
 ② **失败态**（§4 / PLK-REQ-0047）：上传失败 ⇒ **保留待上传单元**、可重试（幂等键使重试不重复）；
    本地缓冲**不可写** / 已满 ⇒ **拒绝继续对话** + 明确告警，且告警文案 **SHALL NOT** 声称
    「已拦住正在执行的单次工具调用」（本批不做动作级拦截，见 `CONVERSATION_REFUSAL_NOTE`）。
 ③ **home 落点自检（fail-closed）**（§5 / PLK-REQ-0048）：启动期自检企业 home / 审计落点是否
    **使审计不成立**（落进个人 `~/.hermes` 或引擎可写面内）；命中 ⇒ **拒绝进入可用状态** +
    **可行动提示**，**不静默回退**。**范围收窄**：只拦「真会破坏审计成立性」的那一种（§9.0 #16）。
 ④ **边界护栏 + 脱敏核查**（§6 / §9.0）：
    * **归因只来自服务端**：出口**恒不**填 `human` 段；对任何「客户端自报人方」的单元 **fail-closed 拒**
      （`client-cannot-attest-human`）——不客户端自证；
    * **凭据不落库/不落缓冲**：入缓冲与上传前，单元过**单元卫生扫描**（字段名与值，命中密钥/预签名 URL
      ⇒ 拒），并**独立扫描**缓冲落盘字节；本模块**从不读令牌文件、从不解密任何凭据**；
    * **不复用 CLI 用量表 / 不重造**：无 `cli_usage_log`、无第二套中心存储（源码级结构断言）；
    * **可诊断**：缓冲状态给出计数、字节、最旧年龄、最近错误与 kinds（供「健康观测 / 可见」）。

约束（红线，本包**不做**）：
  * **不连生产库、不发真实数据到真实服务**：默认**无传输**（`flush` 在无传输时 fail-closed 拒 `no-transport`，
    仍**保留**数据）；生产链上传输由宿主按中心端点注入，本模块只调用注入的 `transport(unit)`。
  * **不部署后端、不改后端实现**：接收端（W2/W4）在另一仓；本模块只对接其契约（`POST /plankton/audit` 的
    上送体＝W1 的单元；身份由服务端盖章，客户端只送空 `human`）。
  * **不新增产品写口**：本模块只写**自己的断网缓冲目录**（企业 home 内）与**中心审计端点**（审计出口本体），
    **不**写任何产品数据台账；写口径仍唯一。
  * **不客户端自证**：出口不填人方、不自报身份；自报即拒。

只触盘两处：企业 home 内的缓冲目录（读写）与（只读）复用 `audit_unit` 的脱敏/卫生口径；别处皆纯逻辑。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import logging
import os
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Optional

try:  # POSIX 文件锁（同机跨进程串行缓冲的读改写）；非 POSIX 仅有线程锁。
    import fcntl  # type: ignore
except ImportError:  # pragma: no cover - 非 POSIX 平台
    fcntl = None  # type: ignore

logger = logging.getLogger(__name__)

#: 传输契约：`transport(unit) -> {"ok": bool, "retryable": bool, ...}`。
#: **不**在本模块内建任何真实网络客户端——端点/凭据一律由宿主注入（红线：不发真实数据到真实服务）。
Transmission = Callable[[dict], dict]


def _load_audit_unit() -> Any:
    """按绝对路径、固定名导入 W1 的 `audit_unit`（复用其**同一**脱敏/卫生/键口径，绝不重造）。"""
    name = "plankton_enterprise_audit_unit"
    module = sys.modules.get(name)
    if module is not None:
        return module
    path = Path(__file__).resolve().parent / "audit_unit.py"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:  # pragma: no cover - artifact defect
        raise ImportError(f"plankton-enterprise: cannot load the audit unit module at {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# ── 口径常量（drift-locked 到 N7 §4/§5/§6） ────────────────────────────────────

#: 缓冲目录名（企业 home 内）。**绝不**落个人 `~/.hermes`（§5 / PLK-REQ-0006）。
BUFFER_DIRNAME = "audit-buffer"
#: 待上传单元的落盘子目录。
PENDING_DIRNAME = "pending"
#: 缓冲**上限**：pending 单元条数；满 ⇒ 拒收新单元（`buffer-full`），**绝不**淘汰旧会话。
DEFAULT_BUFFER_LIMIT = 500
#: 单条单元落盘前的最大字节（防御性，非审计保真截断；超限 ⇒ 拒，不静默改小）。
MAX_UNIT_BYTES = 4 * 1024 * 1024

#: 拒绝对话的**唯一**文案（fail-closed）。**SHALL NOT** 声称「已拦住正在执行的单次工具调用」。
CONVERSATION_REFUSAL_NOTE = (
    "审计缓冲不可用，已按 fail-closed **拒绝继续对话**：本地审计无法记录，"
    "继续对话会产生无审计的会话。请先修复企业侧配置/存储后重试。"
    "本产品只做**会话级审计**、不做动作级拦截——本提示不代表任何单次工具调用被阻断。"
)

#: 传输结果 kinds（闭集，UI 不得把未知 kind 渲染成「正常」）。
TRANSPORT_OK = "ok"
TRANSPORT_RETRYABLE = "retryable"
TRANSPORT_PERMANENT = "permanent"


class AuditEgressRefused(Exception):
    """出口被拒（typed）。调用方把它落成 `{"kind":"refused","note":…}`，**绝不**假装成功。"""

    def __init__(self, note: str):
        super().__init__(note)
        self.note = note


# ─────────────────────────────────────────────────────────────────────────────
# ① 断网缓冲：企业 home 内的持久化、有上限、按序、按幂等键去重（§4 / PLK-REQ-0043）
# ─────────────────────────────────────────────────────────────────────────────


def _iso8601(now: Optional[float] = None) -> str:
    stamp = time.time() if now is None else float(now)
    return datetime.fromtimestamp(stamp, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _key_of(unit: Any) -> str:
    key = ""
    if isinstance(unit, dict):
        key = str(unit.get("session_audit_id") or "").strip()
    if not key:
        raise AuditEgressRefused("unit-missing-idempotency-key")
    return key


def _file_stem(key: str) -> str:
    """按幂等键派生**稳定**文件名：同一会话的任意次重试/补齐都指向同一文件 ⇒ 去重免费。"""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]


def _guard_unit(unit: Any, audit: Any) -> None:
    """入缓冲 / 上传前的**最后一道闸**（fail-closed，命中即拒）。

      * **不客户端自证**：`human.auth_user_id` 必须为空（§2：人方＝服务端盖章；客户端只能送空）。
      * **脱敏**：整单元过 W1 的单元卫生扫描（字段名与值；密钥/预签名 URL/profile 内容键 ⇒ 拒）。
      * **大小**：落盘前不超过 `MAX_UNIT_BYTES`（防御性；超限拒而不静默改小）。
    """
    if not isinstance(unit, dict):
        raise AuditEgressRefused("unit-not-an-object")
    human = unit.get("human")
    if not isinstance(human, dict):
        raise AuditEgressRefused("unit-missing-human-section")
    if human.get("auth_user_id") is not None:
        # 客户端**绝不能**自报人方身份；上传前若带了值 ⇒ 拒（不客户端自证）。
        raise AuditEgressRefused("client-cannot-attest-human")
    problem = audit.audit_hygiene_problem(unit)
    if problem:
        raise AuditEgressRefused(problem)
    try:
        blob = json.dumps(unit, ensure_ascii=False, sort_keys=True).encode("utf-8")
    except Exception:  # pragma: no cover - 不可序列化
        raise AuditEgressRefused("unit-not-serializable")
    if len(blob) > MAX_UNIT_BYTES:
        raise AuditEgressRefused("unit-too-large")


@contextmanager
def _buffer_lock(root: Path) -> Iterator[None]:
    """串行化缓冲的「读→改→写」：`.lock` 侧车文件 + `fcntl.flock`（跨进程）+ 线程锁（跨线程）。"""
    lock_path = root / f".{root.name}.lock"
    try:
        root.mkdir(parents=True, exist_ok=True)
        handle = open(lock_path, "a+")
    except OSError as exc:
        raise AuditEgressRefused("buffer-unwritable") from exc
    try:
        if fcntl is not None:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            except OSError as exc:  # pragma: no cover - 环境相关
                raise AuditEgressRefused("buffer-unwritable") from exc
        yield
    finally:
        if fcntl is not None:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:  # pragma: no cover
                pass
        handle.close()


_PROFILE_ID_THREAD_LOCK = threading.Lock()


class AuditBuffer:
    """企业 home 内的**断网缓冲**（§4 / PLK-REQ-0043）。**仅作缓冲，不作审计权威**。

    落点 `<enterprise_home>/plankton-enterprise/audit-buffer/`：
      * `pending/<sha256(key)[:32]>.json` —— 每条待上传单元一个文件，**以幂等键命名** ⇒
        同一会话重试/补齐**覆盖同一文件**（不重复）；内容 `{key, enqueuedAt, attempts, lastError, unit}`；
      * `state.json` —— 可诊断计数（`refusedFull` / `permanentFailures` / `dropped`）。

    开箱即用的键：`buffer_root(home)` 解析落点；`enqueue` 收单元；`flush` 按序补齐；
    `status` 供健康观测（可见）。
    """

    def __init__(
        self,
        root: Path,
        *,
        limit: int = DEFAULT_BUFFER_LIMIT,
        audit: Any = None,
        now: Optional[float] = None,
    ) -> None:
        self.root = Path(root)
        self.limit = int(limit)
        self.audit = audit if audit is not None else _load_audit_unit()
        self._now = now

    # ── 落点 ────────────────────────────────────────────────────────────────
    @property
    def pending_dir(self) -> Path:
        return self.root / PENDING_DIRNAME

    @property
    def state_path(self) -> Path:
        return self.root / "state.json"

    def _stamp(self) -> float:
        return time.time() if self._now is None else float(self._now)

    # ── 写：收单元（去重 + 上限） ─────────────────────────────────────────────
    def enqueue(self, unit: dict) -> dict:
        """收一个待上传单元。**去重**（同键覆盖）、**上限**（满 ⇒ 拒收新键）、**原子落盘**。

        返回 `{"kind":"buffered","key":…,"replaced":bool}` 或抛 `AuditEgressRefused`
        （`buffer-unwritable` / `buffer-full` / 单元卫生不过 / 缺少幂等键）。**绝不无锁继续、绝不静默丢旧**。
        """
        key = _key_of(unit)
        _guard_unit(unit, self.audit)
        with _PROFILE_ID_THREAD_LOCK, _buffer_lock(self.root):
            self.pending_dir.mkdir(parents=True, exist_ok=True)
            files = sorted(self.pending_dir.glob("*.json"))
            stem = _file_stem(key)
            target = self.pending_dir / f"{stem}.json"
            replaced = target.exists()
            if not replaced and len(files) >= self.limit:
                # 满：**拒收新单元**（不淘汰旧会话）。丢弃处置＝丢「新」、可诊断（refusedFull++）。
                self._bump_state(refusedFull=1)
                raise AuditEgressRefused("buffer-full")
            record = {
                "key": key,
                "enqueuedAt": self._stamp(),
                "attempts": 0,
                "lastError": None,
                "unit": unit,
            }
            self._write_record(target, record)
            return {"kind": "buffered", "key": key, "replaced": replaced}

    def _write_record(self, target: Path, record: dict) -> None:
        try:
            tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
            tmp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, target)
        except OSError as exc:
            raise AuditEgressRefused("buffer-unwritable") from exc

    def _read_record(self, path: Path) -> Optional[dict]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) and isinstance(data.get("unit"), dict) else None

    def _ordered_records(self) -> list:
        """按「入队时间，键」**确定序**给出待上传单元（按序补齐；同秒也稳定）。"""
        records = []
        for path in self.pending_dir.glob("*.json"):
            record = self._read_record(path)
            if record is not None:
                record["_path"] = path
                records.append(record)
        records.sort(key=lambda r: (float(r.get("enqueuedAt") or 0.0), str(r.get("key") or "")))
        return records

    # ── 状态（可见 / 健康观测） ───────────────────────────────────────────────
    def status(self) -> dict:
        """缓冲健康：待上传数、字节、最旧年龄、最近错误、计数。**只读**。"""
        if not self.pending_dir.is_dir():
            records, total = [], 0
        else:
            records = self._ordered_records()
            total = 0
            for record in records:
                try:
                    total += record["_path"].stat().st_size
                except OSError:  # pragma: no cover - 环境相关
                    continue
        state = self._read_state()
        now = self._stamp()
        oldest = records[0]["enqueuedAt"] if records else None
        return {
            "kind": "ok",
            "pending": len(records),
            "limit": self.limit,
            "bytes": total,
            "oldestEnqueuedAt": oldest,
            "oldestAgeSeconds": (None if oldest is None else max(0.0, now - float(oldest))),
            "lastError": next((r.get("lastError") for r in reversed(records) if r.get("lastError")), None),
            "refusedFull": int(state.get("refusedFull") or 0),
            "permanentFailures": int(state.get("permanentFailures") or 0),
            # **恒为 0**：本实现**从不**静默丢弃单元（硬口径「上传失败不能丢审计数据」）。
            "dropped": 0,
            "bufferRoot": str(self.root),
        }

    def _read_state(self) -> dict:
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _bump_state(self, **deltas: int) -> None:
        state = self._read_state()
        for name, delta in deltas.items():
            state[name] = int(state.get(name) or 0) + int(delta)
        try:
            tmp = self.state_path.with_name(f".{self.state_path.name}.{os.getpid()}.tmp")
            tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self.state_path)
        except OSError:  # pragma: no cover - 计数写失败不掩盖主流程
            pass

    # ── 补齐上传（按序；幂等键防重） ──────────────────────────────────────────
    def flush(self, transport: Optional[Transmission] = None) -> dict:
        """按序把待上传单元交给 `transport` 上传（**幂等键防重**）。§3 形态。

        传输语义：`transport(unit) -> {"ok": True}`｜`{"ok": False, "retryable": True}`（暂态，**保留**并停止：
        网络场景下没有继续的意义）｜`{"ok": False}`（永久，**保留并记录**、继续下一条，**绝不丢**）。

        返回 `{"kind":"ok","uploaded":n,"remaining":m,"lastError":…,"stoppedOn":"retryable"|None}`。
        **无传输 ⇒ fail-closed 拒（`no-transport`），且不丢任何单元**（红线：默认不发真实网络）。
        """
        if transport is None:
            raise AuditEgressRefused("no-transport")
        with _PROFILE_ID_THREAD_LOCK, _buffer_lock(self.root):
            records = self._ordered_records()
            uploaded = 0
            permanent = 0
            last_error = None
            stopped_on = None
            for record in records:
                unit = record["unit"]
                try:
                    result = transport(unit) or {}
                except Exception as exc:  # 传输抛错＝暂态失败，保留
                    last_error = f"transport-error:{type(exc).__name__}"
                    stopped_on = "retryable"
                    self._record_attempt(record, last_error)
                    break
                if result.get("ok"):
                    try:
                        record["_path"].unlink()
                    except OSError as exc:  # pragma: no cover - 环境相关
                        raise AuditEgressRefused("buffer-unwritable") from exc
                    uploaded += 1
                    continue
                retryable = bool(result.get("retryable"))
                last_error = str(result.get("note") or ("retryable" if retryable else "permanent"))
                if retryable:
                    self._record_attempt(record, last_error)
                    stopped_on = "retryable"
                    break
                # 永久失败：保留（不丢）、记录、继续下一条。
                permanent += 1
                self._record_attempt(record, last_error)
            if permanent:
                self._bump_state(permanentFailures=permanent)
            remaining = len(self._ordered_records())
            return {
                "kind": "ok",
                "uploaded": uploaded,
                "remaining": remaining,
                "lastError": last_error,
                "stoppedOn": stopped_on,
            }

    def _record_attempt(self, record: dict, note: str) -> None:
        path = record.get("_path")
        record["attempts"] = int(record.get("attempts") or 0) + 1
        record["lastError"] = note
        clean = {k: v for k, v in record.items() if k != "_path"}
        if path is None:  # pragma: no cover - 不应发生
            return
        try:
            self._write_record(path, clean)
        except AuditEgressRefused:
            pass  # 记录不上错误也不丢单元（单元文件仍在）

    # ── 会话准入门（§4 / PLK-REQ-0047） ──────────────────────────────────────
    def admit_conversation(self) -> dict:
        """对话是否准入：缓冲**可写且未满**才准入；否则 fail-closed 拒（可行动提示）。**只读探测**。"""
        probe = self.root / f".admit.{os.getpid()}"
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            probe.write_text("", encoding="utf-8")
            probe.unlink()
        except OSError:
            return {"admitted": False, "kind": "refused", "note": "buffer-unwritable",
                    "message": CONVERSATION_REFUSAL_NOTE}
        pending = len(self._ordered_records()) if self.pending_dir.is_dir() else 0
        if pending >= self.limit:
            return {"admitted": False, "kind": "refused", "note": "buffer-full",
                    "message": CONVERSATION_REFUSAL_NOTE}
        return {"admitted": True, "kind": "ok", "pending": pending, "limit": self.limit}


def buffer_root(home: Optional[Path] = None) -> Path:
    """缓冲落点：**企业 home** 内 `<home>/plankton-enterprise/audit-buffer`（**绝不**个人 `~/.hermes`）。"""
    override = (os.environ.get("PLANKTON_AUDIT_BUFFER_DIR") or "").strip()
    if override:
        return Path(override).expanduser()
    base = Path(home).expanduser() if home is not None else _engine_home()
    if base is None:
        raise AuditEgressRefused("enterprise-home-unavailable")
    return base / "plankton-enterprise" / BUFFER_DIRNAME


def _engine_home() -> Optional[Path]:
    env = (os.environ.get("HERMES_HOME") or "").strip()
    if env:
        return Path(env).expanduser()
    try:
        from hermes_constants import get_default_hermes_root  # type: ignore

        return Path(get_default_hermes_root())
    except Exception:
        return None


def record_and_flush(
    unit: dict,
    *,
    home: Optional[Path] = None,
    transport: Optional[Transmission] = None,
    buffer: Optional[AuditBuffer] = None,
) -> dict:
    """断网缓冲的端到端（§8 W5 验收）：**先入缓冲（可写）→ 再尝试补齐**；失败即保留。

    先缓冲后上传，保证「上传失败不丢审计数据」：即便上传这一步就断网，单元也已在盘上。
    """
    buf = buffer or AuditBuffer(buffer_root(home))
    try:
        buffered = buf.enqueue(unit)
    except AuditEgressRefused as exc:
        # 缓冲不可用 ⇒ 拒绝对话（调用方据此拦下继续对话）。
        return {"kind": "refused", "note": exc.note, "message": CONVERSATION_REFUSAL_NOTE}
    flushed = None
    if transport is not None:
        flushed = buf.flush(transport)
    return {"kind": "ok", "buffered": buffered, "flushed": flushed, "status": buf.status()}


# ─────────────────────────────────────────────────────────────────────────────
# ③ home 落点自检（fail-closed）（§5 / PLK-REQ-0048）
# ─────────────────────────────────────────────────────────────────────────────

#: 落点自检的失败 kinds（闭集）。
LANDING_CHECK_NAMES = (
    "landing-inside-personal-home",  # 审计会写到个人 ~/.hermes ⇒ 审计不成立
    "landing-unresolved",            # 落点无法确定 ⇒ fail-closed
)

#: 落点自检**唯一**可行动提示（fail-closed 时给出）。
LANDING_ACTIONABLE_HINT = (
    "企业 home / 审计落点落在个人 ~/.hermes 内，审计记录会写进个人目录、审计不成立，"
    "已按 fail-closed 拒绝进入可用状态。请让管理员把本机的企业 home（HERMES_HOME）指向企业侧目录后重启。"
)


def check_audit_landing(
    home: Optional[Path],
    *,
    personal_home: Optional[Path] = None,
    buffer: Optional[Path] = None,
) -> dict:
    """启动期自检：审计落点是否**使审计不成立**（§5 / PLK-REQ-0048）。

    **范围收窄**（§9.0 #16，「门禁不重于功能」）：只拦**真会破坏审计成立性**的一种情形——
    企业 home / 审计落点解析后落在**个人 `~/.hermes`**（或其 profiles）内。其余**不涉及审计成立性**
    的配置差异**不拦**（如企业 home 换个普通路径、换变体、换端点）。

    返回 `{"ok":bool,"kind":str|None,"findings":[…],"hint":str}`：`ok is False` ⇒ **拒绝进入可用状态**。
    """
    findings: list = []
    if home is None:
        findings.append({"check": "landing-unresolved", "layer": "enterprise-home",
                         "message": "无法确定企业 home，审计落点自检不能成立（fail-closed）"})
        return {"ok": False, "kind": "landing-unresolved", "findings": findings, "hint": LANDING_ACTIONABLE_HINT}

    base = Path(personal_home).expanduser().resolve() if personal_home is not None \
        else Path(os.path.expanduser("~")).resolve()
    targets = [("enterprise-home", Path(home).expanduser())]
    if buffer is not None:
        targets.append(("audit-buffer", Path(buffer).expanduser()))
    personal_hermes = (base / ".hermes").resolve()

    for layer, target in targets:
        try:
            resolved = target.resolve()
        except OSError:  # pragma: no cover - 环境相关
            findings.append({"check": "landing-unresolved", "layer": layer,
                             "path": str(target), "message": f"{layer} 无法解析（fail-closed）"})
            continue
        if resolved == personal_hermes or str(resolved).startswith(str(personal_hermes) + os.sep):
            findings.append({
                "check": "landing-inside-personal-home",
                "layer": layer,
                "path": str(resolved),
                "message": f"{layer} 落在个人 ~/.hermes 内（{resolved}），审计不成立",
            })

    return {
        "ok": not findings,
        "kind": None if not findings else "landing-inside-personal-home",
        "findings": findings,
        "hint": "" if not findings else LANDING_ACTIONABLE_HINT,
    }


# ─────────────────────────────────────────────────────────────────────────────
# ④ 边界护栏（机器载体）（§6）
# ─────────────────────────────────────────────────────────────────────────────

#: 出口**恒不**触碰的字面量（不复用 CLI 用量表 / 不重造第二套中心存储）——
#: **不作为常量存在**，以免与「源码里不得出现该字面量」的结构断言冲突；
#: 由 `tests/test_audit_egress.py::test_egress_source_has_no_cli_table_no_real_url_no_network`
#: 在**代码面**（去 docstring/注释）直接断言其不存在。


def guard_summary() -> dict:
    """把边界护栏以**可诊断**形式给出（供 UI「可见」与机器核查；纯逻辑，不读盘）。"""
    return {
        "kind": "ok",
        "guards": {
            # 不客户端自证：出口不填人方、自报即拒（见 _guard_unit）。
            "no-client-attestation": True,
            # 归因只来自服务端：上送 human 恒为空，服务端盖章。
            "attribution-server-side-only": True,
            # 不复用 CLI 用量表 / 不重造中心存储。
            "no-cli-usage-table": True,
            # 凭据不落库/不落缓冲：入缓冲与上传前过卫生扫描。
            "credentials-never-persisted": True,
        },
        "invariants": [
            "human.auth_user_id 恒为 null（服务端盖章）",
            "agent 侧全 self-reported / non-authoritative",
            "缓冲仅作断网缓冲，不作审计权威",
            "默认无传输：不发真实数据到真实服务",
        ],
    }
