"""plankton-enterprise dashboard backend — mounted at ``/api/plugins/plankton-enterprise/``.

Two read/write surfaces ship in this batch:

  * ``GET /tools``  — the local ``shaoke-cli`` tool catalog (read-only listing).
  * ``GET/POST /skills*`` — the enterprise skill market: the approved-skill
    catalog (via ``shaoke-cli skillhub``), install / uninstall / enable /
    disable / update, version comparison and the local content hash.

DECISION (batch 2 step 2, PLANKTON-MIGRATION-BATCH2.md §D4)
-----------------------------------------------------------
"停用" maps to the ENGINE's OWN skill enable state, not a second store kept by
this app. The engine is the single source of truth for "is this skill active":
``config.yaml`` → ``skills.disabled``, read by ``agent.skill_utils`` and written
through ``hermes_cli.skills_config.get_disabled_skills`` /
``save_disabled_skills`` — the exact functions the engine's own
``PUT /api/skills/toggle`` route calls. We call the SAME functions in the SAME
process, so there is structurally no second state to drift. The engine HAS this
state and entry point (verified: ``hermes_cli/skills_config.py``,
``hermes_cli/web_routers/skills.py:379``), so the decision is implementable and
is implemented — no bespoke status file.

Red lines this file obeys (PLANKTON-MIGRATION-BATCH2.md §D3):
  * It NEVER reads, writes, caches or proxies ``~/.shaoke/tokens.json``. The
    ``tools list`` command is unauthenticated; ``skillhub +list`` likewise runs
    unauthenticated (verified). No token is ever read.
  * The skill store is ``<HERMES_HOME>/skills`` — never a personal tree. Writes
    are refused when the target resolves under ``~/.hermes*`` and there is NO
    fallback to a personal directory (PLK-REQ-0023).

Failure taxonomy (each kind is INDEPENDENTLY visible in the UI — never
silently collapsed into "no skills"):
  ``cli-missing`` / ``unauthorized`` / ``network-failed`` / ``not-json`` /
  ``shape-mismatch`` / ``no-bundle`` / ``download-failed`` / ``extract-failed``
  / ``write-failed`` / ``needs-confirm`` / ``unsafe-path`` / ``install-overlap``
  / ``blocked-personal-dir`` / ``enterprise-home-unavailable`` /
  ``hash-unavailable`` / ``no-record`` / ``remove-failed`` / ``essential-skill``
  / ``not-effective`` / ``engine-unavailable`` / ``unreadable-config``.
An EMPTY catalog is a SUCCESS (``{ok: true, catalog: {ok: true, count: 0}}``).
A catalog capped at the page limit is a SUCCESS that carries ``truncated: true``
— never silently read as the whole catalog.

Hash parity: the local content hash is computed by importing the engine's own
``tools.skills_guard.content_hash`` — the exact function the engine uses. There
is NO second (JS/Python) re-implementation of the digest in this batch, so the
"口径分叉" the old JS ``hashTree`` risked is impossible by construction.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import stat
import subprocess
import threading
import time
import unicodedata
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Any, Callable, Optional, Tuple

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
LEDGER_SCHEMA = 1

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
    "unsafe-path",
    "install-overlap",
    "blocked-personal-dir",
    "enterprise-home-unavailable",
    "hash-unavailable",
    "no-record",
    "remove-failed",
    "essential-skill",
    "not-effective",
    "engine-unavailable",
    "unreadable-config",
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
# GET /tools — read-only local tool catalog (step 1)
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
# Skill market — helpers
# ─────────────────────────────────────────────────────────────────────────────


class InstallRequest(BaseModel):
    slug: str = ""
    reference: str = ""
    name: str = ""
    category: str = ""
    version: str = ""
    # ``confirm`` is the human-confirmation latch: a write that overwrites an
    # occupied slot (or a batch write) is REFUSED unless the caller passes True.
    confirm: bool = False
    # Explicit "install to a different slug than expected" is not a feature —
    # ``force`` only means "overwrite despite a slot conflict".
    pickedBy: str = ""


class UninstallRequest(BaseModel):
    reference: str = ""
    installPath: str = ""
    confirm: bool = False


class ToggleRequest(BaseModel):
    name: str = ""
    enabled: bool = True
    # Enabling/disabling is a write to the engine's config, so the backend
    # requires the same human-confirmation latch as the file-writing routes
    # (N4: the doc claim "every write needs confirm" is enforced HERE).
    confirm: bool = False


def _skills_dir(home: Path) -> Path:
    """The engine's own skills directory — ``<HERMES_HOME>/skills``."""
    return home / "skills"


def _ledger_path(home: Path) -> Path:
    """Our ledger — under the enterprise home, never a personal tree."""
    return home / "plankton" / "skill-ledger.json"


def assert_outside_personal_trees(directory: Path, personal_home: Optional[Path] = None) -> None:
    """Refuse a skill store that resolves inside a personal tree (PLK-REQ-0023).

    Raises ``ValueError`` — never returns a "somewhere else" fallback.
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


def _normalize_bundle_path(value: str, *, allow_nested: bool) -> Optional[str]:
    """Engine install-path rules (mirrors ``tools/skills_hub_models._normalize_bundle_path``).

    Trim; ``\\`` → ``/``; drop empty and ``.`` segments; reject an absolute
    path, a ``..`` segment, a segment containing ``:``, or (when nested is not
    allowed) more than one segment. Returns ``None`` on any rejection — never
    silently renames or folds.
    """
    raw = (value or "").strip()
    if not raw:
        return None
    normalized = raw.replace("\\", "/")
    parts = [p for p in normalized.split("/") if p not in ("", ".")]
    if normalized.startswith("/") or not parts:
        return None
    if any(p == ".." for p in parts) or any(":" in p for p in parts):
        return None
    if not allow_nested and len(parts) != 1:
        return None
    return "/".join(parts)


def plan_install_path(name: str, category: str) -> Optional[str]:
    """``category/name`` (category empty → single-layer ``name``), engine rules."""
    skill_name = _normalize_bundle_path(name, allow_nested=False)
    if not skill_name:
        return None
    raw_category = (category or "").strip()
    if not raw_category:
        return skill_name
    parent = _normalize_bundle_path(raw_category, allow_nested=True)
    if not parent:
        return None
    return f"{parent}/{skill_name}"


def _skill_reference(entry: dict) -> str:
    """Stable identity: ``install.reference`` when present, else ``slug``."""
    install = entry.get("install") if isinstance(entry, dict) else None
    ref = ""
    if isinstance(install, dict):
        ref = str(install.get("reference") or "").strip()
    return ref or str(entry.get("slug") or "")


# ── engine content hash (SAME function, SAME process — no second impl) ────────


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


# ── ledger ────────────────────────────────────────────────────────────────────


def read_ledger(home: Path) -> Tuple[list, Optional[str]]:
    """Read the ledger; a missing/corrupt file is an empty ledger + a note."""
    file = _ledger_path(home)
    try:
        raw = file.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("records"), list):
            return [], f"台账结构不符，按空处理：{file}"
        return [r for r in parsed["records"] if isinstance(r, dict)], None
    except FileNotFoundError:
        return [], None
    except Exception as exc:  # corrupt JSON, unreadable, …
        return [], f"台账读取失败，按空处理：{exc}"


def write_ledger(home: Path, records: list) -> None:
    """Atomic temp-then-rename write of the ledger."""
    file = _ledger_path(home)
    file.parent.mkdir(parents=True, exist_ok=True)
    tmp = file.with_name(file.name + ".tmp")
    tmp.write_text(json.dumps({"schema": LEDGER_SCHEMA, "records": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, file)


def _hash_state(recorded: Any, current: Optional[str]) -> str:
    """Compare a ledger record's hash with the on-disk hash (逐字).

    ``match`` / ``mismatch`` / ``missing`` (没落点) / ``unknown`` (算不出)。
    """
    rec = str(recorded or "").strip()
    if not current:
        return "missing"
    if not rec:
        return "unknown"
    return "match" if rec == current else "mismatch"


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
    answer. ``truncated`` is an EXPLICIT flag (F6): when the CLI still reports a
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
    """The enterprise skill market: catalog + local install facts.

    A catalog fetch failure is reported in a nested ``catalog`` block so the
    page can still render the local install facts and show the failure — a
    catalog that could not be fetched is NEVER rendered as "no skills".
    """
    home = _hermes_home()
    if home is None:
        return _failure("enterprise-home-unavailable", "无法确定企业侧引擎 home", None, "missing")

    skills_path = _skills_dir(home)
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
    ledger_records, ledger_note = read_ledger(home)
    by_ref: dict = {}
    for record in ledger_records:
        ref = str(record.get("reference") or record.get("slug") or "")
        if ref:
            by_ref[ref] = record

    disabled_info = fetch_disabled()
    disabled_set = set(disabled_info.get("names") or []) if disabled_info.get("ok") else set()

    installed: list = []
    for record in ledger_records:
        install_path = str(record.get("installPath") or "")
        target = skills_path / install_path if install_path else None
        on_disk = bool(target and target.is_dir())
        current = engine_content_hash(target) if (target and on_disk) else None
        installed.append(
            {
                "reference": str(record.get("reference") or ""),
                "slug": str(record.get("slug") or ""),
                "name": str(record.get("name") or ""),
                "category": str(record.get("category") or ""),
                "version": str(record.get("version") or ""),
                "installPath": install_path,
                "installedAt": str(record.get("installedAt") or ""),
                "uninstalledAt": str(record.get("uninstalledAt") or ""),
                "files": record.get("files"),
                "onDisk": on_disk,
                "localHash": current,
                "hashState": _hash_state(record.get("contentHash"), current),
                "disabled": (str(record.get("name") or "") in disabled_set) if disabled_info.get("ok") else None,
            }
        )

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

    enriched: list = []
    for skill in catalog_skills:
        record = by_ref.get(skill["reference"]) or None
        install_path = skill.get("installPath")
        target = (skills_path / install_path) if install_path else None
        planned_on_disk = bool(target and target.is_dir())
        ledger_on_disk = bool(record and record.get("installPath") and (skills_path / str(record.get("installPath"))).is_dir())
        on_disk = planned_on_disk or ledger_on_disk
        current = engine_content_hash(target) if (target is not None and planned_on_disk) else None
        record_attested = bool(record) and _hash_state(record.get("contentHash"), current) == "match"
        effective_record = record if record_attested else None
        disabled_flag = None
        if disabled_info.get("ok"):
            disabled_flag = str(skill.get("name") or "").strip() in disabled_set
        enriched.append(
            {
                **skill,
                "onDisk": on_disk,
                "installState": _derive_install_state(skill, effective_record if planned_on_disk else None, planned_on_disk, disabled_flag),
                "recordedVersion": str(effective_record.get("version") or "") if effective_record else "",
                "localHash": current,
                "hashState": _hash_state(record.get("contentHash"), current) if record else None,
                "disabled": disabled_flag,
            }
        )

    return {
        "ok": True,
        "skills": enriched,
        "installed": installed,
        "catalog": catalog,
        "disabled": disabled_info,
        "count": len(enriched),
        "home": str(home),
        "skillsPath": str(skills_path),
        "ledgerPath": str(_ledger_path(home)),
        "ledgerNote": ledger_note,
        "cliPath": cli_path,
        "cliSource": cli_source,
        "personalCliPath": personal_cli_path() if cli_path is None else None,
        "fetchedAt": int(time.time() * 1000),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Write path — install / uninstall / enable / disable / update
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


def is_unsafe_rel_path(rel: str) -> bool:
    if not rel:
        return True
    if rel.startswith("/") or (len(rel) > 1 and rel[1] == ":"):
        return True
    return ".." in rel.split("/")


def _resolve_inside(skills_path: Path, install_path: str) -> Optional[Path]:
    """Resolve ``install_path`` strictly inside ``skills_path`` (no ``..`` escape)."""
    rel = (install_path or "").strip()
    if not rel or os.path.isabs(rel):
        return None
    root = skills_path.resolve()
    absolute = (root / rel).resolve()
    if absolute != root and not str(absolute).startswith(str(root) + os.sep):
        return None
    return absolute


def _rel_segments(install_path: str) -> list:
    """Normalize a relative install path into segments, or ``[]`` when illegal.

    Mirrors the engine's landing rules (``_normalize_bundle_path``): non-empty,
    relative, no ``..``, no ``:``; ``\\`` → ``/``; empty/``.`` segments dropped.
    """
    normalized = _normalize_bundle_path(install_path, allow_nested=True)
    return normalized.split("/") if normalized else []


def _landing_key(install_path: str) -> tuple:
    """Comparison key for a landing: NFC-normalized, case-folded segments (P3).

    macOS volumes are case-INsensitive and Unicode-normalizing by default, so
    ``cat/x``, ``CAT/x`` and an NFD spelling of either are ONE physical
    directory. A raw-string prefix test therefore MISSES nesting (``CAT/x``
    living inside ``cat``) and lets an uninstall ``rmtree`` a sibling and leave
    the ledger dangling. Every overlap / nesting / same-landing comparison goes
    through this key instead of ``str.startswith``.
    """
    segs = _rel_segments(install_path)
    return tuple(unicodedata.normalize("NFC", p).casefold() for p in segs)


def _key_is_under(child: tuple, parent: tuple) -> bool:
    """True when ``child`` is STRICTLY inside ``parent`` (segment-wise)."""
    return len(child) > len(parent) and child[: len(parent)] == parent


def _lexical_absolute(path: Path) -> Path:
    """Absolute path WITHOUT following symlinks (``.``/``..`` folded lexically)."""
    return Path(os.path.abspath(str(path)))


def assert_no_symlink_chain(path: Path, *, label: str, boundary: Optional[Path] = None) -> None:
    """lstat every component of ``path`` AT OR BELOW ``boundary``, refusing symlinks (P2).

    ``Path.resolve()`` erases a symlinked component, so a check that runs after
    it can never see the link. This walks the literal chain — the final
    component INCLUDED — because the store root itself (``…/skills``) or the
    home above it being a symlink is exactly the escape ``resolve()`` hides.

    ``boundary`` is a TRUSTED ancestor: it and everything above it are OUT of
    scope. Without it a system-level symlink (macOS ``/tmp -> /private/tmp``,
    ``/var -> private/var``) would produce a false refusal for a perfectly valid
    ``HERMES_HOME`` under ``TMPDIR``. Components that do not exist yet are fine
    (nothing to follow). Raises ``ValueError``.
    """
    absolute = _lexical_absolute(path)
    parts = absolute.parts
    if boundary is None:
        lo = len(Path(absolute.anchor).parts)
    else:
        bound = _lexical_absolute(boundary)
        bparts = bound.parts
        if tuple(parts[: len(bparts)]) != tuple(bparts):
            raise ValueError(f"{label}不在受信边界内：{absolute}（边界 {bound}）")
        lo = len(bparts)
    acc = Path(*parts[:lo]) if lo > 0 else Path(absolute.anchor)
    for seg in parts[lo:]:
        acc = acc / seg
        try:
            mode = os.lstat(acc).st_mode
        except OSError:
            # The rest of the chain does not exist (or a component is not a
            # directory) — nothing further to resolve/follow.
            return
        if stat.S_ISLNK(mode):
            raise ValueError(f"{label}链上存在符号链接，拒绝：{acc}")


def _store_boundary(skills_path: Path) -> Path:
    """The stable ancestor ABOVE the enterprise home (never itself checked).

    ``skills_path`` is always ``<HERMES_HOME>/skills``, so this is
    ``<HERMES_HOME>``'s parent — the boundary that keeps the symlink walk off
    system ancestors while still covering HERMES_HOME and the ``skills`` root.
    """
    return Path(skills_path).parent.parent


def assert_safe_landing(skills_path: Path, install_path: str) -> Path:
    """Resolve a landing with NO symlink anywhere on its chain (F1 / F7 / P2).

    Unlike a bare ``(skills_path / install_path).resolve()`` — which happily
    follows a symlinked component and then reports a path that is "inside" the
    store only because the escape was erased — this walks each component from
    the RESOLVED skills root and refuses the whole write when any existing
    component is a symlink. It then re-checks the RESOLVED landing for both
    containment (strictly under ``<HERMES_HOME>/skills``) and the personal-tree
    red line (PLK-REQ-0023). Raises ``ValueError``; there is no fallback.

    P2: the ROOT chain (``<HERMES_HOME>`` → ``skills``) is checked on the
    UNRESOLVED path FIRST. ``resolve()`` below would erase a symlinked root, so
    a root that is itself a symlink escaped the old version entirely (installs
    landed, and uninstalls deleted, OUTSIDE the store).
    """
    assert_no_symlink_chain(skills_path, label="技能目录", boundary=_store_boundary(skills_path))
    root = Path(skills_path).resolve()
    parts = _rel_segments(install_path)
    if not parts:
        raise ValueError(f"落点路径不合法（拒绝取用）：{install_path!r}")

    acc = root
    for part in parts:
        acc = acc / part
        if acc.is_symlink():
            raise ValueError(f"落点链上存在符号链接，拒绝取用：{acc}")

    resolved = acc.resolve()
    if resolved != root and not str(resolved).startswith(str(root) + os.sep):
        raise ValueError(f"落点解析后越出技能目录，拒绝取用：{resolved}")
    assert_outside_personal_trees(resolved)
    return resolved


def _safe_mkdir_chain(root: Path, parts: list) -> Path:
    """Create ``parts`` under ``root`` one level at a time, refusing symlinks.

    The per-level ``lstat`` (via ``is_symlink``) is what keeps a bundle entry
    like ``sub/SKILL.md`` from following a pre-existing ``sub -> …`` symlink out
    of the landing. A non-directory occupant is refused too (never folded).
    ``root`` itself is created when absent (it is the validated store/landing).
    """
    acc = Path(root)
    if acc.is_symlink():
        raise ValueError(f"落点根是符号链接，拒绝写入：{acc}")
    if not acc.exists():
        acc.mkdir(parents=True, exist_ok=True)
    for part in parts:
        acc = acc / part
        if acc.is_symlink():
            raise ValueError(f"落点链上存在符号链接，拒绝写入：{acc}")
        if acc.exists():
            if not acc.is_dir():
                raise ValueError(f"落点被非目录占用，拒绝写入：{acc}")
        else:
            acc.mkdir()
    return acc


def _atomic_write_bytes(dest: Path, data: bytes) -> None:
    """Write ``data`` to ``dest`` via a temp file + ``os.replace`` (P1).

    ``Path.write_bytes`` writes THROUGH an existing file: if ``dest`` is a hard
    link to e.g. ``<HERMES_HOME>/config.yaml`` the other name is silently
    rewritten. A rename onto ``dest`` replaces the directory entry instead, so
    the linked name keeps its content. The temp file is always cleaned up.
    """
    tmp = dest.with_name(f"{dest.name}.plankton-tmp-{os.getpid()}-{uuid.uuid4().hex}")
    try:
        with open(tmp, "wb") as handle:
            handle.write(data)
        os.replace(tmp, dest)
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()


def _assert_landing_writable(target: Path, entries: list, *, owned: bool) -> None:
    """Refuse a landing whose EXISTING content must not be trampled (P1).

    Two independent refusals:

    * an existing landing this module did not record is foreign — swapping it
      would destroy someone else's files, so ANY pre-existing entry refuses;
    * a destination that is a symlink, a non-file, or a HARD LINK
      (``st_nlink > 1``) refuses: a hard link's other name would otherwise be
      overwritten with the bundle's bytes.

    Raises ``ValueError``; nothing is touched.
    """
    if not owned:
        for existing in sorted(target.iterdir()):
            raise ValueError(f"落点内已存在非本台账文件，拒绝覆写：{existing}")
    for segs, _ in entries:
        cur = target
        for index, seg in enumerate(segs):
            cur = cur / seg
            if cur.is_symlink():
                raise ValueError(f"落点内存在符号链接，拒绝写入：{cur}")
            if index < len(segs) - 1:
                if cur.exists() and not cur.is_dir():
                    raise ValueError(f"落点内被非目录占用，拒绝写入：{cur}")
            elif cur.exists():
                if not cur.is_file():
                    raise ValueError(f"落点内被非文件占用，拒绝写入：{cur}")
                if cur.lstat().st_nlink > 1:
                    raise ValueError(f"落点内已存在硬链接文件，拒绝覆写：{cur}")


def _swap_into_place(staging: Path, target: Path) -> None:
    """Move a fully-built ``staging`` tree onto ``target`` (P1 / N1).

    The new tree is complete BEFORE anything already at ``target`` is moved, so
    a failed write never leaves a half-populated landing: the staging dir is
    removed by the caller. An existing ``target`` is moved aside first and
    restored if the swap fails.
    """
    if not target.exists():
        os.replace(staging, target)
        return
    backup = target.with_name(f"{target.name}.plankton-old-{uuid.uuid4().hex}")
    os.replace(target, backup)
    try:
        os.replace(staging, target)
    except Exception:
        os.replace(backup, target)
        raise
    shutil.rmtree(backup, ignore_errors=True)


def _landing_overlap(planned: str, records: list, ref_of: Callable[[dict], str]) -> Optional[dict]:
    """Detect a parent/child overlap between ``planned`` and an existing record.

    Both directions are refused (F2/P3): landing UNDER another skill's directory
    would let a later uninstall of that parent rmtree this skill too; landing
    ABOVE another skill's directory would let uninstall of this one swallow it.
    Comparison uses the case-folded segment key, so ``CAT/x`` is correctly seen
    as living under ``cat`` on a case-insensitive volume.
    """
    planned_key = _landing_key(planned)
    for record in records:
        other = str(record.get("installPath") or "").strip()
        other_key = _landing_key(other)
        if not other_key or other_key == planned_key:
            continue
        if _key_is_under(planned_key, other_key):
            return {"plannedPath": planned, "conflictsWith": other, "direction": "under",
                    "reference": ref_of(record), "name": str(record.get("name") or "")}
        if _key_is_under(other_key, planned_key):
            return {"plannedPath": planned, "conflictsWith": other, "direction": "above",
                    "reference": ref_of(record), "name": str(record.get("name") or "")}
    return None


def _nested_landings(
    skills_path: Path, landing: str, records: list, ref_of: Callable[[dict], str]
) -> list:
    """Records whose landing sits strictly INSIDE ``landing`` and still exists.

    Deleting ``landing`` would take them with it (F2/P3), so uninstall refuses.
    The nesting test is the case-folded segment key (a raw ``startswith`` misses
    ``CAT/x`` inside ``cat``). A deeper path that is itself unsafe (or
    unreadable) counts as present — the conservative branch, never a silent pass.
    """
    nested: list = []
    landing_key = _landing_key(landing)
    for record in records:
        other = str(record.get("installPath") or "").strip()
        other_key = _landing_key(other)
        if not other_key or other_key == landing_key or not _key_is_under(other_key, landing_key):
            continue
        try:
            deeper: Optional[Path] = assert_safe_landing(skills_path, other)
        except ValueError:
            deeper = None
        if deeper is None or deeper.is_dir():
            nested.append({"reference": ref_of(record), "installPath": other,
                           "name": str(record.get("name") or "")})
    return nested


def _install_skill(data: InstallRequest, *, require_confirm: bool = False) -> dict:
    slug = (data.slug or "").strip()
    if not slug:
        return {"ok": False, "kind": "bad-input", "detail": {"reason": "slug 为空"}}
    ref = (data.reference or "").strip() or slug
    planned = plan_install_path(data.name, data.category)
    if not planned:
        return {"ok": False, "kind": "bad-input", "detail": {"reason": "技能名缺失，无法确定落点"}}

    # F4/N4: a write that touches the store REQUIRES ``confirm:true`` (the
    # update route always, the install route too since it writes files).
    if require_confirm and not data.confirm:
        return {
            "ok": False,
            "kind": "needs-confirm",
            "detail": {"reason": "取用/更新会写入企业侧技能目录，必须带 confirm:true", "plannedPath": planned},
        }

    home = _hermes_home()
    if home is None:
        return {"ok": False, "kind": "enterprise-home-unavailable", "detail": {"reason": "无法确定企业侧引擎 home"}}
    skills_path = _skills_dir(home)
    try:
        assert_outside_personal_trees(skills_path)
    except ValueError as exc:
        return {"ok": False, "kind": "blocked-personal-dir", "detail": {"message": str(exc), "skillsPath": str(skills_path)}}
    usable, reason = _enterprise_home_usable(home)
    if not usable:
        return {"ok": False, "kind": "enterprise-home-unavailable", "detail": {"reason": reason, "home": str(home)}}

    # F1: validate the RESOLVED landing (per-component lstat + containment +
    # personal-tree) BEFORE any download/write. A `skills/<x>` that is a symlink
    # — to anywhere — refuses the whole install rather than writing through it.
    try:
        target = assert_safe_landing(skills_path, planned)
    except ValueError as exc:
        return {"ok": False, "kind": "unsafe-path", "detail": {"reason": str(exc), "installPath": planned}}

    cli_path, cli_source = resolve_cli()
    if cli_path is None:
        return {"ok": False, "kind": "cli-missing", "detail": {"message": "找不到企业副本 shaoke-cli"}}

    ledger_records, _ = read_ledger(home)

    def ref_of(record: dict) -> str:
        return str(record.get("reference") or record.get("slug") or "")

    # F2: refuse to CREATE a parent/child overlap with any existing record. An
    # install must never nest inside or swallow another skill's landing —
    # otherwise a later uninstall of one rmtree's the other's files.
    overlap = _landing_overlap(planned, ledger_records, ref_of)
    if overlap:
        return {
            "ok": False,
            "kind": "install-overlap",
            "detail": {
                "reason": f"落点 {planned} 与已有技能记录 {overlap['conflictsWith']} 重叠（{overlap['direction']}），拒绝取用以免卸载连坐",
                **overlap,
            },
        }

    owner = next((r for r in ledger_records if _landing_key(str(r.get("installPath") or "")) == _landing_key(planned) and ref_of(r) != ref), None)
    mine = next((r for r in ledger_records if ref_of(r) == ref and _landing_key(str(r.get("installPath") or "")) == _landing_key(planned)), None)
    occupied_on_disk = target.is_dir()
    current_hash = engine_content_hash(target) if occupied_on_disk else None
    mine_intact = bool(mine) and _hash_state(mine.get("contentHash"), current_hash) == "match"
    occupied_by_other = (not mine_intact) and (bool(owner) or occupied_on_disk)

    if occupied_by_other and not data.confirm:
        return {
            "ok": False,
            "kind": "needs-confirm",
            "detail": {
                "reason": "落点已被同名同分类的另一个技能占用，未改动磁盘",
                "plannedPath": planned,
                "occupiedBy": (
                    {"reference": ref_of(owner), "name": str(owner.get("name") or ""), "version": str(owner.get("version") or "")}
                    if owner
                    else None
                ),
                "onDiskWithoutLedger": occupied_on_disk and not owner,
            },
        }

    # Download the bundle via the CLI's presigned URL, then fetch its bytes.
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
    except Exception as exc:
        return {"ok": False, "kind": "download-failed", "detail": {"message": str(exc)}}

    try:
        entries = strip_top_dir(_zip_entries(buffer))
    except Exception as exc:
        return {"ok": False, "kind": "extract-failed", "detail": {"message": str(exc)}}
    if not entries:
        return {"ok": False, "kind": "extract-failed", "detail": {"message": "包里没有文件"}}
    unsafe = [p for p, _ in entries if is_unsafe_rel_path(p)]
    if unsafe:
        return {"ok": False, "kind": "extract-failed", "detail": {"message": "包内含不安全路径，已拒绝落盘", "paths": unsafe[:5]}}

    # ── N1/P1: assemble into a staging dir, then swap atomically ─────────────
    # A partial write must never leave residue inside the store, and a
    # destination that already holds a hard link (or foreign files) must be
    # refused rather than silently overwritten.
    normalized_entries: list = []
    for rel, data_bytes in entries:
        parts = [p for p in rel.replace("\\", "/").split("/") if p not in ("", ".")]
        if parts:
            normalized_entries.append((parts, data_bytes))

    # `owned` = this landing is OUR recorded install (a record with a content
    # hash proves this module wrote it); only then may existing files be
    # replaced. A tampered record without a hash does not unlock a landing.
    owned = bool(mine) and bool(str(mine.get("contentHash") or "").strip())

    written = 0
    target = None
    staging = None
    try:
        landing_parts = _rel_segments(planned)
        if not landing_parts:
            raise ValueError(f"落点路径不合法：{planned!r}")
        parent = _safe_mkdir_chain(skills_path, landing_parts[:-1])
        target = parent / landing_parts[-1]
        # P2: refuse a symlinked root/chain on the literal path (resolve erases it).
        assert_no_symlink_chain(target, label="落点", boundary=_store_boundary(skills_path))
        if target.is_symlink():
            raise ValueError(f"落点是符号链接，拒绝写入：{target}")
        if target.exists():
            if not target.is_dir():
                raise ValueError(f"落点被非目录占用，拒绝写入：{target}")
            # P1: refuse foreign content / hard links that a swap would trample.
            _assert_landing_writable(target, normalized_entries, owned=owned)

        staging = parent / f".plankton-staging-{os.getpid()}-{uuid.uuid4().hex}"
        os.mkdir(staging)
        for segs, data_bytes in normalized_entries:
            sub = _safe_mkdir_chain(staging, segs[:-1])
            _atomic_write_bytes(sub / segs[-1], data_bytes)
            written += 1
        _swap_into_place(staging, target)
        staging = None
    except Exception as exc:
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)
        return {
            "ok": False,
            "kind": "write-failed",
            "detail": {"message": str(exc), "written": written, "target": str(target) if target is not None else planned},
        }

    content_hash = engine_content_hash(target)
    if not content_hash:
        return {
            "ok": False,
            "kind": "hash-unavailable",
            "detail": {
                "message": "内容哈希取不到（落点刚写入却读不出内容），未写取用记录",
                "installPath": planned,
            },
        }

    record = {
        "reference": ref,
        "slug": slug,
        "name": str(data.name),
        "category": str(data.category),
        "version": str(data.version),
        "contentHash": content_hash,
        "installPath": planned,
        "installedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "files": written,
        "pickedBy": str(data.pickedBy or ""),
    }
    records = [record] + [
        r
        for r in ledger_records
        if ref_of(r) != ref and _landing_key(str(r.get("installPath") or "")) != _landing_key(planned)
    ]
    try:
        write_ledger(home, records)
    except Exception as exc:
        return {
            "ok": False,
            "kind": "write-failed",
            "detail": {"message": f"技能已落盘但台账写不进去：{exc}", "target": str(target)},
        }

    return {
        "ok": True,
        "record": record,
        "target": str(target),
        "files": written,
        "skillsPath": str(skills_path),
        "localHash": content_hash,
        "cliPath": cli_path,
        "cliSource": cli_source,
    }


def _uninstall_skill(data: UninstallRequest) -> dict:
    ref = (data.reference or "").strip()
    if not ref:
        return {"ok": False, "kind": "bad-input", "detail": {"reason": "技能标识缺失"}}

    home = _hermes_home()
    if home is None:
        return {"ok": False, "kind": "enterprise-home-unavailable", "detail": {"reason": "无法确定企业侧引擎 home"}}
    skills_path = _skills_dir(home)
    try:
        assert_outside_personal_trees(skills_path)
    except ValueError as exc:
        return {"ok": False, "kind": "blocked-personal-dir", "detail": {"message": str(exc), "skillsPath": str(skills_path)}}

    ledger_records, _ = read_ledger(home)

    def ref_of(record: dict) -> str:
        return str(record.get("reference") or record.get("slug") or "")

    record = next(
        (
            r
            for r in ledger_records
            if ref_of(r) == ref
            and (
                not data.installPath
                or _landing_key(str(r.get("installPath") or "")) == _landing_key(data.installPath)
            )
        ),
        None,
    )
    if record is None:
        return {"ok": False, "kind": "no-record", "detail": {"reason": "台账里没有这条取用记录，本模块只卸载自己取用过的技能", "reference": ref}}

    recorded_path = str(record.get("installPath") or "").strip()

    # F7: the recorded landing must be EXACTLY what our own install rules produce
    # for this record. A tampered ledger (e.g. installPath="." or "cat") must not
    # become an arbitrary delete inside <HERMES_HOME>/skills.
    expected = plan_install_path(str(record.get("name") or ""), str(record.get("category") or ""))
    if not expected or expected != recorded_path:
        return {
            "ok": False,
            "kind": "unsafe-path",
            "detail": {
                "reason": "台账记录的落点不符合本模块安装规则，拒绝卸载（疑似台账被改动）",
                "installPath": recorded_path,
                "expected": expected,
            },
        }

    # P4: shape alone is NOT ownership. A record with an empty/missing
    # ``contentHash`` was never vouched for by an install of this module — a
    # tampered ledger could otherwise point a legal-looking landing at ANY
    # unrelated directory under ``skills`` (e.g. a bundled engine skill) and
    # have it deleted. Require the record to carry the hash our install writes.
    if not str(record.get("contentHash") or "").strip():
        return {
            "ok": False,
            "kind": "unsafe-path",
            "detail": {
                "reason": "台账记录缺少内容哈希，无法证明这条落点是本模块取用的，拒绝卸载（疑似台账被改动）",
                "installPath": recorded_path,
                "recordedHash": None,
            },
        }

    # F1/F7: resolve with the per-component symlink rejection (never follow a
    # symlinked landing out of the store, and never into a personal tree).
    try:
        target = assert_safe_landing(skills_path, recorded_path)
    except ValueError as exc:
        return {"ok": False, "kind": "unsafe-path", "detail": {"reason": str(exc), "installPath": recorded_path}}

    # F2: never rmtree a directory that still holds another record's landing.
    nested = _nested_landings(skills_path, recorded_path, ledger_records, ref_of)
    if nested:
        return {
            "ok": False,
            "kind": "unsafe-path",
            "detail": {
                "reason": "落点内部仍含其它台账记录的技能目录，拒绝删除以免连坐",
                "installPath": recorded_path,
                "contains": nested,
            },
        }

    # N2: a landing occupied by a NON-directory is not something we can remove
    # as a skill directory. Report it truthfully — never "ok / removed:false"
    # while ALSO stamping the ledger as uninstalled (a false green).
    if target.exists() and not target.is_dir():
        return {
            "ok": False,
            "kind": "remove-failed",
            "detail": {
                "reason": "落点被非目录占用（不是技能目录），未删除、台账未改动",
                "installPath": recorded_path,
                "target": str(target),
            },
        }

    exists = target.is_dir()
    current = engine_content_hash(target) if exists else None
    changed = exists and _hash_state(record.get("contentHash"), current) == "mismatch"
    # Human confirmation is REQUIRED for every uninstall (it removes files); a
    # local modification additionally needs the same confirm (never a silent
    # delete of someone's edits).
    if not data.confirm:
        return {
            "ok": False,
            "kind": "needs-confirm",
            "detail": {
                "reason": "落点内容与取用时的记录不一致（本地被改动过）" if changed else "卸载会删除落点目录",
                "installPath": str(record.get("installPath") or ""),
                "contentChanged": changed,
            },
        }

    removed = False
    if exists:
        try:
            shutil.rmtree(target)
            removed = True
        except Exception as exc:
            return {"ok": False, "kind": "remove-failed", "detail": {"message": str(exc), "target": str(target)}}

    next_record = {**record, "uninstalledAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    records = [
        next_record if (ref_of(r) == ref and str(r.get("installPath") or "") == str(record.get("installPath") or "")) else r
        for r in ledger_records
    ]
    try:
        write_ledger(home, records)
    except Exception as exc:
        return {"ok": False, "kind": "write-failed", "detail": {"message": f"落点已删但台账写不进去：{exc}"}}

    return {"ok": True, "removed": removed, "record": next_record, "target": str(target)}


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

    # N3: ``ESSENTIAL_SKILLS`` is only used to LABEL a failure. It lives in a
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
            scope = contextlib.nullcontext()
        with scope:
            config = load_config()
            disabled = get_disabled_skills(config)
            if enabled:
                disabled.discard(skill_name)
            else:
                disabled.add(skill_name)
            save_disabled_skills(config, disabled)
            # F5: re-read the PERSISTED state. The engine silently drops
            # essential skills (``ESSENTIAL_SKILLS``) from this key, so a
            # "disable hermes-agent" write is a no-op — reporting ok would be a
            # false green. Report the state that actually landed on disk.
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


@router.post("/skills/install")
def install_skill(data: InstallRequest) -> dict:
    """Install (or refresh) one skill into ``<HERMES_HOME>/skills``.

    Installing writes files, so the backend REQUIRES ``confirm:true`` (N4) —
    the UI always sends it after its confirmation dialog, and a direct call
    without it is refused rather than silently writing.
    """
    return _install_skill(data, require_confirm=True)


@router.post("/skills/update")
def update_skill(data: InstallRequest) -> dict:
    """Update = re-install from the catalog (same landing rules).

    An update overwrites an occupied slot by definition, so it REQUIRES
    ``confirm:true`` (F4) — matching what the docs claim, not just the UI.
    """
    return _install_skill(data, require_confirm=True)


@router.post("/skills/uninstall")
def uninstall_skill(data: UninstallRequest) -> dict:
    """Remove a skill's landing directory; the ledger record is kept."""
    return _uninstall_skill(data)


@router.post("/skills/enable")
def enable_skill(data: ToggleRequest) -> dict:
    """Re-enable a skill through the engine's own enable state."""
    if not data.confirm:
        return {"ok": False, "kind": "needs-confirm", "detail": {"reason": "启用会写引擎配置，必须带 confirm:true", "name": data.name}}
    return _set_skill_enabled(data.name, True)


@router.post("/skills/disable")
def disable_skill(data: ToggleRequest) -> dict:
    """Disable a skill through the engine's own enable state."""
    if not data.confirm:
        return {"ok": False, "kind": "needs-confirm", "detail": {"reason": "停用会写引擎配置，必须带 confirm:true", "name": data.name}}
    return _set_skill_enabled(data.name, False)
