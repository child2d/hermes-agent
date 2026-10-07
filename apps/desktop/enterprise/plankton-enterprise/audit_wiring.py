"""plankton-enterprise — **审计出口的客户端接线**（批 4 · 客户端接线 · 线 ①②③）。

设计为准（逐字）：`docs/plankton/N7-technical-design/N7-20261007-plankton-audit-egress.md`
**§8 W5**（上传缓冲 / 失败态 / 可见）＋ **§8 W6**（home 落点自检 + 边界护栏）＋
**§4**（客户端：上传、断网缓冲与失败态）＋ **§5**（home 落点启动自检）；
需求：`docs/plankton/N2-requirements/N2-20261007-plankton-audit-egress.md`
PLK-REQ-0041（会话级、含全部聊天记录、中心化上传）／0043（断网缓冲）／0047（失败态 fail-closed）／0048（home 落点自检 fail-closed）。

**为什么有本模块**：批 4 已落成 `audit_unit`（组装）与 `audit_egress`（缓冲/自检/失败态）两块，但
**全客户端没有调用方** —— 模块空转、审计主路径不成立。本模块就是那**唯一**的接线缝：把三件事
挂到**引擎会话生命周期**上（客户端半边；**不碰后端**、不加任何写路由）：

  线 ① **会话收尾 ⇒ `record_and_flush`**：会话结束时**组单元 → 先入缓冲 → 再上传**（上传失败
       **不丢**）。组素材只读自引擎会话事实库（`state.db`，`audit_unit.read_session_chat`），
       人方恒空（服务端盖章）、agent 全 self-reported。transport **可注入**，默认由
       `audit_transport.build_transport` 给（默认 `None`＝`no-transport` 安全态）。
  线 ② **启动期 ⇒ `check_audit_landing` 并据此**尝试**拒绝进入可用状态（**同样受机制缺口影响**）**：
       `register(ctx)` 期跑落点自检；不通过 ⇒ 记 error + 广播 `audit.landing.refused` + 让
       `admit()` 返回拒绝 + **可行动提示**，**不静默回退**。**但「不进入可用状态」同样没有执行者**：
       无宿主消费该裁决（桌面宿主无订阅者、无准入闸；引擎无会话闸门）——⇒ 落点使审计不成立时，
       对话仍可继续（该会话无审计）；本行只做到「大声记录 + 广播」，未做到「真拒」。
  线 ③ **会话入口 ⇒ `admit_conversation`（**机制缺口，见下**）**：会话入口先**计算**准入裁决
       （缓冲**可写且未满**）；缓冲**不可写/满** ⇒ 裁决 `admitted:false` + `CONVERSATION_REFUSAL_NOTE`
       （文案**不**声称拦截单次工具调用）。**但本引擎对 `on_session_start` 的返回值一律忽略**
       （Observer 合同：`hermes_cli/plugins.py:132`；调用点 `agent/conversation_loop.py:864` 不回读返回值）
       ——⇒ **该「拒」在产物里没有执行者：缓冲满/不可写时对话仍可继续，且该会话入不了缓冲 ⇒ 无审计**。
       本回调只**记录 + 广播**（`audit.conversation.refused`）以便宿主可见；**不阻断对话**。
       **待 Perry 裁决**（见事件「接线状态」与 N7 §8 实现落点）：要「真要不成」需引擎新增会话闸门
       或桌面宿主侧准入闸（两者本批红线均不可动）。

边界（红线，本模块**不做**）：
  * **不动后端、不加写路由**：本模块只在**引擎进程内**注册钩子；接收端（W2/W4）在另一仓。
  * **默认不发真实数据**：`build_transport` 默认 `None` ⇒ flush 拒 `no-transport`；只有配置显式启用才出网。
  * **不写个人 `~/.hermes`**：落点一律在企业 home 内（缓冲 → `audit_egress.buffer_root`；配置 →
    `audit_transport`）；`check_audit_landing` 在启动期就拦下落进个人目录的配置。
  * **不改上游引擎**：只经 `ctx.register_hook`（引擎既有钩子面），不 import 引擎私有实现。

引擎钩子契约（本次接线依据，逐字引自 `hermes_cli/plugins.py` 的 `VALID_HOOKS`）：
  * `on_session_start` —— 每会话首轮；`session_id=…`（`agent/conversation_loop.py:865`）。
    **类别＝Observer（`hooks.md` 目录表：「First turn of a new session; **return ignored**」）**：
    返回被收集、但调用点**不回读**（`agent/conversation_loop.py:864` 只调 `_invoke_hook(...)` 丢弃结果）；
    回调抛异常被 `invoke_hook` 吞掉（`hermes_cli/plugins_dispatch.py:239` `except (Exception, SystemExit)`，
    仅 `pre_tool_call` 是 fail-closed 策略钩子——`plugins_dispatch.py:49`）。⇒ **`on_session_start`
    没有任何 directive/拒绝通道，不能中止或拒绝会话**（机制实测见 `tests/test_audit_wiring.py`）。
  * `on_session_finalize` —— **真实会话边界**（`/new`、退出）；`session_id=…`
    （`hermes_cli/cli_session_mixin.py:437`、`tui_gateway/session_lifecycle.py:49`）。
    选 `on_session_finalize` 而非 `on_session_end`：后者**每轮**都会打（`agent/turn_finalizer.py:768`），
    会话级单元应在**会话边界**收尾（粒度＝会话级，N2 PLK-REQ-0041）。
"""

from __future__ import annotations

import importlib.util
import logging
import os
import sys
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

#: 桌面插件 id（供 `plugin_events` 广播用；须匹配 `[a-z0-9_-]{1,64}`）。
PLUGIN_ID = "plankton-enterprise"

#: 会话收尾钩子：真实会话边界（不是每轮）。
FINALIZE_HOOK = "on_session_finalize"
#: 会话入口钩子。
START_HOOK = "on_session_start"

# ── 模块级「接线状态」：只读可见面（`GET /audit/wiring`）据此报告 ─────────────────
#   * 同一进程内由固定模块名共享，故 dashboard 后端能读到引擎 `register()` 期的结果。
REGISTERED_HOOKS: list = []
LAST_STARTUP_VERDICT: Optional[dict] = None


def _load_sibling(name: str, filename: str) -> Any:
    """按绝对路径、固定名导入同级模块（与 `audit_egress._load_audit_unit` 同法，保证一进程一实例）。"""
    module = sys.modules.get(name)
    if module is not None:
        return module
    path = Path(__file__).resolve().parent / filename
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:  # pragma: no cover - artifact defect
        raise ImportError(f"plankton-enterprise: cannot load {filename} at {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _abs_module_name() -> str:
    return __name__


def _engine_home() -> Optional[Path]:
    """企业 home：`HERMES_HOME`（桌面端为每个后端钉定）→ 引擎默认根。"""
    env = (os.environ.get("HERMES_HOME") or "").strip()
    if env:
        return Path(env).expanduser()
    try:
        from hermes_constants import get_default_hermes_root  # type: ignore

        return Path(get_default_hermes_root())
    except Exception:
        return None


def _emit(event: str, payload: dict) -> None:
    """把接线事实广播到应用的全局事件流（桌面半边 `host.onEvent` 可订阅）。失败绝不影响主流程。"""
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event

        broadcast_plugin_event(PLUGIN_ID, event, payload)
    except Exception:  # pragma: no cover - 无网关时静默（见 plugin_events 文档）
        logger.debug("plankton-enterprise: plugin event %s not delivered", event, exc_info=True)


class SessionAuditHost:
    """把「会话 / 落点 / 缓冲」三件事接到引擎生命周期上的**客户端宿主**（线 ①②③）。

    所有落点都在**企业 home** 内；`transport` 可注入（测试/宿主给定），缺省由配置决定
    （默认 `None` ⇒ `no-transport` 安全态，一个字节都不外发）。
    """

    def __init__(
        self,
        *,
        home: Optional[Path] = None,
        transport: Optional[Callable[[dict], dict]] = None,
        use_config_transport: bool = True,
        audit: Any = None,
        egress: Any = None,
        transport_module: Any = None,
        buffer_limit: Optional[int] = None,
        now: Optional[float] = None,
    ) -> None:
        resolved = home if home is not None else _engine_home()
        self.home: Optional[Path] = Path(resolved).expanduser() if resolved is not None else None
        self.audit = audit if audit is not None else _load_sibling("plankton_enterprise_audit_unit", "audit_unit.py")
        self.egress = egress if egress is not None else _load_sibling(
            "plankton_enterprise_audit_egress", "audit_egress.py"
        )
        self.transport_module = (
            transport_module if transport_module is not None
            else _load_sibling("plankton_enterprise_audit_transport", "audit_transport.py")
        )
        self._injected_transport = transport
        self._use_config_transport = use_config_transport
        # 缓冲上限：宿主可给（部署口径）；缺省＝出口模块的 DEFAULT_BUFFER_LIMIT（500）。
        # 准入与收尾**用同一个**缓冲落点与上限，故二者对「满」的判定不可能分叉。
        self.buffer_limit = int(buffer_limit) if buffer_limit is not None else int(self.egress.DEFAULT_BUFFER_LIMIT)
        self._now = now

    def _buffer(self) -> Any:
        """本宿主用的**断网缓冲**（企业 home 内；上限＝`buffer_limit`）。"""
        return self.egress.AuditBuffer(self.egress.buffer_root(self.home), limit=self.buffer_limit)

    # ── 线 ④ · 传输（默认关闭） ─────────────────────────────────────────────
    def transport(self) -> Optional[Callable[[dict], dict]]:
        """本次 flush 用的传输：注入优先；否则按配置（默认 `None` ⇒ 不发真实数据）。"""
        if self._injected_transport is not None:
            return self._injected_transport
        if not self._use_config_transport:
            return None
        try:
            return self.transport_module.build_transport(self.home)
        except Exception:  # pragma: no cover - 配置读取失败 ⇒ 安全态（无传输）
            logger.warning("plankton-enterprise: transport config unreadable; staying no-transport", exc_info=True)
            return None

    # ── 线 ② · 启动期落点自检（fail-closed） ─────────────────────────────────
    def landing_verdict(self) -> dict:
        """`check_audit_landing`（§5 / PLK-REQ-0048）＋缓冲落点一并核。"""
        buffer = None
        if self.home is not None:
            try:
                buffer = self.egress.buffer_root(self.home)
            except Exception:  # pragma: no cover - home 不可解析
                buffer = None
        return self.egress.check_audit_landing(self.home, buffer=buffer)

    def startup_verdict(self) -> dict:
        """启动期裁决：`usable` ⇒ 是否**允许进入可用状态**（§5 / PLK-REQ-0048，fail-closed）。

        **范围收窄**（§9.0 #16）：只拦「真会破坏审计成立性」的一种情形（落点进个人 `~/.hermes`）——
        由 `check_audit_landing` 判定；此处只把它包成带 `usable` 的裁决（附可行动提示）。
        """
        landing = self.landing_verdict()
        usable = bool(landing.get("ok"))
        return {
            "kind": "ok" if usable else (landing.get("kind") or "landing-refused"),
            "usable": usable,
            "landing": landing,
            "hint": str(landing.get("hint") or ""),
            "home": str(self.home) if self.home is not None else None,
        }

    # ── 线 ③ · 会话入口准入（fail-closed） ───────────────────────────────────
    def admit(self, session_id: str = "") -> dict:
        """会话入口裁决：落点可用**且**缓冲可写未满才准入；否则**拒绝对话** + 文案（§4 / PLK-REQ-0047）。

        返回 `{"admitted": bool, "kind": str, "note": str, "message": str}`。
        """
        verdict = self.startup_verdict()
        if not verdict["usable"]:
            # 审计落点使审计不成立 ⇒ 不进入可用状态：拒绝一切对话（fail-closed），给可行动提示。
            note = str(verdict.get("kind") or "landing-refused")
            message = verdict.get("hint") or self.egress.LANDING_ACTIONABLE_HINT
            return {"admitted": False, "kind": "refused", "note": note, "message": message}
        if self.home is None:
            return {
                "admitted": False, "kind": "refused", "note": "enterprise-home-unavailable",
                "message": self.egress.CONVERSATION_REFUSAL_NOTE,
            }
        try:
            buffer = self._buffer()
            decision = buffer.admit_conversation()
        except self.egress.AuditEgressRefused as exc:  # pragma: no cover - 落点不可解析
            return {
                "admitted": False, "kind": "refused", "note": exc.note,
                "message": self.egress.CONVERSATION_REFUSAL_NOTE,
            }
        return dict(decision)

    # ── 线 ① · 会话收尾：组单元 → 先入缓冲 → 上传（失败不丢） ─────────────────
    def finalize(
        self,
        session_id: Any,
        *,
        profile_key: Any = None,
        profile_name: Any = "",
        variant: Any = None,
        engine_version: Any = None,
        project: Any = None,
        app_version: Any = None,
        db: Any = None,
    ) -> dict:
        """会话收尾：从会话事实库读**全部聊天记录** → 组单元 → `record_and_flush`（§8 W5 / PLK-REQ-0041/0043）。

        组单元前先过落点/准入：落点不可用 ⇒ **不产、不发**（否则等于把审计写到不成立的地方）。
        """
        sid = str(session_id or "").strip()
        if not sid:
            return {"kind": "refused", "note": "engine-session-id-required"}
        if not self.startup_verdict()["usable"]:
            return {"kind": "refused", "note": "landing-refused"}
        if self.home is None:
            return {"kind": "refused", "note": "enterprise-home-unavailable"}

        db_path = Path(db) if db else (self.home / "state.db")
        try:
            messages = self.audit.read_session_chat(db_path, sid)
        except self.audit.AuditUnitRefused as exc:
            return {"kind": "refused", "note": exc.note}

        ctx = self._session_context(
            profile_key=profile_key, profile_name=profile_name, variant=variant,
            engine_version=engine_version, project=project, app_version=app_version,
        )
        produced = self.audit.produce_session_audit_unit(
            engine_session_id=sid,
            messages=messages,
            profile_key=ctx["profileKey"],
            profile_name=ctx["profileName"],
            variant=ctx["variant"],
            engine_version=ctx["engineVersion"],
            project=ctx["project"],
            app_version=ctx["appVersion"],
            home=self.home,
            now=self._now,
        )
        if produced.get("kind") != "ok":
            return produced  # typed：{"kind":"rejected","note":…}
        return self.egress.record_and_flush(
            produced["unit"], buffer=self._buffer(), transport=self.transport()
        )

    def _session_context(
        self, *, profile_key: Any, profile_name: Any, variant: Any,
        engine_version: Any, project: Any, app_version: Any,
    ) -> dict:
        """会话的两方元数据：调用方给定 → 环境覆盖 → 缺省。

        `profileKey` 是**稳定身份**（profile 的 home 目录），不是名字；缺省 `default` 仅兜底
        —— 桌面端会显式传真实 profile 键。
        """
        return {
            "profileKey": str(profile_key or os.environ.get("PLANKTON_PROFILE_KEY") or "default"),
            "profileName": str(profile_name or os.environ.get("PLANKTON_PROFILE_NAME") or ""),
            "variant": str(variant or os.environ.get("HERMES_DESKTOP_VARIANT") or "plankton"),
            "engineVersion": str(engine_version or os.environ.get("PLANKTON_ENGINE_VERSION") or ""),
            "project": str(project or os.environ.get("PLANKTON_PROJECT") or ""),
            "appVersion": str(app_version or os.environ.get("PLANKTON_APP_VERSION") or ""),
        }

    # ── 引擎钩子接线（线 ①②③ 的挂点） ──────────────────────────────────────
    def on_session_start(self, **kwargs: Any) -> dict:
        """`on_session_start` 钩子：会话入口准入（线 ③）。**返回裁决（供宿主/观测），但不阻断会话**。

        引擎把 `on_session_start` 当 **Observer**：本回调的返回被 `invoke_hook` 收集、调用点
        （`agent/conversation_loop.py:864`）**不回读**；本回调抛错也会被吞（`plugins_dispatch.py:239`）。
        ⇒ 本方法**只能告知**（error 日志 + `audit.conversation.refused` 广播），**不能拒会话**。
        「缓冲满/不可写 ⇒ 对话真要不成」是**机制缺口**（需引擎会话闸门或桌面宿主准入闸，本批红线不可动）。
        """
        decision = self.admit(str(kwargs.get("session_id") or ""))
        if not decision.get("admitted"):
            logger.error(
                "plankton-enterprise: 审计会话准入裁决＝拒绝（note=%s）—— 但本引擎 on_session_start "
                "无法阻断会话（Observer：返回被忽略）；本会话将继续，且缓冲不可写/满时该会话无审计（%s）",
                decision.get("note"), decision.get("message"),
            )
            _emit("audit.conversation.refused", {
                "note": decision.get("note"), "message": decision.get("message"),
                "enforced": False,
            })
        return decision

    def on_session_finalize(self, **kwargs: Any) -> dict:
        """`on_session_finalize` 钩子：会话收尾（线 ①）。返回 `record_and_flush` 的结果。"""
        result = self.finalize(
            kwargs.get("session_id"),
            profile_key=kwargs.get("profile_key"),
            profile_name=kwargs.get("profile_name", ""),
        )
        if result.get("kind") == "refused":
            logger.warning(
                "plankton-enterprise: 会话收尾未落审计（note=%s）", result.get("note"),
            )
            _emit("audit.session.refused", {"note": result.get("note")})
        elif result.get("kind") == "ok":
            flushed = result.get("flushed") or {}
            logger.info(
                "plankton-enterprise: 会话审计已入缓冲（pending=%s, uploaded=%s）",
                (result.get("status") or {}).get("pending"), flushed.get("uploaded"),
            )
        return result

    def register(self, ctx: Any) -> dict:
        """把线 ①②③ 接到 `ctx`（引擎 `register(ctx)` 的钩子面）。返回启动裁决。

        线 ②：先跑落点自检；不通过 ⇒ 记 error + 广播（**注意：本引擎无会话闸门、宿主无消费方 ⇒
        这条「拒绝」目前不会真正阻止应用/会话；见模块头「机制缺口」，待 Perry 裁决**），**不静默回退**。
        线 ③/①：注册 `on_session_start` / `on_session_finalize`（均为 Observer；① 的落盘效果真实生效，
        ③ 的「拒会话」无执行者）。
        """
        verdict = self.startup_verdict()
        global LAST_STARTUP_VERDICT
        LAST_STARTUP_VERDICT = verdict
        if not verdict["usable"]:
            logger.error(
                "plankton-enterprise: 审计落点自检未通过（%s）—— 已记录 + 广播；但本引擎无会话闸门/"
                "宿主无消费方，**未能真正阻止进入可用状态**（机制缺口，待裁）：%s",
                verdict.get("kind"), verdict.get("hint"),
            )
            _emit("audit.landing.refused", {
                "kind": verdict.get("kind"), "hint": verdict.get("hint"),
                "findings": (verdict.get("landing") or {}).get("findings"),
                "enforced": False,
            })
        register_hook = getattr(ctx, "register_hook", None)
        if not callable(register_hook):
            logger.warning(
                "plankton-enterprise: 本引擎未暴露 ctx.register_hook；审计出口的会话接线未挂上"
                "（会话收尾/入口不会调用 record_and_flush / admit_conversation）"
            )
            return verdict
        register_hook(START_HOOK, self.on_session_start)
        register_hook(FINALIZE_HOOK, self.on_session_finalize)
        REGISTERED_HOOKS[:] = [START_HOOK, FINALIZE_HOOK]
        return verdict


def wiring_status(home: Optional[Path] = None, *, host: Optional[SessionAuditHost] = None) -> dict:
    """只读接线状态（供 `GET /audit/wiring` 与 e2e 观测）：钩子是否已挂、启动裁决、传输模式。

    **不含凭据、不含端点原值**。
    """
    active = host
    if active is None:
        try:
            active = SessionAuditHost(home=home)
        except Exception:  # pragma: no cover - 模块缺失
            active = None
    verdict = LAST_STARTUP_VERDICT
    if active is not None:
        resolved = str(active.home) if active.home is not None else None
        # 只认**同一 home** 的注册期裁决；home 不同（如只读面被另一个 profile 的 home 调用）则按该
        # home 重算——否则会把 A 的裁决误报给 B（也避免同一进程里 test/长驻场景的陈旧裁决串台）。
        if verdict is None or verdict.get("home") != resolved:
            verdict = active.startup_verdict()
    elif verdict is None:
        verdict = None
    transport = None
    if active is not None:
        try:
            transport = active.transport_module.describe_transport(active.home)
        except Exception:  # pragma: no cover
            transport = None
    return {
        "kind": "ok",
        "hooks": list(REGISTERED_HOOKS),
        "wired": bool(REGISTERED_HOOKS),
        "startup": verdict,
        "transport": transport,
    }


def register_audit_wiring(ctx: Any, *, home: Optional[Path] = None,
                          transport: Optional[Callable[[dict], dict]] = None) -> dict:
    """`__init__.register(ctx)` 调用的**唯一**接线入口（线 ①②③）。"""
    host = SessionAuditHost(home=home, transport=transport)
    return host.register(ctx)
