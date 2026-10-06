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
An EMPTY catalog is a SUCCESS (``{ok: true, catalog: {ok: true, count: 0}}``).
A catalog capped at the page limit is a SUCCESS that carries ``truncated: true``
— never silently read as the whole catalog.

Hash parity: the local content hash is computed by importing the engine's own
``tools.skills_guard.content_hash`` — the exact function the engine uses. There
is NO second (JS/Python) re-implementation of the digest, so the "口径分叉" the
old JS ``hashTree`` risked is impossible by construction.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Optional, Tuple

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

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


def engine_local_edits(name: str, install_rel: str) -> Optional[bool]:
    """True when the on-disk skill no longer matches the engine's recorded hash.

    Uses the ENGINE's OWN predicate ``hermes_cli.skills_hub._has_local_edits`` —
    the very gate ``hermes_cli.skills_hub.do_update`` applies so an update never
    silently destroys the user's work. Falls back to comparing the engine's
    recorded ``content_hash`` against the current on-disk hash (the same 逐字
    comparison ``_hash_state`` names).

    Returns ``False`` when there is no record or the content still matches,
    ``True`` when it drifted, ``None`` when neither test can decide. ``None`` is
    never treated as "no edits".
    """
    try:
        from tools.skills_hub import HubLockFile  # type: ignore

        entry = HubLockFile().get_installed(str(name))
    except Exception:  # noqa: BLE001 - an unreadable lock means "cannot decide"
        return None
    if not entry:
        return False
    try:
        from hermes_cli.skills_hub import _has_local_edits  # type: ignore

        return bool(_has_local_edits(entry))
    except Exception:  # noqa: BLE001 - fall through to our own comparison
        pass
    skills_path = engine_skills_dir()
    target = (skills_path / install_rel) if (skills_path and install_rel) else None
    current = engine_content_hash(target) if (target is not None and target.is_dir()) else None
    state = _hash_state(entry.get("content_hash"), current)
    if state == "match":
        return False
    if state == "mismatch":
        return True
    return None


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
    """The already-installed state for one catalog entry (mirrors the old view)."""
    if not skill.get("installPath"):
        return "name-missing"
    if record and on_disk:
        if disabled is True:
            return "disabled"
        recorded = str(record.get("version") or "").strip()
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

    try:
        assert_outside_personal_trees(skills_path)
    except ValueError as exc:
        return {
            "ok": False,
            "kind": "blocked-personal-dir",
            "error": str(exc),
            "skillsPath": str(skills_path),
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
    for entry in lock_entries:
        ref = str(entry.get("identifier") or "")
        if ref:
            by_ref.setdefault(ref, entry)
        landing = str(entry.get("install_path") or "")
        if landing:
            by_landing.setdefault(landing, entry)

    enriched: list = []
    for skill in catalog_skills:
        install_path = skill.get("installPath")
        target = (skills_path / install_path) if install_path else None
        on_disk = bool(target is not None and target.is_dir())
        current = engine_content_hash(target) if (on_disk and target is not None) else None
        entry = by_ref.get(skill["reference"]) or (by_landing.get(install_path) if install_path else None)
        entry_attested = bool(entry) and _hash_state(entry.get("content_hash"), current) == "match"
        effective_entry = entry if entry_attested else None
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
                "hashState": _hash_state(entry.get("content_hash"), current) if entry else None,
                "localEdits": bool(entry) and on_disk and _hash_state(entry.get("content_hash"), current) == "mismatch",
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

    # Q1 overwrite guard — the ENGINE's own local-change criterion
    # (``hermes_cli.skills_hub._has_local_edits``, the gate ``do_update`` applies).
    # Replacing a landing whose on-disk content no longer matches the engine's
    # recorded hash would rmtree-destroy the user's edits, so it must be an
    # EXPLICIT, separately-acknowledged choice — a bare ``confirm`` is not enough.
    if not data.overwriteLocalEdits:
        edits = engine_local_edits(str(data.name), planned)
        if edits is True:
            return {
                "ok": False,
                "kind": "local-edits",
                "detail": {
                    "reason": "本地已修改：磁盘内容与引擎取用记录里的哈希不一致。继续会覆盖并丢失这些改动；"
                              "确认覆盖需显式带 overwriteLocalEdits:true。",
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
    is refused rather than silently writing. An install whose landing already
    holds locally-edited content ALSO requires ``overwriteLocalEdits:true``.
    """
    return _install_skill(data, require_confirm=True)


@router.post("/skills/update")
def route_update_skill(data: InstallRequest) -> dict:
    """Update = hand the ENGINE a freshly downloaded bundle for the same landing.

    The engine's own update CHECK (``check_for_skill_updates``) resolves through
    its hub adapters and can never match our ``shaoke-skillhub`` source (it
    reports such an entry as ``unavailable``), so an update is an engine install
    of fresh bytes. It overwrites the landing by definition, so it REQUIRES
    ``confirm:true``; when the landing holds locally-edited content it ALSO
    requires ``overwriteLocalEdits:true`` (the engine's own local-change rule).
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
