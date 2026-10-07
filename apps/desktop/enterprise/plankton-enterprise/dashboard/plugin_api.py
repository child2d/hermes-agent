"""plankton-enterprise dashboard backend — mounted at ``/api/plugins/plankton-enterprise/``.

Two surfaces ship in this batch:

  * ``GET /tools``  — the local ``shaoke-cli`` tool catalog (read-only listing).
  * ``GET/POST /skills*`` — the enterprise skill market: the approved-skill
    catalog (via ``shaoke-cli skillhub``), install / uninstall / enable /
    disable / update, version comparison and the local content hash.

DECISION (architecture, Perry 2026-10) — THE ENGINE OWNS SKILL STORAGE
---------------------------------------------------------------------
This backend does **not** implement skill storage. Every write (install /
update / uninstall) is delegated to the engine's OWN skill-management entry
points, called IN-PROCESS:

  install / update  ``tools.skills_hub_install.quarantine_bundle`` →
                    ``tools.skills_guard.scan_skill`` →
                    ``tools.skills_guard.should_allow_install`` →
                    ``tools.skills_hub_install.install_from_quarantine``
                    (the exact pipeline ``hermes_cli.skills_hub.do_install``
                    runs; we supply the bundle the enterprise registry gave us
                    instead of resolving it through an engine hub source)
  uninstall         ``tools.skills_hub_install.uninstall_skill``
  enable / disable  ``hermes_cli.skills_config.get_disabled_skills`` /
                    ``save_disabled_skills`` (the pair behind the engine's own
                    ``PUT /api/skills/toggle``)
  local hash        ``tools.skills_guard.content_hash``
  landing rule      ``tools.skills_hub_models._validate_skill_name`` /
                    ``_validate_install_parent_path`` (the pair
                    ``install_from_quarantine`` itself calls)
  store root        ``hermes_constants.get_skills_dir``
  install records   ``tools.skills_hub.HubLockFile`` (``skills/.hub/lock.json``)

Consequence, by construction: **this module contains no landing computation,
no containment check, no atomic write, no hard-link check, no case/Unicode
landing key and no ledger of its own.** The ONLY ``rmtree`` here clears OUR own
staging input — the quarantine path the engine's ``quarantine_bundle`` returned
to us — as hygiene on an early return; it is never aimed at a landing. Those
landing/mutation boundaries are the engine's; a defect in them is a defect in
the engine, not a second implementation we can drift from. The deduplication is
deliberate — see ``apps/desktop/PLANKTON-MIGRATION-BATCH2.md`` §9.2 for the
responsibility split and §9.4 for the two engine gaps this delegation leaves
open (a symlinked skills ROOT is not refused by ``_resolve_lock_install_path``;
a hand-edited lock entry can aim the engine's ``rmtree`` at any directory under
``skills/``).

Where the plugin no longer keeps state: the engine's ``lock.json`` carries
name / source / identifier / trust_level / scan_verdict / content_hash /
install_path / files / installed_at, and our platform facts ride in its
``metadata.shaoke`` block (version / slug / category / pickedBy). There is no
private ledger file under ``<HERMES_HOME>/plankton/`` any more — that file WAS
the second source of truth this batch removes.

Red lines this file still obeys (PLANKTON-MIGRATION-BATCH2.md §D3):
  * It NEVER reads, writes, caches or proxies ``~/.shaoke/tokens.json``. The
    ``tools list`` command is unauthenticated; ``skillhub +list`` likewise runs
    unauthenticated (verified). No token is ever read.
  * The skill store is the ENGINE's own ``get_skills_dir()``. A store that
    resolves inside a personal tree (``~/.hermes*``) is refused and there is NO
    fallback to a personal directory (PLK-REQ-0023). That refusal is a POLICY
    gate (compare only, never a write target); it is not path safety.

Failure taxonomy (each kind is INDEPENDENTLY visible in the UI — never
silently collapsed into "no skills"):
  ``cli-missing`` / ``cli-failed`` / ``unauthorized`` / ``network-failed`` /
  ``not-json`` / ``shape-mismatch`` / ``no-bundle`` / ``download-failed`` /
  ``extract-failed`` / ``needs-confirm`` / ``bad-input`` /
  ``blocked-personal-dir`` / ``enterprise-home-unavailable`` /
  ``engine-unavailable`` / ``engine-refused`` / ``blocked-by-scan`` /
  ``hash-unavailable`` / ``no-record`` / ``remove-failed`` / ``write-failed``
  / ``essential-skill`` / ``not-effective`` / ``unreadable-config`` /
  ``local-edits``.

The startup self-check (see the ``STARTUP SELF-CHECK`` section below) adds ONE
more kind, ``write-guard-failed``: the skill store's OWN path chain — the store
root, or any component between it and the enterprise home — contains a symbolic
link, so EVERY write route refuses. That redirect is the one structural defect
with a real consequence (the engine would otherwise land a bundle OUTSIDE the
store and answer success). The read routes keep working and carry the verdict in
``writeGuard``.
  ``local-edits`` is the ONE gate that also covers "cannot decide": the write
  guard lets a landing be replaced only on a CONFIRMED "no local edits"
  (``engine_local_edits`` returning ``False`` — a record whose hash attests the
  on-disk content). Both a confirmed drift (``True``) and every "no record can
  attest this" case (``None``: no record at all, no comparable hash in the
  record, or an unreadable/corrupt record) are refusals when the planned landing
  already holds content, and the summary carries ``detail.undecidable`` +
  ``detail.lockNote``. The read routes expose the SAME verdict per entry as
  ``localEdits`` / ``localEditsUnknown``, so the page can always present the
  fact and reach the acknowledgement — a refusal the UI cannot answer is a
  dead end, and there is none.
  The per-entry ``installState`` version comparison reads the recorded version
  from where the engine actually keeps our platform facts — the lock entry's
  ``metadata.shaoke.version``; the entry has no top-level ``version`` key.
An EMPTY catalog is a SUCCESS (``{ok: true, catalog: {ok: true, count: 0}}``).
A catalog capped at the page limit is a SUCCESS that carries ``truncated: true``
— never silently read as the whole catalog.

Hash parity: the local content hash is computed by importing the engine's own
``tools.skills_guard.content_hash`` — the exact function the engine uses. There
is NO second (JS/Python) re-implementation of the digest, so the "口径分叉" the
old JS ``hashTree`` risked is impossible by construction.
"""

from __future__ import annotations

import importlib.util
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Optional, Tuple

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

logger = logging.getLogger("plankton-enterprise.skill-store")

CLI_NAME = "shaoke-cli"
TOOLS_LIST_TIMEOUT_S = 30
# A skill zip download + unpack can be slower than a catalog listing.
SKILL_CLI_TIMEOUT_S = 60
RAW_EXCERPT_MAX = 2000
PAGE_SIZE = 50
MAX_PAGES = 20

# The engine source id our bundles are recorded under in the engine's own hub
# lock file. It is NOT an engine hub adapter: the enterprise registry is
# reached through ``shaoke-cli``, and the lock entry exists so the engine can
# uninstall/audit what we handed it. ``check_for_skill_updates`` reports such an
# entry as ``unavailable`` (no matching adapter) — the engine's update CHECK is
# therefore not ours to use; an update is an engine install of a fresh bundle.
ENGINE_SOURCE = "shaoke-skillhub"

# Personal trees the skill store must NEVER touch (PLK-REQ-0023). ``.hermes``
# covers ``~/.hermes`` and ``~/.hermes/profiles/*`` by prefix.
PERSONAL_TREES = (".hermes",)

# Failure kinds a caller can branch on. Kept as a closed set so the UI cannot
# silently render an unrecognised failure as emptiness.
FAILURE_KINDS = (
    "cli-missing",
    "cli-failed",
    "unauthorized",
    "network-failed",
    "not-json",
    "shape-mismatch",
    "no-bundle",
    "download-failed",
    "extract-failed",
    "write-failed",
    "needs-confirm",
    "bad-input",
    "blocked-personal-dir",
    "enterprise-home-unavailable",
    "engine-unavailable",
    "engine-refused",
    "blocked-by-scan",
    "hash-unavailable",
    "no-record",
    "remove-failed",
    "essential-skill",
    "not-effective",
    "unreadable-config",
    # The overwrite guard: an update/install onto a landing whose on-disk content
    # no longer matches the engine's recorded hash, without an explicit
    # acknowledgement. Distinct so the UI can never render it as a generic failure.
    "local-edits",
    # The startup write-path self-check (see the STARTUP SELF-CHECK section).
    # EVERY write route refuses with this kind while it is failing.
    "write-guard-failed",
)

# Tokens that mark a CLI failure as an AUTH problem (distinct from a network or
# a malformed-output problem). Matched case-insensitively against stdout+stderr.
_UNAUTH_TOKENS = (
    "401",
    "403",
    "unauthorized",
    "unauthenticated",
    "未授权",
    "未登录",
    "请先登录",
    "login required",
    "not logged in",
    "invalid token",
)

# Tokens that mark a CLI failure as a NETWORK problem (the registry is
# unreachable) — again distinct from auth and from malformed output. A Go CLI
# surfaces these for a refused / unresolved / timed-out connection.
_NETWORK_TOKENS = (
    "connection refused",
    "connection reset",
    "no such host",
    "network is unreachable",
    "i/o timeout",
    "context deadline exceeded",
    "dial tcp",
    "tls handshake",
    "eof",
    "broken pipe",
    "connection attempt failed",
    "connectex",
    "无法连接",
    "连接超时",
    "网络不可达",
)


# ─────────────────────────────────────────────────────────────────────────────
# Home / CLI resolution (shared by both surfaces)
# ─────────────────────────────────────────────────────────────────────────────


def _hermes_home() -> Optional[Path]:
    """The engine home this backend was launched with.

    The desktop pins ``HERMES_HOME`` for every spawned backend, so it is present;
    the fallback resolves the same value the engine itself would use.
    """
    env = os.environ.get("HERMES_HOME")
    if env and env.strip():
        return Path(env).expanduser()
    try:
        from hermes_constants import get_default_hermes_root  # type: ignore

        return Path(get_default_hermes_root())
    except Exception:
        return None


def engine_skills_dir() -> Optional[Path]:
    """The ENGINE's own skills store — ``hermes_constants.get_skills_dir()``.

    Never a path this module invents: if the engine cannot name its store, the
    caller reports ``engine-unavailable`` rather than guessing ``<home>/skills``.
    """
    try:
        from hermes_constants import get_skills_dir  # type: ignore

        return Path(get_skills_dir())
    except Exception:
        return None


def resolve_cli() -> Tuple[Optional[str], str]:
    """Locate the ENTERPRISE ``shaoke-cli`` without ever reading credentials.

    Precedence: an explicit override → the enterprise copy at
    ``<HERMES_HOME>/bin`` (the one the desktop seeds and PATH-fronts).

    There is deliberately NO fallback to whatever ``PATH`` resolves. A personal
    ``~/.local/bin/shaoke-cli`` is a DIFFERENT artifact with unknown provenance
    and its own credentials; treating it as "the enterprise CLI" is a silent
    downgrade (KI-PLANKTON-0013). When the enterprise copy is absent this
    returns ``(None, "missing")`` so the caller reports an explicit
    ``cli-missing`` — a same-named binary found on PATH is surfaced only as a
    diagnostic hint (``personal_cli_path``), never used.
    """
    override = (os.environ.get("PLANKTON_SHAOKE_CLI") or "").strip()
    if override:
        candidate = Path(override).expanduser()
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate), "override"

    home = _hermes_home()
    if home is not None:
        candidate = home / "bin" / CLI_NAME
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate), "enterprise"

    return None, "missing"


def personal_cli_path() -> Optional[str]:
    """A same-named CLI found on ``PATH`` — DIAGNOSTIC ONLY."""
    return shutil.which(CLI_NAME)


def _excerpt(text: str) -> str:
    text = text if isinstance(text, str) else ("" if text is None else str(text))
    return text if len(text) <= RAW_EXCERPT_MAX else text[:RAW_EXCERPT_MAX]


def _failure(kind: str, message: str, cli_path: Optional[str], cli_source: str, raw: str = "") -> dict:
    payload: dict[str, Any] = {
        "ok": False,
        "kind": kind,
        "error": message,
        "cliPath": cli_path,
        "cliSource": cli_source,
        "fetchedAt": int(time.time() * 1000),
    }
    if raw:
        payload["rawExcerpt"] = _excerpt(raw)
    return payload


# ─────────────────────────────────────────────────────────────────────────────
# GET /tools — read-only local tool catalog
# ─────────────────────────────────────────────────────────────────────────────


@router.get("/tools")
def list_tools() -> dict:
    """Return the local tool catalog. Listing only — nothing is executed or toggled."""
    cli_path, cli_source = resolve_cli()

    if cli_path is None:
        payload = _failure(
            "cli-missing",
            "找不到本机 shaoke-cli（企业副本应在引擎 home 的 bin 目录下）",
            None,
            cli_source,
        )
        stray = personal_cli_path()
        if stray:
            home = _hermes_home()
            expected = (home / "bin" / CLI_NAME) if home is not None else None
            payload["note"] = (
                f"PATH 上存在同名 CLI（个人副本）{stray}，已按企业口径忽略"
                + (f"；企业副本应为 {expected}" if expected is not None else "")
            )
        return payload

    try:
        completed = subprocess.run(
            [cli_path, "tools", "list"],
            capture_output=True,
            text=True,
            timeout=TOOLS_LIST_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return _failure("cli-failed", f"shaoke-cli tools list 超时（>{TOOLS_LIST_TIMEOUT_S}s）", cli_path, cli_source)
    except OSError as exc:
        return _failure("cli-failed", f"无法执行 shaoke-cli: {exc}", cli_path, cli_source)

    stdout = completed.stdout or ""
    stderr = completed.stderr or ""

    if completed.returncode != 0:
        return _failure(
            "cli-failed",
            f"shaoke-cli tools list 退出码 {completed.returncode}",
            cli_path,
            cli_source,
            raw=(stdout + ("\n" + stderr if stderr else "")),
        )

    try:
        parsed = json.loads(stdout)
    except (ValueError, TypeError):
        return _failure("not-json", "shaoke-cli tools list 输出不是 JSON", cli_path, cli_source, raw=stdout)

    services = parsed.get("data", {}).get("services") if isinstance(parsed, dict) else None
    if not isinstance(services, list):
        return _failure(
            "shape-mismatch",
            "shaoke-cli tools list 输出缺少 data.services 列表",
            cli_path,
            cli_source,
            raw=stdout,
        )

    # An empty list is a real, successful answer — not a failure.
    return {
        "ok": True,
        "systems": services,
        "count": len(services),
        "cliPath": cli_path,
        "cliSource": cli_source,
        "fetchedAt": int(time.time() * 1000),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Pack READ port (取数口) — the ONLY CLI-read door this backend opens
# ─────────────────────────────────────────────────────────────────────────────
#
# Design: docs/plankton/N7-technical-design/N7-20261006-plankton-session-packs.md
# §0 / §8 with the W5 ruling "取数口＝只读读路径". The pack renderer fetches its
# payload by reference key through the host bridge (``ctx.rest`` → here); this
# route runs the pack's DECLARED READ command read-only on the plugin's behalf,
# and answers in the same ``{kind, envelope}`` contract the desktop ``runRead``
# uses, so the renderer can feed the result straight into ``resolveOutput``.
#
# Fail-closed READ-ONLY (this door can never write):
#   * only templates in ``READ_TEMPLATES`` (kind:'read') may run — a write
#     template id is refused BEFORE any spawn (``read-path-cannot-use-write-template``);
#   * argv is built from the fixed table; a param whose flag is not declared for
#     that template is refused (``unknown-param``) ⇒ no free-text argv; array
#     args, ``shell=False``, timeout;
#   * no human-confirmation latch is consulted because there is nothing to
#     confirm — the route cannot reach a write command.
#
# Drift note: ``READ_TEMPLATES`` mirrors the pack declaration's read templates
# (``desktop/plugin.js``). A mismatch fails CLOSED (unknown template ⇒ refused);
# the parity is pinned by ``tests/test_plugin_api_pack_read.py``.
PACK_READ_TIMEOUT_S = 30
PACK_READ_PACKS = ("baymax",)
READ_TEMPLATES: dict = {
    "list-issues": {"module": "baymax", "command": "+issue-list", "required": ["project-id"], "optional": ["scene", "status", "assignee", "label-ids", "offset", "limit", "fields"]},
    "get-issue": {"module": "baymax", "command": "+issue-get", "required": ["project-id", "id"], "optional": []},
    "issue-history": {"module": "baymax", "command": "+issue-history", "required": ["project-id", "id"], "optional": []},
    "relation-list": {"module": "baymax", "command": "+relation-list", "required": ["issue-id"], "optional": []},
    "project-list": {"module": "baymax", "command": "+project-list", "required": [], "optional": ["offset", "limit"]},
    "project-get": {"module": "baymax", "command": "+project-get", "required": ["project-id"], "optional": []},
    "status-list": {"module": "baymax", "command": "+status-list", "required": ["project-id"], "optional": []},
    "type-list": {"module": "baymax", "command": "+type-list", "required": ["project-id"], "optional": []},
    "user-list": {"module": "baymax", "command": "+user-list", "required": [], "optional": []},
    "whoami": {"module": "baymax", "command": "+whoami", "required": [], "optional": []},
}


class PackReadRequest(BaseModel):
    packId: str = ""
    templateId: str = ""
    params: dict = {}


def _find_cli_envelope(text: str):
    """The CLI's discriminant is the envelope's ``ok``; failures go to stderr
    mixed with upgrade noise ⇒ whole-string JSON object first, else the LAST
    parseable JSON object line."""
    if not text:
        return None
    stripped = text.strip()
    try:
        whole = json.loads(stripped)
        if isinstance(whole, dict):
            return whole
    except (ValueError, TypeError):
        pass
    for line in reversed(stripped.splitlines()):
        candidate = line.strip()
        if not candidate.startswith("{"):
            continue
        try:
            parsed = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


# Control characters (C0 + DEL) can never legitimately appear in a CLI argv: a
# NUL byte makes ``subprocess`` raise ``ValueError: embedded null byte``, which
# used to escape the read door's except clause as an HTTP 500. The reference key
# is attacker-reachable (``…{key="list-issues?project-id=1%00"}``), so the door
# screens values at the INPUT layer.
_FORBIDDEN_ARGV_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def _has_forbidden_argv_char(value: object) -> bool:
    """True when a value carries a C0/DEL control character (incl. NUL).

    A NUL byte reaches this door through the reference key — a param value is
    ``decodeURIComponent``-decoded in the renderer, so ``…?project-id=1%00``
    arrives as ``"1\\x00"``. Handing that to ``subprocess.run`` raises
    ``ValueError: embedded null byte``; no flag value legitimately carries a
    control char, so the read door rejects such a value up front.
    """
    return bool(_FORBIDDEN_ARGV_CHARS.search(str(value)))


def _read_argv(template: dict, params: dict) -> Tuple[Optional[list], Optional[str]]:
    params = params or {}
    allowed = [str(f) for f in (list(template.get("required") or []) + list(template.get("optional") or []))]
    for flag in params:
        if str(flag) not in allowed:
            return None, f"unknown-param:{flag}"
    argv = [str(template["module"]), str(template["command"])]
    for flag in template.get("required") or []:
        value = params.get(str(flag))
        if value is None or str(value).strip() == "":
            return None, f"missing-param:{flag}"
        if _has_forbidden_argv_char(value):
            return None, f"control-char-in-param:{flag}"
        argv += [f"--{flag}", str(value)]
    for flag in template.get("optional") or []:
        value = params.get(str(flag))
        if value is None or str(value).strip() == "":
            continue
        if _has_forbidden_argv_char(value):
            return None, f"control-char-in-param:{flag}"
        argv += [f"--{flag}", str(value)]
    return argv, None


@router.post("/packs/read")
def pack_read(req: PackReadRequest) -> dict:
    """Run ONE declared READ command read-only (the pack renderer's 取数口)."""
    if req.packId not in PACK_READ_PACKS:
        return {"kind": "rejected", "note": "pack-not-declared"}
    template = READ_TEMPLATES.get(req.templateId)
    if template is None:
        # A write template id (or anything not in the read table) is refused here
        # BEFORE any spawn — this door can never write.
        return {"kind": "rejected", "note": "read-path-cannot-use-write-template"}

    params = {str(k): str(v) for k, v in (req.params or {}).items()}
    argv, refusal = _read_argv(template, params)
    if refusal is not None:
        return {"kind": "rejected", "note": refusal}

    cli_path, _source = resolve_cli()
    if cli_path is None:
        return {"kind": "spawn-error", "note": "cli-not-found"}

    try:
        completed = subprocess.run(
            [cli_path, *argv],
            capture_output=True,
            text=True,
            timeout=PACK_READ_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"kind": "timeout", "note": "read-unknown"}
    except ValueError as exc:
        # Defence in depth: argv is already screened for control chars above, so
        # this should be unreachable — but an unexpected ``ValueError`` from
        # ``subprocess`` (e.g. an embedded NUL that slipped a future edit) must
        # still degrade to a typed answer, never an HTTP 500.
        return {"kind": "rejected", "note": f"invalid-argv:{exc}"}
    except OSError as exc:
        return {"kind": "spawn-error", "note": f"cli-failed:{exc}"}

    envelope = _find_cli_envelope(completed.stdout) or _find_cli_envelope(completed.stderr)
    if envelope is None or not isinstance(envelope.get("ok"), bool):
        return {"kind": "unparsed", "rc": completed.returncode, "note": "read-failed"}
    if envelope.get("ok") is not True:
        return {"kind": "rejected", "rc": completed.returncode, "note": "read-failed"}
    return {"kind": "ok", "rc": completed.returncode, "envelope": envelope}


# ─────────────────────────────────────────────────────────────────────────────
# POST /packs/proposal — the agent's DRAFT-PROPOSAL outbox read (批 3)
# ─────────────────────────────────────────────────────────────────────────────
#
# Design: docs/plankton/N7-technical-design/N7-20261006-plankton-session-packs.md
# §0 / §8 (批 3 · 新建草稿卡的提案入口, Perry 2026-10-07 裁定「要」). The
# `plankton-baymax-new` block has NO ledger object to read — its content is the
# agent's own draft, handed to the plugin through the ONE agent tool
# (`proposals.py`). So the renderer resolves THAT block's reference key here
# instead of at `/packs/read`.
#
# READ-ONLY for the ledger: this route never spawns shaoke-cli, never writes and
# never consults a confirmation. It only looks the ref up in the outbox; an
# unknown / expired / wrong-namespace ref answers `kind:"rejected"`, which the
# renderer degrades to text (content kept). The write path is untouched: it stays
# the W3 action layer behind the session identity + the human confirm.
PACK_PROPOSAL_PACKS = ("baymax",)
_PROPOSALS_MODULE_NAME = "plankton_enterprise_proposals"
_PROPOSALS_PATH = Path(__file__).resolve().parent.parent / "proposals.py"


def _proposals_module():
    """Import the outbox module by absolute path under a FIXED name.

    The dashboard loader imports THIS file as a standalone module (no package
    context), so a relative import is not available; the fixed name still makes
    ``__init__.py`` and this backend share ONE instance per process.
    """
    module = sys.modules.get(_PROPOSALS_MODULE_NAME)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(_PROPOSALS_MODULE_NAME, _PROPOSALS_PATH)
    if spec is None or spec.loader is None:  # pragma: no cover - artifact defect
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[_PROPOSALS_MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


class PackProposalRequest(BaseModel):
    packId: str = ""
    ref: str = ""


@router.post("/packs/proposal")
def pack_proposal(req: PackProposalRequest) -> dict:
    """Resolve ONE draft-proposal reference key (the new-draft block's 取数口).

    Read-only; never spawns; never writes the ledger. A refusal is typed so the
    renderer can degrade to text with the reason visible.
    """
    if req.packId not in PACK_PROPOSAL_PACKS:
        return {"kind": "rejected", "note": "pack-not-declared"}
    proposals = _proposals_module()
    if proposals is None:  # pragma: no cover - artifact defect
        return {"kind": "rejected", "note": "proposal-store-unavailable"}
    entry = proposals.get_proposal(req.ref, pack_id=req.packId)
    if entry is None:
        # Malformed / unknown / expired / another pack's ref — all the same
        # answer on purpose: a dead reference must not yield a half-card.
        return {"kind": "rejected", "note": "proposal-unresolved"}
    return {"kind": "ok", "proposal": entry}


# ─────────────────────────────────────────────────────────────────────────────
# Skill market — request models / policy gates
# ─────────────────────────────────────────────────────────────────────────────


class InstallRequest(BaseModel):
    slug: str = ""
    reference: str = ""
    name: str = ""
    category: str = ""
    version: str = ""
    # ``confirm`` is the human-confirmation latch: EVERY write route refuses
    # without it (the UI always sends it after its confirmation dialog).
    confirm: bool = False
    # Explicit acknowledgement that this write may rmtree-replace content the
    # user edited locally (on-disk hash ≠ the engine's recorded hash). The UI
    # sends it only after its dialog warns, in plain language, that the local
    # changes will be lost. Mirrors the engine's own do_update --force choice.
    overwriteLocalEdits: bool = False
    pickedBy: str = ""


class UninstallRequest(BaseModel):
    reference: str = ""
    installPath: str = ""
    confirm: bool = False


class ToggleRequest(BaseModel):
    name: str = ""
    enabled: bool = True
    # Enabling/disabling writes the engine's config, so the backend requires the
    # same human-confirmation latch as the store-writing routes.
    confirm: bool = False


# ─────────────────────────────────────────────────────────────────────────────
# 批 4 · W1 — 会话级审计单元生产者（只读预览；**不上传**）
#
# N7 §8 W1 / §2 / §9.0：本段只落「单元生产者」与「应用发稳定 profileId」两件事，
# **不实现上传**（W2 才落接收端点）。两条路由都**只读**：`/audit/unit` 以 `mode=ro` 读引擎
# 会话事实库 `state.db`；`/audit/profile-id` 只在**企业 home**内首次纳管时落一份台账。
# 没有凭据、没有上传、没有对台账/会话库的写入（读写台账是「发号」本身的持久化，非审计上传）。
# ─────────────────────────────────────────────────────────────────────────────

_AUDIT_MODULE_NAME = "plankton_enterprise_audit_unit"
_AUDIT_PATH = Path(__file__).resolve().parent.parent / "audit_unit.py"


def _audit_module():
    """按绝对路径、固定名导入审计单元模块（与 _proposals_module 同法，保证一进程一实例）。"""
    module = sys.modules.get(_AUDIT_MODULE_NAME)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(_AUDIT_MODULE_NAME, _AUDIT_PATH)
    if spec is None or spec.loader is None:  # pragma: no cover - artifact defect
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[_AUDIT_MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


@router.get("/audit/profile-id")
def audit_profile_id(profile: str = "", name: str = "", aliases: str = "") -> dict:
    """应用发**稳定 `profileId`**（企业 home 首次纳管生成并持久化；PLK-REQ-0049）。

    `profile` 是 profile 的**稳定身份**（其 home 目录），**不是**名字：名字变/重名不影响 ID。
    只读语义：除首次纳管把 ID 落到企业 home 台账外，什么都不写、不上传。
    """
    audit = _audit_module()
    if audit is None:  # pragma: no cover - artifact defect
        return {"kind": "rejected", "note": "audit-module-unavailable"}
    home = _hermes_home()
    if home is None:
        return {"kind": "rejected", "note": "enterprise-home-unavailable"}
    alias_list = [a for a in (aliases or "").split(",") if a.strip()]
    try:
        return audit.resolve_profile_id(profile or "default", profile_name=name, aliases=alias_list, home=home)
    except audit.AuditUnitRefused as exc:
        return {"kind": "rejected", "note": exc.note}


@router.get("/audit/unit")
def audit_unit(
    session: str = "",
    profile: str = "",
    name: str = "",
    db: str = "",
    variant: str = "plankton",
    engineVersion: str = "",
    appVersion: str = "",
    project: str = "",
) -> dict:
    """组出该会话的**审计单元（客户端上送段）**——只读预览，**不发送**（N7 §8 W1）。

    素材只读取自会话事实库（默认 `HERMES_HOME/state.db`；可指向企业 home 内的另一只读库，供夹具/
    素材读取点注入）。人这一方恒为空（服务端盖章），agent 这一方全 self-reported；组完过密钥/键
    卫生扫描，命中即拒（不产）。**任何路径都必须落在企业 home 内**——越界即拒（不读企业 home 外的库）。
    """
    audit = _audit_module()
    if audit is None:  # pragma: no cover - artifact defect
        return {"kind": "rejected", "note": "audit-module-unavailable"}
    home = _hermes_home()
    if home is None:
        return {"kind": "rejected", "note": "enterprise-home-unavailable"}
    # 会话素材读取点：默认引擎事实库；显式 `db` 必须落在企业 home 内（只读、越界拒）。
    db_path = Path(os.path.expanduser(db)) if db.strip() else (home / "state.db")
    try:
        home_real = Path(home).expanduser().resolve()
        db_real = db_path.resolve()
        if str(db_real) != str(home_real) and home_real not in db_real.parents:
            return {"kind": "rejected", "note": "session-db-outside-enterprise-home"}
    except OSError:  # pragma: no cover - 环境相关
        return {"kind": "rejected", "note": "session-db-unresolvable"}
    try:
        messages = audit.read_session_chat(db_real, session)
        resolved = audit.resolve_profile_id(profile or "default", profile_name=name, home=home)
        unit = audit.assemble_audit_unit(
            engine_session_id=session,
            messages=messages,
            profile_name=name,
            profile_id=resolved["profileId"],
            variant=variant,
            engine_version=engineVersion,
            project=project,
            client=audit.AUDIT_CLIENT_ID,
            app_version=appVersion,
        )
    except audit.AuditUnitRefused as exc:
        return {"kind": "rejected", "note": exc.note}
    return {"kind": "ok", "unit": unit}


def assert_outside_personal_trees(directory: Path, personal_home: Optional[Path] = None) -> None:
    """POLICY gate: refuse an engine store that resolves inside a personal tree.

    PLK-REQ-0023's red line. This is a compare-and-refuse assertion only: it
    never selects, builds or returns a write target (the engine does that), and
    there is NO "somewhere else" fallback. Raises ``ValueError``.
    """
    base = (personal_home or Path(os.path.expanduser("~"))).resolve()
    target = Path(directory).resolve()
    for tree in PERSONAL_TREES:
        personal = (base / tree).resolve()
        if target == personal or str(target).startswith(str(personal) + os.sep):
            raise ValueError(f"落点落在个人环境内（{tree}），拒绝取用：{target}")


def _enterprise_home_usable(home: Path) -> Tuple[bool, str]:
    """The enterprise home must exist and be writable, or we refuse to act."""
    if not home.exists():
        return False, "企业侧引擎 home 未初始化（目录不存在），请先让管理员为本机完成企业安装"
    if not home.is_dir():
        return False, "企业侧引擎 home 不是目录"
    if not os.access(home, os.W_OK):
        return False, "企业侧引擎 home 不可写，请联系企业支持"
    return True, ""


# ─────────────────────────────────────────────────────────────────────────────
# STARTUP SELF-CHECK — a MINIMAL, fail-closed path-chain guard
# ─────────────────────────────────────────────────────────────────────────────
#
# WHY ONLY THE PATH CHAIN (Perry 2026-10: 门禁不宜重于功能)
# ---------------------------------------------------------------------------
# ONE defect below this plugin has a real consequence (KI-PLANKTON-0072): the
# engine's ``tools.skills_hub_install._resolve_lock_install_path`` walks the
# components BELOW ``SKILLS_DIR`` and never inspects the store root itself
# (``Path.resolve()`` flattens it). So making ``<HERMES_HOME>/skills`` — or any
# component between the store and the enterprise home — a symlink to a directory
# OUTSIDE the store makes the engine land a bundle 仓外 and answer success,
# through OUR routes, with ``ok: true`` (verified — batch-2 §11 evidence).
#
# Every other structural "check" an earlier iteration carried (is the engine's
# install record a regular / readable / sanely-permissioned file?) has NO
# comparable consequence and is deliberately NOT a gate any more. Gating it grew
# a machine-gate far heavier than the feature it guarded ("门禁不宜重于功能"),
# while the record's real problems — unreadable, corrupt, absent — are ALREADY
# reported truthfully by the existing engine probe (``_probe_lock_file`` →
# ``lockNote``) and the existing content gates (``local-edits`` / ``no-record``
# with the explicit overwrite ack). Those checks were removed outright, not
# downgraded, so no second drifting opinion of the record survives here.
#
# WHAT THIS IS (and is not)
# ---------------------------------------------------------------------------
# A STRUCTURAL, fail-closed self-check consulted by every write route, plus a
# verdict the read page shows — never a silent downgrade. It does NOT re-
# implement landing semantics (§9.2: no second implementation to drift from);
# it only decides whether OUR write routes may run against a store whose path
# chain contains a redirect.
#
# TRUST BOUNDARY — why the walk starts at ``HERMES_HOME``'s PARENT
# -------------------------------------------------------------------
# The boundary is ``HERMES_HOME.parent``; only components AT or BELOW
# ``HERMES_HOME`` are inspected. Anything above it (``/``, ``/var``, ``/tmp``,
# ``/Users``) is TRUSTED and never walked — deliberately, because on macOS
# ``/var`` is itself a symlink to ``/private/var`` and walking above the home
# would refuse a perfectly ordinary enterprise home under ``/var/folders/…``.

SELF_CHECK_KIND = "write-guard-failed"

# The closed set of checks this guard can raise. Closed so the UI/report can
# never render an unrecognised finding as "fine".
SELF_CHECK_NAMES = (
    "symlink-in-path-chain",   # the store root itself, or a component above it
    "path-lstat-failed",       # a chain component could not be inspected
    "store-unresolved",        # the store/home could not be named (precondition)
)


def _lexical(path: Any) -> Path:
    """``abspath`` semantics: collapses ``.``/``..`` and ``//`` WITHOUT following
    symlinks (``Path.resolve()`` would flatten exactly the redirects we look for)."""
    return Path(os.path.abspath(os.fspath(path)))


def _components_below(boundary: Path, target: Path) -> Optional[list]:
    """The path components STRICTLY below ``boundary``, ending at ``target``.

    ``None`` when ``target`` is not (lexically) below ``boundary`` — the caller
    then re-anchors the boundary at the target's own parent.
    """
    base = _lexical(boundary)
    tip = _lexical(target)
    try:
        relative = tip.relative_to(base)
    except ValueError:
        return None
    parts = relative.parts
    return [base.joinpath(*parts[: index + 1]) for index in range(len(parts))]


def check_skills_root_chain(home: Path, skills_path: Path,
                            boundary: Optional[Path] = None) -> dict:
    """Assert the skill store's own path chain contains NO symbolic link.

    Inspects the store root ITSELF and every component between it and the trust
    boundary (``HERMES_HOME``'s parent by default — see the section note). This
    is the check the engine's ``_resolve_lock_install_path`` structurally cannot
    perform, because it resolves the root away before walking the children.
    """
    base = _lexical(boundary) if boundary is not None else _lexical(Path(home).parent)
    chain = _components_below(base, skills_path)
    if chain is None:
        # A store outside the home's boundary: re-anchor at the store's own
        # parent so at least the root itself is inspected.
        base = _lexical(skills_path).parent
        chain = _components_below(base, skills_path) or []
    root = _lexical(skills_path)
    findings: list = []
    checked: list = []
    for component in chain:
        checked.append(str(component))
        try:
            is_link = component.is_symlink()
        except OSError as exc:  # noqa: BLE001 - unreadable chain is fail-closed
            findings.append({
                "check": "path-lstat-failed",
                "layer": "skills-root" if component == root else "path-chain",
                "path": str(component),
                "message": f"技能路径链上这一层无法检查（{exc}）",
            })
            continue
        if not is_link:
            continue
        try:
            target = os.readlink(component)
        except OSError:
            target = "?"
        findings.append({
            "check": "symlink-in-path-chain",
            "layer": "skills-root" if component == root else "path-chain",
            "path": str(component),
            "linkTarget": str(target),
            "message": (
                f"技能根目录本身是符号链接，指向 {target}"
                if component == root
                else f"技能路径链上的 {component} 是符号链接，指向 {target}"
            ),
        })
    return {"ok": not findings, "findings": findings, "boundary": str(base), "checked": checked}


def run_startup_self_check(home: Optional[Path] = None, skills_path: Optional[Path] = None) -> dict:
    """The whole verdict: the store's path chain. Pure, never writes.

    Returns ``{ok, findings, ...}``. ``ok is False`` means the write routes must
    refuse (fail-closed); the read routes still answer and carry it.
    """
    resolved_home = Path(home) if home is not None else _hermes_home()
    resolved_skills = Path(skills_path) if skills_path is not None else engine_skills_dir()
    if resolved_home is None or resolved_skills is None:
        missing = "引擎 home" if resolved_home is None else "引擎技能目录"
        return {
            "ok": False, "kind": SELF_CHECK_KIND,
            "findings": [{
                "check": "store-unresolved", "layer": "engine-home",
                "message": f"无法确定{missing}，写路径自检无法成立（fail-closed）",
            }],
            "home": None if resolved_home is None else str(resolved_home),
            "skillsPath": None if resolved_skills is None else str(resolved_skills),
            "boundary": None,
            "checkedAt": int(time.time() * 1000),
        }

    chain = check_skills_root_chain(resolved_home, resolved_skills)
    return {
        "ok": not chain["findings"],
        "kind": None if not chain["findings"] else SELF_CHECK_KIND,
        "findings": list(chain["findings"]),
        "home": str(resolved_home),
        "skillsPath": str(resolved_skills),
        "boundary": chain.get("boundary"),
        "pathChain": chain,
        "checkedAt": int(time.time() * 1000),
    }


def _self_check_summary(result: dict) -> str:
    """One human line naming EVERY failed check and the layer it failed at."""
    parts = []
    for finding in result.get("findings") or []:
        layer = finding.get("layer") or "?"
        where = finding.get("path") or layer
        parts.append(f"[{finding.get('check')} @ {layer}] {where}：{finding.get('message')}")
    return "；".join(parts) if parts else "（自检通过）"


# The loud channel: one log line per distinct verdict signature, so a failing
# self-check is OBSERVABLE (journal/log) and not merely a JSON field. Writes are
# rare and a failing guard log line is exactly what an operator must see.
_SELF_CHECK_LOGGED: dict = {}


def write_path_guard(home: Optional[Path] = None, skills_path: Optional[Path] = None) -> dict:
    """Consult (and, on first readiness, log) the write-path self-check.

    Called by EVERY write route AND by the read page. Deliberately NOT cached to
    a pass: a redirect planted after startup is caught on the next write — the
    "startup" verdict is this same function's first evaluation, and re-evaluating
    a handful of ``lstat`` calls is not a cost worth a stale fail-open window.
    """
    result = run_startup_self_check(home, skills_path)
    signature = (
        result.get("ok"),
        result.get("home"),
        result.get("skillsPath"),
        tuple(sorted({str(f.get("check")) for f in result.get("findings") or []})),
    )
    if signature not in _SELF_CHECK_LOGGED:
        _SELF_CHECK_LOGGED[signature] = True
        if result.get("ok"):
            logger.info(
                "技能写路径自检通过：技能根 %s（受信边界 %s）",
                result.get("skillsPath"), result.get("boundary"),
            )
        else:
            logger.error(
                "技能写路径自检未通过 —— 已按 fail-closed 拒绝全部写动作（取用/卸载/启用/停用/更新）。%s",
                _self_check_summary(result),
            )
    return result


def _write_guard_refusal(guard: dict, **context: Any) -> dict:
    """The refusal payload every write route returns while the self-check fails."""
    detail: dict = {
        "reason": "技能写路径自检未通过，已按 fail-closed 拒绝这次写动作",
        "summary": _self_check_summary(guard),
        "findings": guard.get("findings") or [],
        "checks": [str(f.get("check")) for f in guard.get("findings") or []],
        "skillsPath": guard.get("skillsPath"),
        "boundary": guard.get("boundary"),
    }
    detail.update(context)
    return {"ok": False, "kind": SELF_CHECK_KIND, "detail": detail}


def _require_write_guard(home: Optional[Path], skills_path: Optional[Path],
                         **context: Any) -> Optional[dict]:
    """``None`` when the write may proceed; the refusal payload when it may not.

    THIS is the single enforcement point every write route funnels through — the
    probe ``test_every_write_route_consults_the_write_guard`` fails if one stops.
    """
    guard = write_path_guard(home, skills_path)
    if guard.get("ok"):
        return None
    return _write_guard_refusal(guard, **context)


def _skill_reference(entry: dict) -> str:
    """Stable identity: ``install.reference`` when present, else ``slug``."""
    install = entry.get("install") if isinstance(entry, dict) else None
    ref = ""
    if isinstance(install, dict):
        ref = str(install.get("reference") or "").strip()
    return ref or str(entry.get("slug") or "")


# ── engine facts we reference (never re-implement) ───────────────────────────


def engine_content_hash(target: Path) -> Optional[str]:
    """The engine's own ``tools.skills_guard.content_hash`` over ``target``.

    Imported live from the running engine so the digest CANNOT diverge from the
    engine's. Returns ``None`` when the import or the read fails — "cannot
    decide" is reported as such, never guessed.
    """
    try:
        from tools.skills_guard import content_hash  # type: ignore
    except Exception:
        return None
    try:
        return str(content_hash(Path(target)))
    except Exception:
        return None


def plan_install_path(name: str, category: str) -> Optional[str]:
    """The landing the ENGINE will compute for ``(name, category)``, or ``None``.

    Thin wrapper over :func:`plan_install_path_ex` that drops the failure kind.
    Display/comparison ONLY: nothing here is ever handed to a write. The write
    target is decided by the engine inside ``install_from_quarantine``.
    """
    return plan_install_path_ex(name, category)[0]


def plan_install_path_ex(name: str, category: str) -> Tuple[Optional[str], Optional[str]]:
    """``(planned, engine_error_kind)`` for ``(name, category)``.

    ``engine_error_kind`` is ``"engine-unavailable"`` when the engine's own
    validation module cannot be imported (a MISSING ENGINE, not a bad name), so
    the caller reports ``engine-unavailable`` instead of mislabelling it
    ``bad-input``. For a name/category the engine's rules reject, the kind is
    ``None`` (a genuine ``bad-input``).

    Calls the engine's own ``_validate_skill_name`` / ``_validate_install_parent_path``
    — the exact pair ``tools.skills_hub_install.install_from_quarantine`` uses to
    build ``install_rel_path``.
    """
    try:
        from tools.skills_hub_models import (  # type: ignore
            _validate_install_parent_path, _validate_skill_name)
    except Exception:  # noqa: BLE001 - the engine's validation module is absent
        return None, "engine-unavailable"
    try:
        safe_name = _validate_skill_name(str(name or ""))
        raw_category = str(category or "").strip()
        safe_category = _validate_install_parent_path(raw_category) if raw_category else ""
    except Exception:  # noqa: BLE001 - the engine's rules rejected the pair
        return None, None
    return (f"{safe_category}/{safe_name}" if safe_category else safe_name), None


def read_engine_installations() -> Tuple[list, Optional[str]]:
    """The engine's OWN install records — ``tools.skills_hub.HubLockFile``.

    This replaces the plugin's former private ledger (see the module docstring):
    the engine's lock file is the single source of truth for "what is installed,
    where, and with what content hash".

    The engine's ``_JsonStateFile._read`` SILENTLY substitutes its empty shape
    when the file is corrupt, so from the engine's side alone a corrupt lock and
    a never-used lock look identical. This function PROBES the file FIRST, so an
    unreadable/corrupt lock yields an empty list PLUS a note naming the problem —
    never a bare "0 records" that reads as "you never installed anything".
    """
    note = _probe_lock_file()
    try:
        from tools.skills_hub import HubLockFile  # type: ignore

        return list(HubLockFile().list_installed()), note
    except Exception as exc:  # noqa: BLE001
        return [], note or f"引擎技能锁文件读取失败，按空处理：{exc}"


def _probe_lock_file() -> Optional[str]:
    """A note when the engine's lock file exists but is not a readable,
    expected-shape lock; ``None`` when it is absent (never installed) or valid."""
    path = _engine_lock_path()
    if path is None or not path.exists():
        return None
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        return f"引擎取用记录无法读取（文件不可读）：{exc}"
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError) as exc:
        return ("引擎取用记录已损坏（不是合法 JSON）：本页的「0 条」是「读不到记录」，"
                f"不是「从未装过」；卸载会报 no-record。{exc}")
    if not isinstance(parsed, dict) or not isinstance(parsed.get("installed", {}), dict):
        return "引擎取用记录形状异常（不是预期的 {version, installed} 结构）：本页的「0 条」不可信。"
    return None


def _shaoke_meta(entry: dict) -> dict:
    """Our platform facts, as stashed in the engine lock entry's metadata."""
    meta = entry.get("metadata")
    if not isinstance(meta, dict):
        return {}
    sub = meta.get("shaoke")
    return sub if isinstance(sub, dict) else {}


def _category_of(install_path: str) -> str:
    """``cat/sub/x`` → ``cat/sub``; a single-segment landing → ``""``."""
    parts = [p for p in str(install_path or "").split("/") if p]
    return "/".join(parts[:-1])


def _hash_state(recorded: Any, current: Optional[str]) -> str:
    """Compare the engine's recorded hash with the on-disk hash (逐字).

    ``match`` / ``mismatch`` / ``missing`` (没落点) / ``unknown`` (算不出)。
    Both sides come from engine facts; this only names the comparison.
    """
    rec = str(recorded or "").strip()
    if not current:
        return "missing"
    if not rec:
        return "unknown"
    return "match" if rec == current else "mismatch"


def _local_edit_verdict(entry: Optional[dict], install_rel: str,
                        skills_path: Optional[Path] = None) -> Optional[bool]:
    """The tri-state local-change verdict for ONE engine record vs ONE landing.

    ``True`` = the content drifted, ``False`` = the record's hash attests the
    on-disk content, ``None`` = cannot decide. See :func:`engine_local_edits`
    for the criterion and why a negative must be CONFIRMED rather than trusted.

    ``install_rel`` is the landing this app PLANS to write (the value the write
    gate passes as ``planned``); the engine's own predicate, however, answers
    about the landing the RECORD names, which can be a different directory —
    that is deliberate: it is the engine's criterion, taken as-is.
    """
    if not isinstance(entry, dict) or not entry:
        return None
    try:
        from hermes_cli.skills_hub import _has_local_edits  # type: ignore

        if _has_local_edits(entry):
            return True
    except Exception:  # noqa: BLE001 - fall through to our own comparison
        pass
    # Confirming the negative: the engine said "no edits", but it also says that
    # when the recorded hash is empty or the path could not be hashed. Compare
    # the record against the on-disk content ourselves; anything short of a
    # definite match is "cannot decide", never "clean".
    path = skills_path if skills_path is not None else engine_skills_dir()
    target = (path / install_rel) if (path and install_rel) else None
    current = engine_content_hash(target) if (target is not None and target.is_dir()) else None
    state = _hash_state(entry.get("content_hash"), current)
    if state == "match":
        return False
    if state == "mismatch":
        return True
    return None


def engine_local_edits(name: str, install_rel: str) -> Optional[bool]:
    """The engine's own local-change verdict for ``name`` landing at ``install_rel``.

    The criterion is the ENGINE's OWN predicate
    ``hermes_cli.skills_hub._has_local_edits`` — the very gate
    ``hermes_cli.skills_hub.do_update`` applies so an update never silently
    destroys the user's work — whose verdict is CONFIRMED with the same 逐字
    comparison ``_hash_state`` names.

    Returns ``True`` when the content drifted, ``False`` ONLY when a record
    attests that the on-disk content still matches, and ``None`` when neither
    test can decide. ``False`` is therefore NOT overloaded: a ``None`` here does
    NOT mean "no edits" and is never treated as such by the overwrite gate.

    Two different situations land on ``None``, both deliberately:
      * **no record names this skill** — an absent record cannot attest anything
        about a landing, so a landing that exists with no record of ours is
        "cannot confirm clean", not "clean";
      * **an unreadable/corrupt/shape-anomalous lock** — the engine's own
        ``_JsonStateFile._read`` swallows it into the empty shape, so NO record
        is visible either (and a shape-anomalous file raises on access); here,
        too, nothing can be attested. `_probe_lock_file()` is what NAMES that
        cause for the user; it does not change the verdict.
    """
    try:
        from tools.skills_hub import HubLockFile  # type: ignore

        entry = HubLockFile().get_installed(str(name))
    except Exception:  # noqa: BLE001 - an unreadable lock means "cannot decide"
        return None
    return _local_edit_verdict(entry, install_rel)


def _lock_entry_view(entry: dict, skills_path: Optional[Path], disabled_set: set) -> dict:
    """One engine lock entry, rendered for the page (engine facts only)."""
    install_path = str(entry.get("install_path") or "")
    platform = _shaoke_meta(entry)
    name = str(entry.get("name") or "")
    target = (skills_path / install_path) if (skills_path and install_path) else None
    on_disk = bool(target is not None and target.is_dir())
    current = engine_content_hash(target) if (on_disk and target is not None) else None
    return {
        "reference": str(entry.get("identifier") or ""),
        "slug": str(platform.get("slug") or ""),
        "name": name,
        "category": str(platform.get("category") or "") or _category_of(install_path),
        "version": str(platform.get("version") or ""),
        "contentHash": str(entry.get("content_hash") or ""),
        "installPath": install_path,
        "installedAt": str(entry.get("installed_at") or ""),
        "files": entry.get("files"),
        "source": str(entry.get("source") or ""),
        "scanVerdict": str(entry.get("scan_verdict") or ""),
        "trustLevel": str(entry.get("trust_level") or ""),
        # True when the entry is one THIS app handed to the engine (vs an engine
        # hub source the user installed through `hermes skills install`).
        "managedByApp": str(entry.get("source") or "") == ENGINE_SOURCE,
        "onDisk": on_disk,
        "localHash": current,
        "hashState": _hash_state(entry.get("content_hash"), current),
        # The engine's own local-change signal (recorded ≠ on-disk). Drives the
        # update overwrite warning; `mismatch` is the same fact `hashState` names.
        "localEdits": _hash_state(entry.get("content_hash"), current) == "mismatch",
        "disabled": (name in disabled_set) if disabled_set is not None else None,
    }


# ── CLI invocation (module-level for test injection) ─────────────────────────


def _exec_cli(cli_path: str, args: list, timeout_s: int) -> Tuple[int, str, str]:
    """Run the CLI. Raises ``FileNotFoundError`` for a missing binary."""
    completed = subprocess.run(
        [cli_path, *args],
        capture_output=True,
        text=True,
        timeout=timeout_s,
        check=False,
    )
    return completed.returncode, completed.stdout or "", completed.stderr or ""


def _classify_cli_failure(returncode: int, stdout: str, stderr: str) -> Tuple[str, str]:
    """Map a non-zero CLI exit to a DISTINGUISHABLE failure kind.

    The CLI writes its structured errors to stderr (and sometimes stdout), so
    both are inspected. Auth beats network beats generic.
    """
    blob = f"{stdout}\n{stderr}".lower()
    for token in _UNAUTH_TOKENS:
        if token in blob:
            return "unauthorized", "shaoke-cli 未授权：请先在 CLI 自己的终端里完成授权"
    for token in _NETWORK_TOKENS:
        if token in blob:
            return "network-failed", "无法连接企业 SkillHub（网络不可达或超时）"
    return "cli-failed", f"shaoke-cli 退出码 {returncode}"


def _envelope_error_kind(parsed: dict) -> Optional[str]:
    """Classify an ERROR that rides a JSON envelope on a rc=0 exit.

    Some CLI paths exit 0 yet put the error INSIDE the envelope (``ok:false`` or
    an ``error`` object). Reading that as an ordinary payload would surface a
    bogus ``shape-mismatch`` ("missing data.items") for what is really an
    unauthorized / network failure. Returns ``unauthorized`` / ``network-failed``
    when the envelope's own words name them, else ``None`` (leave it to the
    shape checks). A well-formed ``ok:true`` payload never matches.
    """
    if not isinstance(parsed, dict):
        return None
    if parsed.get("ok") is not False and "error" not in parsed:
        return None
    blob = json.dumps(parsed, ensure_ascii=False).lower()
    for token in _UNAUTH_TOKENS:
        if token in blob:
            return "unauthorized"
    for token in _NETWORK_TOKENS:
        if token in blob:
            return "network-failed"
    return None


def _run_cli_json(cli_path: str, args: list, timeout_s: int = SKILL_CLI_TIMEOUT_S) -> dict:
    """Run a CLI command and parse its JSON envelope.

    Returns ``{ok: True, parsed}`` or ``{ok: False, kind, detail}`` where kind is
    one of the failure taxonomy members. An empty-but-valid envelope is success.
    """
    try:
        returncode, stdout, stderr = _exec_cli(cli_path, args, timeout_s)
    except FileNotFoundError:
        return {"ok": False, "kind": "cli-missing", "detail": {"message": f"找不到可执行的 {CLI_NAME}"}}
    except subprocess.TimeoutExpired:
        return {"ok": False, "kind": "network-failed", "detail": {"message": f"shaoke-cli 超时（>{timeout_s}s）"}}
    except OSError as exc:
        return {"ok": False, "kind": "cli-failed", "detail": {"message": f"无法执行 shaoke-cli: {exc}"}}

    if returncode != 0:
        kind, message = _classify_cli_failure(returncode, stdout, stderr)
        return {"ok": False, "kind": kind, "detail": {"message": message, "raw": _excerpt(stdout + "\n" + stderr)}}

    try:
        parsed = json.loads(stdout)
    except (ValueError, TypeError):
        return {"ok": False, "kind": "not-json", "detail": {"raw": _excerpt(stdout)}}
    if not isinstance(parsed, dict):
        return {"ok": False, "kind": "shape-mismatch", "detail": {"raw": _excerpt(stdout)}}
    # rc=0 but the envelope itself carries the error → classify it, don't let the
    # missing data.items turn an auth/network failure into a "shape-mismatch".
    envelope_kind = _envelope_error_kind(parsed)
    if envelope_kind:
        return {
            "ok": False,
            "kind": envelope_kind,
            "detail": {"message": f"CLI 以退出码 0 返回了错误信封（{envelope_kind}）", "raw": _excerpt(stdout)},
        }
    return {"ok": True, "parsed": parsed}


def parse_skill_page(parsed: dict) -> dict:
    """Parse one ``skillhub +list`` page (already JSON-decoded).

    ``data.items`` must be a list; every item must carry a ``slug``. A
    half-shaped page is a ``shape-mismatch`` — never a partial list.
    """
    data = parsed.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return {"ok": False, "kind": "shape-mismatch", "detail": {"reason": "缺少 data.items 列表"}}
    skills = []
    for item in data["items"]:
        if not isinstance(item, dict):
            return {"ok": False, "kind": "shape-mismatch", "detail": {"reason": "items 元素不是对象"}}
        slug = str(item.get("slug") or "").strip()
        if not slug:
            return {"ok": False, "kind": "shape-mismatch", "detail": {"reason": "条目缺少 slug"}}
        tags = [t for t in (item.get("tags") or []) if isinstance(t, str)] if isinstance(item.get("tags"), list) else []
        skills.append(
            {
                "slug": slug,
                "reference": _skill_reference(item),
                "name": str(item.get("name") or ""),
                "description": str(item.get("description") or ""),
                "category": str(item.get("category") or ""),
                "version": str(item.get("version") or ""),
                "author": str(item.get("author") or ""),
                "tags": tags,
                "installPath": plan_install_path(str(item.get("name") or ""), str(item.get("category") or "")),
            }
        )
    cursor = data.get("nextCursor")
    next_cursor = None if cursor in (None, "") else str(cursor)
    return {"ok": True, "skills": skills, "nextCursor": next_cursor}


def fetch_catalog(cli_path: str, page_size: int = PAGE_SIZE, max_pages: int = MAX_PAGES) -> dict:
    """Page through ``skillhub +list`` to completion.

    Returns ``{ok: True, skills, pages, truncated}`` or ``{ok: False, kind,
    detail}``. An empty catalog is ``ok: True, skills: []`` — a real, successful
    answer. ``truncated`` is an EXPLICIT flag: when the CLI still reports a
    next cursor after ``max_pages`` the caller must not read the capped list as
    the whole catalog.
    """
    skills: list = []
    pages = 0
    page = 1
    more = False
    while page <= max_pages:
        res = _run_cli_json(cli_path, ["skillhub", "+list", "--page", str(page), "--page-size", str(page_size)])
        if not res["ok"]:
            return {"ok": False, "kind": res["kind"], "detail": res.get("detail")}
        parsed = parse_skill_page(res["parsed"])
        if not parsed["ok"]:
            return {"ok": False, "kind": parsed["kind"], "detail": parsed.get("detail"), "page": page}
        skills.extend(parsed["skills"])
        pages += 1
        more = bool(parsed["nextCursor"])
        if not more:
            break
        page += 1
    return {"ok": True, "skills": skills, "pages": pages, "truncated": more}


def fetch_disabled(cli_path: Optional[str] = None) -> dict:
    """The engine's disabled-skill set (``config.yaml`` → ``skills.disabled``).

    Read through the engine's OWN function so the value cannot diverge.
    """
    try:
        from hermes_cli.config import load_config  # type: ignore
        from hermes_cli.skills_config import get_disabled_skills  # type: ignore

        config = load_config()
        names = sorted(str(n) for n in get_disabled_skills(config))
        return {"ok": True, "names": names}
    except Exception as exc:
        return {"ok": False, "kind": "unreadable-config", "detail": {"message": str(exc)}}


def _derive_install_state(skill: dict, record: Optional[dict], on_disk: bool, disabled: Optional[bool]) -> str:
    """The already-installed state for one catalog entry (mirrors the old view).

    The RECORDED version is read from the ENGINE's own lock entry the way the
    engine stores it: our platform facts ride in ``metadata.shaoke`` (see the
    module docstring), and the entry has NO top-level ``version`` key — reading
    one returned ``""`` for every real install, which pinned the state at
    ``version-unknown`` and left the page's manage actions and the batch entry
    permanently disabled. Same source as ``recordedVersion`` so the two cannot
    disagree.
    """
    if not skill.get("installPath"):
        return "name-missing"
    if record and on_disk:
        if disabled is True:
            return "disabled"
        recorded = str(_shaoke_meta(record).get("version") or "").strip()
        catalog = str(skill.get("version") or "").strip()
        if recorded and catalog:
            return "consistent" if recorded == catalog else "version-differs"
        return "version-unknown"
    if record and not on_disk:
        return "record-without-files"
    if not record and on_disk:
        return "version-unknown"
    return "not-installed"


# ─────────────────────────────────────────────────────────────────────────────
# GET /skills
# ─────────────────────────────────────────────────────────────────────────────


@router.get("/skills")
def list_skills() -> dict:
    """The enterprise skill market: catalog + the ENGINE's own install facts.

    A catalog fetch failure is reported in a nested ``catalog`` block so the
    page can still render the local install facts and show the failure — a
    catalog that could not be fetched is NEVER rendered as "no skills".
    """
    home = _hermes_home()
    if home is None:
        return _failure("enterprise-home-unavailable", "无法确定企业侧引擎 home", None, "missing")

    skills_path = engine_skills_dir()
    if skills_path is None:
        return _failure("engine-unavailable", "引擎未提供技能目录（hermes_constants.get_skills_dir 不可用）", None, "missing")

    # The write-path self-check verdict — computed on FIRST READINESS (this
    # route is the first thing the page calls) and shown, so a store a write
    # would be refused against is never a surprise. The read surface keeps
    # working; only the write routes are gated.
    write_guard = write_path_guard(home, skills_path)

    try:
        assert_outside_personal_trees(skills_path)
    except ValueError as exc:
        return {
            "ok": False,
            "kind": "blocked-personal-dir",
            "error": str(exc),
            "skillsPath": str(skills_path),
            "writeGuard": write_guard,
            "fetchedAt": int(time.time() * 1000),
        }

    usable, reason = _enterprise_home_usable(home)
    if not usable:
        return {
            "ok": False,
            "kind": "enterprise-home-unavailable",
            "error": reason,
            "home": str(home),
            "skillsPath": str(skills_path),
            "fetchedAt": int(time.time() * 1000),
        }

    cli_path, cli_source = resolve_cli()

    # Local facts first — they do not depend on the network.
    lock_entries, lock_note = read_engine_installations()
    disabled_info = fetch_disabled()
    disabled_names = set(disabled_info.get("names") or []) if disabled_info.get("ok") else set()

    installed: list = [
        view
        for view in (
            _lock_entry_view(entry, skills_path, disabled_names)
            for entry in sorted(lock_entries, key=lambda e: str(e.get("name") or ""))
        )
        # Filter on the COMPUTED view: the raw engine entry has no `managedByApp`
        # key, so testing it there was dead code that never excluded anything. The
        # panel is scoped to skills THIS app handed the engine (source ==
        # ENGINE_SOURCE); engine-hub installs the user made themselves are not
        # enterprise pickups.
        if view.get("managedByApp") is not False
    ]

    # Catalog — may fail; the failure is surfaced, never hidden.
    if cli_path is None:
        catalog = {
            "ok": False,
            "kind": "cli-missing",
            "detail": {"message": "找不到企业副本 shaoke-cli"},
        }
        catalog_skills: list = []
    else:
        fetched = fetch_catalog(cli_path)
        if fetched["ok"]:
            catalog = {
                "ok": True,
                "count": len(fetched["skills"]),
                "pages": fetched.get("pages", 0),
                "truncated": bool(fetched.get("truncated")),
                "pageSize": PAGE_SIZE,
                "maxPages": MAX_PAGES,
            }
            catalog_skills = fetched["skills"]
        else:
            catalog = {"ok": False, "kind": fetched["kind"], "detail": fetched.get("detail")}
            catalog_skills = []

    by_ref: dict = {}
    by_landing: dict = {}
    by_name: dict = {}
    for entry in lock_entries:
        ref = str(entry.get("identifier") or "")
        if ref:
            by_ref.setdefault(ref, entry)
        landing = str(entry.get("install_path") or "")
        if landing:
            by_landing.setdefault(landing, entry)
        name = str(entry.get("name") or "")
        if name:
            by_name.setdefault(name, entry)

    enriched: list = []
    for skill in catalog_skills:
        install_path = skill.get("installPath")
        target = (skills_path / install_path) if install_path else None
        on_disk = bool(target is not None and target.is_dir())
        current = engine_content_hash(target) if (on_disk and target is not None) else None
        entry = by_ref.get(skill["reference"]) or (by_landing.get(install_path) if install_path else None)
        entry_attested = bool(entry) and _hash_state(entry.get("content_hash"), current) == "match"
        effective_entry = entry if entry_attested else None
        hash_state = _hash_state(entry.get("content_hash"), current) if entry else None
        # The permission state the write gate refuses without an explicit ack,
        # computed with the GATE'S OWN function and the GATE'S OWN record lookup
        # (by name — the key the engine's lock file uses, the key the write body
        # carries). Deriving it from this entry's landing/hashState instead left
        # the page unable to reach the acknowledgement in two shapes: the engine
        # predicate answers about the landing the RECORD names (which can differ
        # from the planned one), and a landing with NO record at all is not
        # "clean" either. Both are `True`/`None` here, so the page can say so and
        # send `overwriteLocalEdits`.
        name_record = by_name.get(str(skill.get("name") or ""))
        verdict = _local_edit_verdict(name_record, install_path, skills_path) if install_path else None
        local_edits = verdict is True
        local_edits_unknown = bool(verdict is None and on_disk)
        disabled_flag = None
        if disabled_info.get("ok"):
            disabled_flag = str(skill.get("name") or "").strip() in disabled_names
        enriched.append(
            {
                **skill,
                "onDisk": on_disk,
                "installState": _derive_install_state(skill, effective_entry if on_disk else None, on_disk, disabled_flag),
                "recordedVersion": str(_shaoke_meta(effective_entry).get("version") or "") if effective_entry else "",
                "localHash": current,
                "hashState": hash_state,
                "localEdits": local_edits,
                "localEditsUnknown": local_edits_unknown,
                # The landing the engine's RECORD names, so the page can show a
                # plan/record split instead of silently writing to a different
                # slot than the one the refusal was about.
                "recordInstallPath": str((name_record or {}).get("install_path") or ""),
                "disabled": disabled_flag,
                # Engine facts the UI uses to warn before an overwrite: the slot
                # exists on disk but no engine record of ours claims it.
                "ownedByEngine": bool(entry),
            }
        )

    lock_path = _engine_lock_path()
    return {
        "ok": True,
        "skills": enriched,
        "installed": installed,
        "catalog": catalog,
        "disabled": disabled_info,
        "count": len(enriched),
        "home": str(home),
        "skillsPath": str(skills_path),
        "lockPath": str(lock_path) if lock_path is not None else None,
        "lockNote": lock_note,
        # The startup self-check verdict the page renders (fail-closed fact).
        "writeGuard": write_guard,
        "cliPath": cli_path,
        "cliSource": cli_source,
        "personalCliPath": personal_cli_path() if cli_path is None else None,
        "fetchedAt": int(time.time() * 1000),
    }


def _engine_lock_path() -> Optional[Path]:
    """The engine's hub lock file path (display only)."""
    try:
        from tools.skills_hub import _lock_file  # type: ignore

        return Path(_lock_file())
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Write path — install / update / uninstall / enable / disable
#
# Nothing below computes a landing, writes a file, or removes a directory.
# Every mutation is a call into the engine's own skill-management entry points;
# our job is parameter validation, the confirmation latch, failure translation
# and truthful presentation of what the engine did.
# ─────────────────────────────────────────────────────────────────────────────


def _http_get(url: str, timeout_s: int = SKILL_CLI_TIMEOUT_S) -> bytes:
    """Fetch bytes from a presigned bundle URL. Module-level for test injection."""
    with urllib.request.urlopen(url, timeout=timeout_s) as response:  # noqa: S310 - CLI-provided presigned URL
        return response.read()


def _zip_entries(buffer: bytes) -> list:
    """Read a zip into ``[(posix_rel_path, bytes)]``.

    ZIP entry names are decoded UTF-8 when the UTF-8 flag is set; otherwise the
    raw bytes are recovered from Python's cp437 fallback and re-decoded as UTF-8
    (then GBK). This mirrors what the CLI actually ships (names carry no flag).
    """
    entries: list = []
    with zipfile.ZipFile(io.BytesIO(buffer)) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            name = info.filename
            if not (info.flag_bits & 0x800):
                try:
                    raw = name.encode("cp437")
                    try:
                        name = raw.decode("utf-8")
                    except UnicodeDecodeError:
                        name = raw.decode("gbk")
                except (UnicodeEncodeError, UnicodeDecodeError):
                    pass
            entries.append((name.replace("\\", "/"), archive.read(info)))
    return entries


def strip_top_dir(entries: list) -> list:
    """Drop a single shared top-level directory (skillhub ships ``<name>/…``).

    A single ROOT-LEVEL file (e.g. a lone ``SKILL.md``) must NOT be mistaken for
    a directory — that would strip the only file and read as an empty package.
    """
    files = [(p, d) for p, d in entries if p and not p.endswith("/")]
    if not files:
        return []
    if any("/" not in p for p, _ in files):
        return files
    tops = {p.split("/")[0] for p, _ in files}
    if len(tops) != 1:
        return files
    top = next(iter(tops))
    stripped = [(p[len(top) + 1 :], d) for p, d in files]
    return [(p, d) for p, d in stripped if p]


def _download_bundle_entries(cli_path: str, slug: str) -> dict:
    """Fetch the skill zip through the CLI's presigned URL and unpack it.

    ``{ok: True, entries}`` or ``{ok: False, kind, detail}``. The zip's own shape
    is normalized here (top-dir strip, UTF-8 name recovery); the RULES that
    decide whether a member path or skill name is acceptable belong to the
    engine and are enforced by ``quarantine_bundle``.
    """
    dl = _run_cli_json(cli_path, ["skillhub", "+download", "--slug", slug], SKILL_CLI_TIMEOUT_S)
    if not dl["ok"]:
        blob = json.dumps(dl.get("detail") or {}, ensure_ascii=False)
        if dl["kind"] == "cli-failed" and ("无 zip 包" in blob or "404" in blob):
            return {"ok": False, "kind": "no-bundle", "detail": {"reason": "平台侧这条技能没有包"}}
        return {"ok": False, "kind": dl["kind"], "detail": dl.get("detail")}

    url = ""
    payload = dl["parsed"].get("data")
    if isinstance(payload, dict):
        url = str(payload.get("url") or "")
    if not url:
        return {"ok": False, "kind": "shape-mismatch", "detail": {"reason": "download 响应里没有 data.url"}}

    try:
        buffer = _http_get(url)
    except Exception as exc:  # noqa: BLE001 - transport shape is unknown
        return {"ok": False, "kind": "download-failed", "detail": {"message": str(exc)}}

    try:
        entries = strip_top_dir(_zip_entries(buffer))
    except Exception as exc:  # noqa: BLE001 - a corrupt archive
        return {"ok": False, "kind": "extract-failed", "detail": {"message": str(exc)}}
    if not entries:
        return {"ok": False, "kind": "extract-failed", "detail": {"message": "包里没有文件"}}
    return {"ok": True, "entries": entries}


def _scan_findings(scan_result: Any, limit: int = 10) -> list:
    """A small, honest digest of the engine's scan findings."""
    out: list = []
    for finding in list(getattr(scan_result, "findings", None) or [])[:limit]:
        out.append(
            {
                "severity": str(getattr(finding, "severity", "") or ""),
                "category": str(getattr(finding, "category", "") or ""),
                "file": str(getattr(finding, "file", "") or ""),
                "line": getattr(finding, "line", None),
                "description": str(getattr(finding, "description", "") or ""),
            }
        )
    return out


def _install_skill(data: InstallRequest, *, require_confirm: bool = False) -> dict:
    """Install (or refresh) one skill by handing the bundle to the ENGINE.

    Returns the engine's outcome translated into this API's envelope. No landing
    is computed, no directory is written and no directory is removed here — the
    engine's ``install_from_quarantine`` owns all of that (including the
    symlink / nesting / category-bucket refusals, which surface as
    ``engine-refused`` carrying the engine's own message).
    """
    slug = (data.slug or "").strip()
    if not slug:
        return {"ok": False, "kind": "bad-input", "detail": {"reason": "slug 为空"}}
    reference = (data.reference or "").strip() or slug
    planned, plan_error = plan_install_path_ex(data.name, data.category)
    if not planned:
        if plan_error == "engine-unavailable":
            # A MISSING engine validation module is not a bad name: report the
            # engine as unavailable rather than mislabelling it bad-input.
            return {
                "ok": False,
                "kind": "engine-unavailable",
                "detail": {"reason": "引擎的落点校验模块不可用（tools.skills_hub_models 导入失败），无法判定落点"},
            }
        return {
            "ok": False,
            "kind": "bad-input",
            "detail": {"reason": "技能名或分类不符合引擎的落点规则（拒绝取用）", "name": str(data.name), "category": str(data.category)},
        }

    if require_confirm and not data.confirm:
        return {
            "ok": False,
            "kind": "needs-confirm",
            "detail": {"reason": "取用/更新会写入企业侧技能目录，必须带 confirm:true", "plannedPath": planned},
        }

    home = _hermes_home()
    if home is None:
        return {"ok": False, "kind": "enterprise-home-unavailable", "detail": {"reason": "无法确定企业侧引擎 home"}}
    usable, reason = _enterprise_home_usable(home)
    if not usable:
        return {"ok": False, "kind": "enterprise-home-unavailable", "detail": {"reason": reason, "home": str(home)}}

    skills_path = engine_skills_dir()
    if skills_path is None:
        return {"ok": False, "kind": "engine-unavailable", "detail": {"reason": "引擎未提供技能目录（get_skills_dir 不可用）"}}
    try:
        assert_outside_personal_trees(skills_path)
    except ValueError as exc:
        return {"ok": False, "kind": "blocked-personal-dir", "detail": {"message": str(exc), "skillsPath": str(skills_path)}}

    # Fail-closed write-path self-check (skills root / record structural gate).
    # AFTER the personal-tree policy gate on purpose: a store that is a symlink
    # INTO a personal tree must still report `blocked-personal-dir` (the more
    # specific, more actionable fact), not the generic guard refusal.
    refusal = _require_write_guard(home, skills_path, installPath=planned, name=str(data.name))
    if refusal is not None:
        return refusal

    # Q1 overwrite guard — the ENGINE's own local-change criterion
    # (``hermes_cli.skills_hub._has_local_edits``, the gate ``do_update`` applies).
    # Replacing a landing whose on-disk content no longer matches the engine's
    # recorded hash would rmtree-destroy the user's edits, so it must be an
    # EXPLICIT, separately-acknowledged choice — a bare ``confirm`` is not enough.
    #
    # 口径（代价不对称）：只有「确定无改动」（``edits is False``，即引擎记录里的哈希与
    # 磁盘内容逐字相符）才放行。其余都算不得「确定无改动」：
    #   * ``edits is True``：引擎判据把它记录在案的那个落点判为已改动——即使那不是
    #     本次计划落点，也一律要人明确确认（页面必须能呈现该事实并送出 ack）；
    #   * ``edits is None``：没有任何记录能为此落点背书——记录根本没有这条技能
    #     （F-2：既有内容 + 无记录，同样是「说不清」）、记录里没有可比对的内容哈希、
    #     或锁读不出（损坏/不可读/形状异常 → 引擎只看得见空形状 → 同样回 None；探测
    #     函数 ``_probe_lock_file()`` 只负责把原因说给用户听，不参与判定）。
    # 计划落点已存在内容时，``None`` 必须拒写；落点不存在时放行（全新取用，没有
    # 可失去的东西）。理由：误判「无改动」是不可逆的 rmtree，抹掉用户劳动还回
    # ok:true；误判「无法判定」只多一次确认点击。
    if not data.overwriteLocalEdits:
        edits = engine_local_edits(str(data.name), planned)
        landing_exists = (skills_path / planned).is_dir()
        lock_note = _probe_lock_file()
        if edits is True or (landing_exists and edits is not False):
            if edits is True:
                reason = ("本地已修改：磁盘内容与引擎取用记录里的哈希不一致。继续会覆盖并丢失这些改动；"
                          "确认覆盖需显式带 overwriteLocalEdits:true。")
            else:
                reason = ("无法判定本地是否有改动：引擎取用记录里没有这条技能、记录里没有可比对的内容哈希、"
                          "或记录读不出（损坏/不可读），而该落点已存在内容。继续可能覆盖并丢失本地改动；"
                          "确认覆盖需显式带 overwriteLocalEdits:true。")
            return {
                "ok": False,
                "kind": "local-edits",
                "detail": {
                    "reason": reason,
                    "undecidable": edits is not True,
                    "lockNote": lock_note,
                    "name": str(data.name),
                    "installPath": planned,
                },
            }

    cli_path, cli_source = resolve_cli()
    if cli_path is None:
        return {"ok": False, "kind": "cli-missing", "detail": {"message": "找不到企业副本 shaoke-cli"}}

    try:
        from tools import skills_hub as engine_hub  # type: ignore
        from tools.skills_guard import scan_skill, should_allow_install  # type: ignore
        from tools.skills_hub_install import (  # type: ignore
            install_from_quarantine, quarantine_bundle)
        from tools.skills_hub_models import SkillBundle  # type: ignore
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "kind": "engine-unavailable", "detail": {"message": f"引擎技能管理模块不可用：{exc}"}}

    # The engine's own hub bookkeeping (quarantine dir + lock.json) must exist
    # before it can stage a bundle — its own helper, not ours.
    try:
        engine_hub.ensure_hub_dirs()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "kind": "write-failed", "detail": {"message": f"引擎 hub 目录不可用：{exc}"}}

    target = skills_path / planned
    replaced = bool(target.is_dir())

    fetched = _download_bundle_entries(cli_path, slug)
    if not fetched["ok"]:
        return {"ok": False, "kind": fetched["kind"], "detail": fetched.get("detail")}

    bundle = SkillBundle(
        name=str(data.name),
        files={str(rel): data_bytes for rel, data_bytes in fetched["entries"]},
        source=ENGINE_SOURCE,
        identifier=reference,
        trust_level="community",
        metadata={
            "shaoke": {
                "slug": slug,
                "reference": reference,
                "name": str(data.name),
                "category": str(data.category),
                "version": str(data.version),
                "pickedBy": str(data.pickedBy or ""),
            }
        },
    )

    # ── the engine's pipeline: quarantine → scan → (refuse?) → install ───────
    try:
        quarantine_path = quarantine_bundle(bundle)
    except ValueError as exc:
        return {"ok": False, "kind": "engine-refused", "detail": {"reason": str(exc), "installPath": planned}}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "kind": "write-failed", "detail": {"message": f"引擎暂存技能包失败：{exc}"}}

    try:
        scan_result = scan_skill(quarantine_path, source=reference)
        allowed, allow_reason = should_allow_install(scan_result, force=False)
        if not allowed:
            return {
                "ok": False,
                "kind": "blocked-by-scan",
                "detail": {
                    "reason": allow_reason,
                    "verdict": str(getattr(scan_result, "verdict", "") or ""),
                    "summary": str(getattr(scan_result, "summary", "") or ""),
                    "findings": _scan_findings(scan_result),
                },
            }
        install_dir = install_from_quarantine(
            quarantine_path, bundle.name, str(data.category or ""), bundle, scan_result
        )
    except ValueError as exc:
        return {"ok": False, "kind": "engine-refused", "detail": {"reason": str(exc), "installPath": planned}}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "kind": "write-failed", "detail": {"message": f"引擎安装失败：{exc}", "installPath": planned}}
    finally:
        # Remove OUR staging input if the engine left it behind (the engine
        # rmtree's it itself on success — this is hygiene for early returns).
        shutil.rmtree(quarantine_path, ignore_errors=True)

    # Read the outcome back from the ENGINE's own bookkeeping (not from guesses).
    entries, _note = read_engine_installations()
    entry = next((e for e in entries if str(e.get("name") or "") == str(bundle.name)), None)
    content_hash = str((entry or {}).get("content_hash") or "") or engine_content_hash(install_dir)
    if not content_hash:
        return {
            "ok": False,
            "kind": "hash-unavailable",
            "detail": {
                "message": "引擎安装完成但内容哈希取不到（锁文件与落点都读不出），无法确认结果",
                "installPath": str(getattr(install_dir, "name", planned)),
            },
        }

    return {
        "ok": True,
        "engine": "install_from_quarantine",
        "record": _lock_entry_view(entry, skills_path, set()) if entry else None,
        "target": str(install_dir),
        "installPath": (str((entry or {}).get("install_path") or planned)),
        "files": len(bundle.files),
        "replaced": replaced,
        "skillsPath": str(skills_path),
        "localHash": content_hash,
        "scanVerdict": str(getattr(scan_result, "verdict", "") or ""),
        "cliPath": cli_path,
        "cliSource": cli_source,
    }


def _uninstall_skill(data: UninstallRequest) -> dict:
    """Remove a skill through the ENGINE's own uninstall entry.

    The engine refuses anything it did not install (and anything missing from,
    or malformed in, its own lock file), so no directory is removed by this
    module and a tampered record cannot aim the engine at a foreign directory.
    """
    reference = (data.reference or "").strip()
    if not reference:
        return {"ok": False, "kind": "bad-input", "detail": {"reason": "技能标识缺失"}}
    if not data.confirm:
        return {
            "ok": False,
            "kind": "needs-confirm",
            "detail": {"reason": "卸载会删除引擎技能落点，必须带 confirm:true", "reference": reference},
        }

    home = _hermes_home()
    if home is None:
        return {"ok": False, "kind": "enterprise-home-unavailable", "detail": {"reason": "无法确定企业侧引擎 home"}}
    skills_path = engine_skills_dir()
    if skills_path is None:
        return {"ok": False, "kind": "engine-unavailable", "detail": {"reason": "引擎未提供技能目录（get_skills_dir 不可用）"}}
    try:
        assert_outside_personal_trees(skills_path)
    except ValueError as exc:
        return {"ok": False, "kind": "blocked-personal-dir", "detail": {"message": str(exc), "skillsPath": str(skills_path)}}

    # Fail-closed write-path self-check — a redirected store root (or a redirect
    # on the chain between it and the enterprise home) is exactly the shape the
    # engine must never be allowed to land a bundle through (KI-PLANKTON-0072).
    refusal = _require_write_guard(home, skills_path, reference=reference,
                                   installPath=(data.installPath or "").strip())
    if refusal is not None:
        return refusal

    try:
        from tools.skills_hub_install import uninstall_skill as engine_uninstall  # type: ignore
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "kind": "engine-unavailable", "detail": {"message": f"引擎技能管理模块不可用：{exc}"}}

    entries, note = read_engine_installations()
    wanted_path = (data.installPath or "").strip()
    entry = next(
        (
            e
            for e in entries
            if str(e.get("identifier") or "") == reference
            and (not wanted_path or str(e.get("install_path") or "") == wanted_path)
        ),
        None,
    )
    if entry is None and wanted_path:
        entry = next((e for e in entries if str(e.get("install_path") or "") == wanted_path), None)
    if entry is None:
        return {
            "ok": False,
            "kind": "no-record",
            "detail": {
                "reason": "引擎的取用记录里没有这条技能，本页只卸载引擎记录在案的技能",
                "reference": reference,
                "lockNote": note,
            },
        }

    name = str(entry.get("name") or "")
    install_path = str(entry.get("install_path") or "")
    try:
        ok, message = engine_uninstall(name)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "kind": "remove-failed", "detail": {"message": f"引擎卸载失败：{exc}", "name": name}}

    if not ok:
        return {"ok": False, "kind": "remove-failed", "detail": {"message": message, "name": name}}

    return {
        "ok": True,
        "engine": "uninstall_skill",
        "removed": not (skills_path / install_path).exists() if install_path else True,
        "name": name,
        "reference": reference,
        "installPath": install_path,
        "message": message,
    }


def _set_skill_enabled(name: str, enabled: bool) -> dict:
    """Flip the ENGINE's own enable state for ``name``.

    Uses ``hermes_cli.skills_config`` — the exact functions behind the engine's
    ``PUT /api/skills/toggle`` route — so this app keeps NO second copy of the
    state. Fail-closed: if the engine config cannot be read or written we report
    the failure and change nothing.
    """
    skill_name = (name or "").strip()
    if not skill_name:
        return {"ok": False, "kind": "bad-input", "detail": {"reason": "技能名缺失"}}
    try:
        from hermes_cli.config import load_config  # type: ignore
        from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills  # type: ignore
    except Exception as exc:
        return {"ok": False, "kind": "engine-unavailable", "detail": {"message": f"引擎技能配置模块不可用：{exc}"}}

    # Enable/disable writes the engine's config, which the engine reads next to
    # the skill store we just refused to trust: gate it with the SAME fail-closed
    # write-path self-check as the store-writing routes (Perry: 启停也在写路径里).
    home = _hermes_home()
    if home is None:
        return {"ok": False, "kind": "enterprise-home-unavailable", "detail": {"reason": "无法确定企业侧引擎 home"}}
    skills_path = engine_skills_dir()
    if skills_path is None:
        return {"ok": False, "kind": "engine-unavailable", "detail": {"reason": "引擎未提供技能目录（get_skills_dir 不可用）"}}
    refusal = _require_write_guard(home, skills_path, name=skill_name)
    if refusal is not None:
        return refusal

    # ``ESSENTIAL_SKILLS`` is only used to LABEL a failure. It lives in a
    # different module, so a missing/renamed symbol there must not take the
    # whole enable/disable path down with ``engine-unavailable`` — the config
    # read/write above is what actually matters.
    try:
        from agent.skill_utils import ESSENTIAL_SKILLS  # type: ignore
    except Exception:
        ESSENTIAL_SKILLS = frozenset()

    try:
        try:
            from hermes_cli.web_routers._common import config_write_scope  # type: ignore

            scope = config_write_scope(None)
        except Exception:
            import contextlib

            scope = contextlib.nullcontext()
        with scope:
            config = load_config()
            disabled = get_disabled_skills(config)
            if enabled:
                disabled.discard(skill_name)
            else:
                disabled.add(skill_name)
            save_disabled_skills(config, disabled)
            # Re-read the PERSISTED state. The engine silently drops essential
            # skills (``ESSENTIAL_SKILLS``) from this key, so a "disable
            # hermes-agent" write is a no-op — reporting ok would be a false green.
            persisted = get_disabled_skills(load_config())
    except Exception as exc:
        return {"ok": False, "kind": "write-failed", "detail": {"message": str(exc)}}

    achieved = (skill_name in persisted) == (not enabled)
    if not achieved:
        if not enabled and skill_name in ESSENTIAL_SKILLS:
            reason = f"「{skill_name}」是引擎的必备技能（essential），引擎拒绝停用；已确认配置未被改动"
            kind = "essential-skill"
        else:
            reason = f"写入未生效：请求 {'启用' if enabled else '停用'}「{skill_name}」，但持久化的停用清单未反映该状态"
            kind = "not-effective"
        return {
            "ok": False,
            "kind": kind,
            "detail": {
                "message": reason,
                "name": skill_name,
                "requestedEnabled": bool(enabled),
                "persistedDisabled": sorted(persisted),
            },
        }

    return {"ok": True, "name": skill_name, "enabled": bool(enabled), "disabled": sorted(persisted)}


# ── HTTP route handlers ──────────────────────────────────────────────────────
# Named with a ``route_`` prefix on purpose (Q9): the engine has its own
# ``uninstall_skill`` (tools.skills_hub_install) and a reader could otherwise
# mis-reference the wrong one. The path/route id is the contract; the symbol
# name is only there to keep OUR handler distinct from the engine's.

@router.post("/skills/install")
def route_install_skill(data: InstallRequest) -> dict:
    """Install one skill into the engine's skills store (via the engine).

    Installing writes files, so the backend REQUIRES ``confirm:true`` — the UI
    always sends it after its confirmation dialog, and a direct call without it
    is refused rather than silently writing. A landing that already holds content
    whose local-edit status is not CONFIRMED clean (drifted content, or no record
    that can attest it) ALSO requires ``overwriteLocalEdits:true``.
    """
    return _install_skill(data, require_confirm=True)


@router.post("/skills/update")
def route_update_skill(data: InstallRequest) -> dict:
    """Update = hand the ENGINE a freshly downloaded bundle for the same landing.

    The engine's own update CHECK (``check_for_skill_updates``) resolves through
    its hub adapters and can never match our ``shaoke-skillhub`` source (it
    reports such an entry as ``unavailable``), so an update is an engine install
    of fresh bytes. It overwrites the landing by definition, so it REQUIRES
    ``confirm:true``; when the landing already holds content whose local-edit
    status is not CONFIRMED clean it ALSO requires ``overwriteLocalEdits:true``
    (the engine's own local-change rule, taken as a "cannot confirm clean →
    must be an explicit choice" rule).
    """
    return _install_skill(data, require_confirm=True)


@router.post("/skills/uninstall")
def route_uninstall_skill(data: UninstallRequest) -> dict:
    """Uninstall through the engine's own entry; the engine drops its record too."""
    return _uninstall_skill(data)


@router.post("/skills/enable")
def route_enable_skill(data: ToggleRequest) -> dict:
    """Re-enable a skill through the engine's own enable state."""
    if not data.confirm:
        return {"ok": False, "kind": "needs-confirm", "detail": {"reason": "启用会写引擎配置，必须带 confirm:true", "name": data.name}}
    return _set_skill_enabled(data.name, True)


@router.post("/skills/disable")
def route_disable_skill(data: ToggleRequest) -> dict:
    """Disable a skill through the engine's own enable state."""
    if not data.confirm:
        return {"ok": False, "kind": "needs-confirm", "detail": {"reason": "停用会写引擎配置，必须带 confirm:true", "name": data.name}}
    return _set_skill_enabled(data.name, False)
