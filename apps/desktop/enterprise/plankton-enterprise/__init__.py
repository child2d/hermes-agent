"""plankton-enterprise — the agent half of the enterprise plugin.

The plugin is the machine carrier of ONE pack under the batch-3 concept
convergence (N2 §0.1 / N7 §8 W2): the desktop half carries "what can be drawn /
what can be clicked", and **one skill** carries "the domain's command surface /
what instructions the agent may emit / how to onboard a new domain".

So ``register()`` does exactly one thing: it hands that skill to the engine
through the engine's own plugin-skill hook (``ctx.register_skill``), which is
READ-ONLY — the engine copies nothing into ``~/.hermes/skills`` and the skill is
served from this plugin directory. **No write happens here**, which is why the
domain skill can ship without touching any home directory or enterprise data.

No agent tools, hooks or middleware are registered: the backend REST surface
lives in ``dashboard/plugin_api.py`` and the desktop half ships through the
standalone desktop-plugin door.

> **UPDATE (批 3 · 新建草稿卡的提案入口, 2026-10-07)** — one exception to the
> paragraph above: this half now ALSO registers **one** agent tool,
> ``plankton_propose_draft`` (see ``proposals.py``). The tool only stores the
> agent's **draft proposal** in the plugin's own outbox and hands back a
> reference key; it opens no ledger write path (the single write door remains the
> W3 action layer, gated by the server-issued identity + human confirm) and it
> cannot fill the fields only a person may supply. Registration itself still
> writes nothing — the outbox is touched only when the agent calls the tool.

Everything the plugin does is variant-independent and reads nothing secret.
"""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: The pack id — one skill, one pack (N7 §8 W2).
SKILL_NAME = "baymax"

#: The skill file carried in this plugin directory (committed; byte-locked to the
#: declaration's inline copy by the plugin's node:test suite).
SKILL_PATH = Path(__file__).resolve().parent / "skills" / SKILL_NAME / "SKILL.md"

SKILL_DESCRIPTION = (
    "在对话里把工作沉淀成 Baymax 工单——本域的命令面、agent 能发的指令与接入一个新域的纪律"
    "（plankton 企业包 baymax）。"
)

#: The proposal outbox module (批 3 · 新建草稿卡的提案入口): the agent's draft
#: proposals + the ONE agent tool. Loaded by ABSOLUTE PATH under a fixed module
#: name so it resolves identically whether this half is imported as
#: ``hermes_plugins.<slug>`` (engine loader) or standalone (unit tests, which
#: import ``__init__.py`` as a top-level module with no package context — a
#: relative import would fail there).
_PROPOSALS_MODULE_NAME = "plankton_enterprise_proposals"
_PROPOSALS_PATH = Path(__file__).resolve().parent / "proposals.py"


def _load_proposals() -> Any:
    """Import ``proposals.py`` once per process (fixed name ⇒ shared instance)."""
    module = sys.modules.get(_PROPOSALS_MODULE_NAME)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(_PROPOSALS_MODULE_NAME, _PROPOSALS_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"plankton-enterprise: cannot load the proposal outbox at {_PROPOSALS_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_PROPOSALS_MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


def register(ctx: Any) -> None:  # noqa: ARG001 - the manifest contract requires the parameter
    """Register this pack's ONE skill with the engine (read-only; writes nothing).

    Fail-closed on our own payload: a missing ``SKILL.md`` is a defect in the
    artifact, not a host capability gap, so it raises. A host that does not offer
    the plugin-skill hook is a capability gap of the HOST — it is reported
    loudly (never silently) and the plugin keeps loading, because the dashboard
    backend and the desktop half must not be taken down by an optional skill.
    """
    if not SKILL_PATH.is_file():
        raise RuntimeError(
            f"plankton-enterprise: the pack's skill is missing from the plugin payload: {SKILL_PATH}"
        )

    register_skill = getattr(ctx, "register_skill", None)
    if not callable(register_skill):
        logger.warning(
            "plankton-enterprise: this engine exposes no ctx.register_skill hook; "
            "the %s pack's skill at %s is present but not registered for the agent",
            SKILL_NAME,
            SKILL_PATH,
        )
    else:
        register_skill(SKILL_NAME, SKILL_PATH, description=SKILL_DESCRIPTION)

    # 批 3 · 新建草稿卡的提案入口：ONE agent tool, the draft outbox door. Loading
    # the module is a read; nothing is written here (see proposals.py header for
    # why this is not a second write door and cannot fill human-only fields).
    proposals = _load_proposals()
    proposals.register_tools(ctx)

    # 批 4 · 客户端接线（线 ①②③）：把审计出口挂到引擎会话生命周期上——会话入口准入
    # （admit_conversation）、会话收尾（record_and_flush）、启动期落点自检
    # （check_audit_landing，fail-closed）。传输默认关闭（no-transport 安全态）。
    # 见 audit_wiring.py 的模块头（接线依据＝引擎既有钩子面，不改上游）。
    _wire_audit(ctx)
    return None


#: 审计接线模块（批 4 · 客户端接线）。按绝对路径、固定名导入（与 proposals/audit_unit 同法）。
_AUDIT_WIRING_MODULE_NAME = "plankton_enterprise_audit_wiring"
_AUDIT_WIRING_PATH = Path(__file__).resolve().parent / "audit_wiring.py"


def _load_audit_wiring() -> Any:
    """Import ``audit_wiring.py`` once per process (fixed name ⇒ shared instance)."""
    module = sys.modules.get(_AUDIT_WIRING_MODULE_NAME)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(_AUDIT_WIRING_MODULE_NAME, _AUDIT_WIRING_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"plankton-enterprise: cannot load the audit wiring at {_AUDIT_WIRING_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_AUDIT_WIRING_MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


def _wire_audit(ctx: Any) -> None:
    """接线审计出口（线 ①②③）。**审计不成立不得静默**：一律 error 级日志，绝不吞。

    A host whose engine exposes no ``ctx.register_hook`` is a capability gap — logged
    loudly by the wiring itself (see ``SessionAuditHost.register``). A defect in OUR
    wiring payload (import error) is re-raised: unlike the optional skill, a plugin that
    promises audit and silently drops the hook would be a silent audit hole.
    """
    wiring = _load_audit_wiring()
    wiring.register_audit_wiring(ctx)
