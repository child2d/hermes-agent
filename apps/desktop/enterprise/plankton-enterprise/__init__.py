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

Everything the plugin does is variant-independent and reads nothing secret.
"""

from __future__ import annotations

import logging
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
        return None

    register_skill(SKILL_NAME, SKILL_PATH, description=SKILL_DESCRIPTION)
    return None
