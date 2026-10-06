"""plankton-enterprise — the agent's **draft-proposal outbox** (批 3 · 新建草稿卡的提案入口).

WHY THIS EXISTS (and why it is NOT a second write door)
------------------------------------------------------
The W5 ruling made the pack's 取数口 a READ-ONLY read path: the renderer resolves a
reference key by running the domain's DECLARED READ command. That is correct for
the `update` / `plan` blocks — their records already exist in the ledger. But the
**new-draft** block (`plankton-baymax-new`) has NO ledger object to read: its
content is the *agent's own draft proposal*, which by construction no read command
can return. So `::plankton-baymax-new{key="…"}` used to resolve to nothing and
degrade to plain text.

Authority (Perry, 2026-10-07) ruled **要** — add a proposal entry. The scope is
deliberately narrow and is the whole point of this module:

  * it stores ONLY **draft proposals** (the agent's outbox). It never writes,
    reads or mutates the ledger, never runs shaoke-cli and never spawns anything;
  * the WRITE side stays exactly one door — the W3 action layer
    (`packActions.run` → `packExec`), gated by the server-issued session identity
    and the human confirm. This module opens no write path: the confirm step is
    unchanged, so 「不点确认 ⇒ 零写入」 still holds;
  * **人类字段硬约束 (load-bearing)**: a proposal may only carry fields whose
    declared tier is `agent-drafted` (see ``AGENT_DRAFTABLE_FIELDS``). A
    `user-fact` / `user-designated` field (负责人, 计划结束, 类型, 优先级…)
    MUST come from the person — the proposal entry refuses it up front, and the
    existing card build (`buildDraft` → `buildField` → `attestation`) refuses it
    again as defence in depth. An agent may propose wording; it may not fill in
    facts that only a human can supply.

NAMESPACE / CLEANUP (N7 §0 「多会话/多提案不串」)
------------------------------------------------
  * The reference key is namespaced by pack: ``<packId>:<token>``. A proposal of
    pack A can never resolve under pack B's directive (the loader re-checks the
    namespace); the token is a fresh uuid4 hex so two proposals never collide;
  * entries carry ``expiresAt`` (default TTL 1800s). Expired entries are dropped
    lazily on read AND by an explicit ``sweep``; a stale/expired/never-existed
    ref is indistinguishable (both ⇒ ``None`` ⇒ the renderer degrades to text,
    content kept). There is no path where a dead ref yields a half-card;
  * the store is a single JSON file under the ENGINE home
    (``<HERMES_HOME>/plankton-enterprise/proposals.json``; override with
    ``PLANKTON_PROPOSALS_FILE``), never the personal home, never the skills store,
    never a ledger. Writes are best-effort: a failure returns a typed refusal and
    the renderer degrades to text — a proposal that cannot be stored is never
    reported as stored.

This module is deliberately the ONLY thing that touches that file.
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: The pack this outbox belongs to (one pack = one skill, N7 §8 W2).
PACK_ID = "baymax"
#: The declared block tag whose draft has no ledger source (the proposal block).
BLOCK_TAG = "plankton-baymax-new"
#: The declared actions of that block (drift-locked to the pack declaration).
DECLARED_ACTIONS = ("confirm-create", "discard")

#: **人类字段硬约束**：只有 `agent-drafted` 分级的字段键可由 agent 的提案携带。
#: 其余分级（`user-fact` / `user-designated`）必须由人给 —— 提案入口一律拒。
#: Drift-locked to the pack declaration's `fieldTiers` by
#: ``tests/test_plugin_api_proposals.py`` (a key re-tiered in the declaration
#: without updating this tuple turns that test RED).
AGENT_DRAFTABLE_FIELDS = ("title", "description", "content")

#: Default proposal lifetime (seconds). The renderer window is a session; a
#: proposal older than this is stale and must not silently resurrect as a card.
DEFAULT_TTL_SECONDS = 1800

#: The single agent tool this outbox exposes (N2 §0.1: the domain's surface —
#: which commands exist / what the agent may emit — is carried by ONE skill,
#: but the machine door for a *draft* is this one tool).
TOOL_NAME = "plankton_propose_draft"
TOOLSET = "plankton"
TOOL_DESCRIPTION = (
    "把「要新建的一条工单」作为**草稿提案**提交，返回一个引用键（key）。"
    "在会话正文发 ::plankton-baymax-new{key=\"<引用键>\"} 即可把它画成草稿卡，"
    "由人在卡上确认后才会真正写入台账。**只能携带可由 agent 起草的字段**"
    "（title/description）；事实类与指定类字段（负责人、计划结束、类型、优先级…）"
    "必须由人给，提案无法代填。"
)

_STORE_VERSION = 1
_TOKEN_RE = None  # validated via ``_safe_token`` below
# ref = "<packId>:<token>"; both segments are conservative slugs.
import re as _re

_REF_RE = _re.compile(r"^[a-z][a-z0-9-]*:[0-9a-f]{8,32}$")


def store_path() -> Path:
    """Where the outbox lives.

    Precedence: explicit ``PLANKTON_PROPOSALS_FILE`` override → the ENGINE home
    (``HERMES_HOME``) → the engine default root. Never a personal-adhoc path: the
    desktop pins ``HERMES_HOME`` for every spawned backend.
    """
    override = (os.environ.get("PLANKTON_PROPOSALS_FILE") or "").strip()
    if override:
        return Path(override).expanduser()
    env = (os.environ.get("HERMES_HOME") or "").strip()
    if env:
        base = Path(env).expanduser()
    else:
        try:
            from hermes_constants import get_default_hermes_root  # type: ignore

            base = Path(get_default_hermes_root())
        except Exception:
            base = Path.home() / ".hermes"
    return base / "plankton-enterprise" / "proposals.json"


def _empty() -> dict:
    return {"version": _STORE_VERSION, "proposals": {}}


def _load(path: Path) -> dict:
    """Read the outbox; a missing / unreadable / malformed file is EMPTY, never
    an exception (a corrupt outbox must degrade to 「取不到」, not take the door
    down)."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return _empty()
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return _empty()
    if not isinstance(data, dict) or not isinstance(data.get("proposals"), dict):
        return _empty()
    return {"version": _STORE_VERSION, "proposals": dict(data["proposals"])}


def _save(path: Path, data: dict) -> bool:
    """Atomically replace the outbox. Best-effort: returns False on any failure."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
        return True
    except OSError as exc:  # pragma: no cover - environment dependent
        logger.warning("plankton-enterprise: could not persist the proposal outbox (%s): %s", path, exc)
        return False


def _now_ms(now: Optional[float] = None) -> int:
    if now is None:
        return int(time.time() * 1000)
    # ``now`` is accepted in SECONDS (matching time.time()) for testability.
    return int(float(now) * 1000)


def _is_expired(entry: Any, now_ms: int) -> bool:
    if not isinstance(entry, dict):
        return True
    expires = entry.get("expiresAt")
    if not isinstance(expires, (int, float)):
        return True  # no expiry stamp ⇒ not a valid proposal
    return expires <= now_ms


def _split_ref(ref: str) -> Optional[tuple]:
    text = str(ref or "").strip()
    if not _REF_RE.match(text):
        return None
    pack_id, token = text.split(":", 1)
    return pack_id, token


def _scrub(proposals: dict, now_ms: int) -> tuple:
    """Drop expired entries. Returns (kept, removed_count)."""
    kept = {ref: entry for ref, entry in proposals.items() if not _is_expired(entry, now_ms)}
    return kept, len(proposals) - len(kept)


def create_proposal(
    *,
    pack_id: str = PACK_ID,
    block: str = BLOCK_TAG,
    record: Any = None,
    actions: Any = None,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
    now: Optional[float] = None,
    path: Optional[Path] = None,
) -> dict:
    """Store a draft proposal and return its reference key.

    Returns ``{"kind": "ok", "ref": …, "expiresAt": …}`` on success, or
    ``{"kind": "rejected", "note": …}`` with a DISTINGUISHABLE reason. It writes
    nothing but the outbox file and never spawns a process.
    """
    if str(pack_id) != PACK_ID:
        return {"kind": "rejected", "note": "pack-not-declared"}
    if str(block) != BLOCK_TAG:
        return {"kind": "rejected", "note": "block-not-declared"}
    if not isinstance(record, dict) or not record:
        return {"kind": "rejected", "note": "record-empty"}

    # ── 人类字段硬约束：只收 agent-drafted 的字段键 ─────────────────────────────
    for key in record:
        if str(key) not in AGENT_DRAFTABLE_FIELDS:
            return {"kind": "rejected", "note": f"field-tier-not-agent-draftable:{key}"}
    for key, value in record.items():
        # The value must survive the protocol's lossless-value mouth (a card and
        # an argv must see the same string): string / bool / safe int / null.
        if value is None or isinstance(value, (str, bool)):
            continue
        if isinstance(value, int) and not isinstance(value, bool) and abs(value) <= 2**53:
            continue
        return {"kind": "rejected", "note": f"field-value-malformed:{key}"}

    requested = [str(a) for a in (actions if isinstance(actions, (list, tuple)) else [])]
    unknown = [a for a in requested if a not in DECLARED_ACTIONS]
    if unknown:
        return {"kind": "rejected", "note": f"action-not-declared:{unknown[0]}"}

    try:
        ttl = int(ttl_seconds)
    except (TypeError, ValueError):
        ttl = DEFAULT_TTL_SECONDS
    if ttl <= 0:
        ttl = DEFAULT_TTL_SECONDS

    now_ms = _now_ms(now)
    ref = f"{PACK_ID}:{uuid.uuid4().hex[:12]}"
    entry = {
        "ref": ref,
        "packId": PACK_ID,
        "block": BLOCK_TAG,
        "record": {str(k): v for k, v in record.items()},
        "actions": requested or list(DECLARED_ACTIONS),
        "createdAt": now_ms,
        "expiresAt": now_ms + ttl * 1000,
    }

    target = path or store_path()
    data = _load(target)
    kept, _ = _scrub(data["proposals"], now_ms)
    if ref in kept:  # pragma: no cover - uuid4 collision
        return {"kind": "rejected", "note": "ref-collision"}
    kept[ref] = entry
    if not _save(target, {"version": _STORE_VERSION, "proposals": kept}):
        return {"kind": "rejected", "note": "store-unwritable"}
    return {"kind": "ok", "ref": ref, "expiresAt": entry["expiresAt"]}


def get_proposal(
    ref: str,
    *,
    pack_id: Optional[str] = None,
    now: Optional[float] = None,
    path: Optional[Path] = None,
) -> Optional[dict]:
    """Resolve a reference key to its proposal, or ``None``.

    ``None`` covers every non-resolution: malformed key, unknown key, EXPIRED
    key (which is also pruned here), and — when ``pack_id`` is given — a key
    whose namespace is a DIFFERENT pack (多提案不串). The caller (renderer)
    turns ``None`` into text, so a dead reference never yields a half-card.
    """
    parsed = _split_ref(ref)
    if parsed is None:
        return None
    ref_pack, _token = parsed
    if pack_id is not None and str(pack_id) != ref_pack:
        return None

    target = path or store_path()
    now_ms = _now_ms(now)
    data = _load(target)
    kept, removed = _scrub(data["proposals"], now_ms)
    if removed:
        _save(target, {"version": _STORE_VERSION, "proposals": kept})
    entry = kept.get(str(ref).strip())
    if not isinstance(entry, dict):
        return None
    if str(entry.get("packId") or "") != ref_pack:
        return None  # entry's own namespace disagrees with its key
    return entry


def clear_proposals(*, path: Optional[Path] = None) -> int:
    """Drop every stored proposal; returns the number removed."""
    target = path or store_path()
    data = _load(target)
    count = len(data["proposals"])
    if count:
        _save(target, _empty())
    return count


def register_tools(ctx: Any) -> None:
    """Register the ONE proposal tool with the engine.

    Fail-open on a HOST that exposes no ``register_tool`` hook: that is the host's
    capability gap, reported loudly, and it must not take the plugin down (the
    skill, the dashboard backend and the desktop half stay live). A *payload*
    defect is different and raises at call time as a typed refusal.
    """
    register_tool = getattr(ctx, "register_tool", None)
    if not callable(register_tool):
        logger.warning(
            "plankton-enterprise: this engine exposes no ctx.register_tool hook; the %s "
            "draft-proposal tool is present but not registered for the agent.",
            TOOL_NAME,
        )
        return None
    register_tool(
        name=TOOL_NAME,
        toolset=TOOLSET,
        schema={
            "name": TOOL_NAME,
            "description": TOOL_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "fields": {
                        "type": "object",
                        "description": "要起草的字段（只允许 agent 可草拟的：title/description）。",
                        "additionalProperties": True,
                    },
                    "actions": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "该块的可用动作（默认 confirm-create/discard）。",
                    },
                },
                "required": ["fields"],
            },
        },
        handler=handle_propose_draft,
        description=TOOL_DESCRIPTION,
        emoji="\U0001f4dd",
    )
    return None


def handle_propose_draft(args: Any = None, **kwargs: Any) -> str:
    """Tool handler: ``plankton_propose_draft({fields: {...}})``.

    Returns a JSON string. On success it carries the **reference key** and the
    exact instruction the agent should emit; on refusal it carries the typed
    reason (so the agent can fix its own draft rather than guess). Never writes
    the ledger, never spawns.
    """
    raw = args if isinstance(args, dict) else {}
    fields = raw.get("fields")
    if not isinstance(fields, dict):
        fields = {}
    result = create_proposal(record=fields, actions=raw.get("actions"), **{
        k: v for k, v in kwargs.items() if k in ("pack_id", "block", "ttl_seconds")
    })
    if result["kind"] != "ok":
        return json.dumps({"ok": False, "error": result["note"]}, ensure_ascii=False)
    return json.dumps(
        {
            "ok": True,
            "ref": result["ref"],
            "instruction": f'::plankton-baymax-new{{key="{result["ref"]}"}}',
            "note": "草稿已提交（尚未写入台账）。请把 instruction 原文发到会话正文，由人在卡上确认后才会真正写入。",
        },
        ensure_ascii=False,
    )
